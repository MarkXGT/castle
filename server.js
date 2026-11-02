'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, DT } = require('./game');
const DATA = require('./data.json');

const PORT = process.env.PORT || 3000;
const SIMSPEED = +process.env.SIMSPEED || 1; // для тестов: ускорение симуляции
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  let file;
  if (url === '/data.json') file = path.join(__dirname, 'data.json');
  else {
    if (url === '/') url = '/index.html';
    file = path.join(PUB, path.normalize(url));
    if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
const rooms = new Map();

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const toAll = (room, o) => room.players.forEach(p => p && !p.bot && send(p.ws, o));
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 16);
const token = () => crypto.randomBytes(8).toString('hex');

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}

function newPlayer(ws, name, faction) {
  return { ws, token: token(), name: clean(name) || 'Игрок', faction: DATA.factions[faction] ? faction : 'human', ready: false, rematch: false, bot: false, discAt: 0 };
}

function lobbyMsg(room) {
  return {
    t: 'lobby', code: room.code, state: room.state,
    players: room.players.map(p => p && { name: p.name, faction: p.faction, ready: p.ready, online: p.bot || !!p.ws, bot: p.bot })
  };
}
const pushLobby = room => toAll(room, lobbyMsg(room));

function destroyRoom(room) {
  clearInterval(room.loop);
  rooms.delete(room.code);
}

function startGame(room) {
  clearInterval(room.loop);
  room.state = 'playing';
  room.endMsg = null;
  room.players.forEach(p => { p.rematch = false; p.discAt = 0; });
  room.game = new Game({ factions: room.players.map(p => p.faction), bots: room.players.map(p => p.bot) });
  toAll(room, startMsg(room));
  room.loop = setInterval(() => tickRoom(room), DT * 1000);
}

const startMsg = room => ({ t: 'start', factions: room.players.map(p => p.faction), names: room.players.map(p => p.name) });

function tickRoom(room) {
  const g = room.game;
  const gone = room.players.filter(p => !p.bot && !p.ws);
  g.pause = null;
  if (gone.length) {
    const now = Date.now();
    for (const p of gone) if (!p.discAt) p.discAt = now;
    const left = Math.ceil(DATA.settings.disconnectGrace - (now - Math.min(...gone.map(p => p.discAt))) / 1000);
    if (left <= 0) {
      if (gone.length === 2) return destroyRoom(room);
      g.forfeit(room.players.indexOf(gone[0]));
    } else g.pause = { left };
  } else {
    for (let i = 0; i < SIMSPEED && !g.over; i++) g.step();
  }
  for (const m of g.msgs) send(room.players[m.side].ws, { t: 'err', msg: m.msg });
  g.msgs = [];
  if (g.over) {
    clearInterval(room.loop);
    room.state = 'ended';
    room.endMsg = { t: 'end', ...g.result };
    toAll(room, { t: 's', ...g.snapshot() });
    toAll(room, room.endMsg);
    if (room.players.every(p => p.bot || !p.ws)) destroyRoom(room);
    return;
  }
  toAll(room, { t: 's', ...g.snapshot() });
}

function joinedMsg(room, side) {
  return { t: 'joined', code: room.code, side, token: room.players[side].token };
}

function handle(ws, m) {
  const ctx = ws.ctx;
  const room = ctx && rooms.get(ctx.code);

  switch (m.t) {
    case 'ping': return send(ws, { t: 'pong' });

    case 'create': {
      leave(ws);
      const code = genCode();
      const r = { code, players: [newPlayer(ws, m.name, m.faction), null], state: 'lobby', game: null, loop: null };
      rooms.set(code, r);
      ws.ctx = { code, side: 0 };
      send(ws, joinedMsg(r, 0));
      return pushLobby(r);
    }

    case 'bot': {
      leave(ws);
      const code = genCode();
      const me = newPlayer(ws, m.name, m.faction);
      const bot = newPlayer(null, 'Бот', me.faction === 'human' ? 'orc' : 'human');
      bot.bot = true; bot.ready = true;
      const r = { code, players: [me, bot], state: 'lobby', game: null, loop: null };
      rooms.set(code, r);
      ws.ctx = { code, side: 0 };
      send(ws, joinedMsg(r, 0));
      return startGame(r);
    }

    case 'join': {
      const code = clean(m.code).toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: 'Комната не найдена', fatal: true });
      // переподключение по токену
      const idx = r.players.findIndex(p => p && !p.bot && m.token && p.token === m.token);
      if (idx >= 0) {
        const p = r.players[idx];
        if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch {} }
        p.ws = ws; p.discAt = 0;
        ws.ctx = { code, side: idx };
        send(ws, joinedMsg(r, idx));
        if (r.state === 'playing') send(ws, startMsg(r));
        else if (r.state === 'ended') { send(ws, startMsg(r)); send(ws, r.endMsg); }
        return pushLobby(r);
      }
      if (r.players[1] || r.state !== 'lobby') return send(ws, { t: 'err', msg: 'Комната занята', fatal: true });
      leave(ws);
      r.players[1] = newPlayer(ws, m.name, m.faction);
      ws.ctx = { code, side: 1 };
      send(ws, joinedMsg(r, 1));
      return pushLobby(r);
    }

    case 'faction': {
      if (!room || room.state !== 'lobby' || !DATA.factions[m.faction]) return;
      const p = room.players[ctx.side];
      p.faction = m.faction; room.players.forEach(x => x && !x.bot && (x.ready = false));
      return pushLobby(room);
    }

    case 'ready': {
      if (!room || room.state !== 'lobby') return;
      room.players[ctx.side].ready = !!m.ready;
      pushLobby(room);
      if (room.players[0] && room.players[1] && room.players.every(p => p.ready)) startGame(room);
      return;
    }

    case 'cmd': {
      if (!room || room.state !== 'playing' || !room.game) return;
      const now = Date.now();
      if (now - (ws.rateT || 0) > 1000) { ws.rateT = now; ws.rateN = 0; }
      if (++ws.rateN > 30) return;
      const err = room.game.cmd(ctx.side, m.c);
      if (err) send(ws, { t: 'err', msg: err });
      return;
    }

    case 'rematch': {
      if (!room || room.state !== 'ended') return;
      room.players[ctx.side].rematch = true;
      if (room.players.every(p => p.bot || p.rematch)) return startGame(room);
      return toAll(room, { t: 'rematchWait', side: ctx.side });
    }

    case 'leave': return leave(ws);
  }
}

function leave(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  ws.ctx = null;
  const room = rooms.get(ctx.code);
  if (!room) return;
  const p = room.players[ctx.side];
  if (!p || p.ws !== ws) return;
  if (room.state === 'lobby') {
    room.players[ctx.side] = null;
    if (ctx.side === 0) { // хост ушёл — второй игрок становится хостом
      room.players = [room.players[1], null];
      if (room.players[0] && room.players[0].ws) room.players[0].ws.ctx.side = 0;
    }
    if (!room.players[0]) return destroyRoom(room);
    room.players[0].ready = false;
    send(room.players[0].ws, joinedMsg(room, 0));
    return pushLobby(room);
  }
  // матч идёт или закончен
  p.ws = null; p.discAt = Date.now();
  if (room.state === 'ended') {
    toAll(room, { t: 'opponentLeft' });
    if (room.players.every(x => x.bot || !x.ws)) destroyRoom(room);
  }
}

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => {
    const ctx = ws.ctx;
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (room && room.state === 'playing') {
      const p = room.players[ctx.side];
      if (p && p.ws === ws) { p.ws = null; p.discAt = Date.now(); }
      ws.ctx = null;
    } else leave(ws);
  });
});

// keep-alive для прокси Render
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    ws.ping();
  });
}, 25000);

server.listen(PORT, () => console.log('Castle Fight server on :' + PORT));
