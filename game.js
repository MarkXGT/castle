'use strict';
// Авторитарная симуляция матча. Все числа берутся из data.json.
const DATA = require('./data.json');
const S = DATA.settings;
const L = S.layout;
const DT = 0.1;

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));

// Клетки базы: 7 колонок × 8 рядов (4 выше дороги, 4 ниже). Дорога посередине свободна.
function slotPos(side, i) {
  const col = i % L.baseCols;
  const row = Math.floor(i / L.baseCols);
  const off = L.baseX0 + col * L.cell + L.cell / 2;
  const roadTop = L.laneY - L.laneHalf, roadBot = L.laneY + L.laneHalf;
  const y = row < L.rowsPerSide
    ? roadTop - (L.rowsPerSide - row) * L.cell + L.cell / 2
    : roadBot + (row - L.rowsPerSide) * L.cell + L.cell / 2;
  return { x: side === 0 ? off : S.world - off, y };
}
const BASE_MAX_X = L.baseX0 + L.baseCols * L.cell + 40;

class Game {
  constructor({ factions, bots }) {
    this.t = 0;
    this.nextId = 1;
    this.over = false;
    this.result = null;
    this.units = [];
    this.buildings = [];
    this.events = [];
    this.pause = null;
    this.msgs = [];
    this.reach = {};
    for (const k in DATA.units) {
      const u = DATA.units[k];
      u.interval = ((u.damage[0] + u.damage[1]) / 2) / u.dps; // интервал выводится из DPS
      this.reach[k] = Math.max(u.range * S.rangeScale, S.minReach);
    }
    for (const k in DATA.buildings) {
      const t = DATA.buildings[k].tower;
      if (t) { t.interval = ((t.damage[0] + t.damage[1]) / 2) / t.dps; t.reach = Math.max(t.range * S.rangeScale, S.minReach); }
    }
    this.players = [0, 1].map(i => ({
      side: i, faction: factions[i], bot: !!bots[i],
      gold: S.startGold, crystals: S.startCrystals, crystalT: 0, incomeT: 0,
      ult: 0, ultCd: 0, botT: 3 + i,
      shards: 0,
      stats: { kills: 0, lost: 0, bKills: 0, built: 0, gold: 0, heroKills: 0, camps: 0, ko: 0 }
    }));
    for (const p of this.players) {
      const hd = DATA.heroes[p.faction];
      hd.interval = ((hd.damage[0] + hd.damage[1]) / 2) / hd.dps;
      p.hero = { id: 'h' + p.side, isHero: true, o: p.side, x: 0, y: 0, hp: hd.hp, mh: hd.hp, lv: 1, xp: 0, dead: false, rt: 0, cd: 0, skCd: 0,
        stunU: 0, lastDmgT: -99, lastHit: -1, dx: 0, dy: 0, tgt: null, go: null, drumU: 0, aim: 0, atkUntil: 0, combo: 0, comboT: -99, mg: 0, kos: 0 };
      this.placeHero(p);
    }
    this.neutrals = [];
    this.camps = DATA.camps.map(c => ({ ...c, def: DATA.campTypes[c.type], respawnT: 0, aggro: null, alive: 0 }));
    for (const c of this.camps) this.spawnCamp(c);
    this.castles = [0, 1].map(i => ({
      id: 'c' + i, o: i, hp: S.castleHp, max: S.castleHp,
      x: i === 0 ? L.castleX : S.world - L.castleX
    }));
  }

  // ---------- утилиты ----------
  dir(o) { return o === 0 ? 1 : -1; }
  armyCount(o) { let n = 0; for (const u of this.units) if (u.o === o && u.hp > 0) n++; return n; }
  incomeOf(o) {
    let n = 0;
    for (const b of this.buildings) if (b.o === o && b.income) n++;
    return S.passiveIncome + n * S.buildingIncome;
  }
  unitY(u) { return u.y; }
  bldCenterY(b) { return b.y; }
  ev(o) { this.events.push(o); }
  pay(p, cost) {
    if (cost.g) p.gold -= cost.g;
    if (cost.c) p.crystals -= cost.c;
  }
  canPay(p, cost) {
    return p.gold >= (cost.g || 0) && p.crystals >= (cost.c || 0);
  }

  spawnUnit(o, type, x, y) {
    const d = DATA.units[type];
    this.units.push({
      id: this.nextId++, o, type, x, y: y === undefined ? L.laneY : y,
      ly: L.laneY + rand(-1, 1) * L.laneSpread, hp: d.hp, cd: rand(0, 1),
      lodgeU: 0, bloodU: 0, drumU: 0, lustU: 0, pillT: 0, lastHit: -1,
      sk: d.skill ? d.skill.cooldown / 2 : 0
    });
  }

  // ---------- команды игроков ----------
  cmd(side, c) {
    if (this.over) return 'Матч окончен';
    const p = this.players[side];
    if (!c || typeof c.c !== 'string') return 'Неверная команда';
    switch (c.c) {
      case 'hmove': return this.cmdHeroMove(p, c);
      case 'hgo': return this.cmdHeroGo(p, c);
      case 'hatk': return this.cmdHeroAttack(p, c);
      case 'hskill': return this.cmdHeroSkill(p);
      case 'repair': return this.cmdRepair(p, c);
      case 'build': return this.cmdBuild(p, c);
      case 'upgrade': return this.cmdUpgrade(p, c);
      case 'sell': return this.cmdSell(p, c);
      case 'ability': return this.cmdAbility(p, c);
      case 'item': return this.cmdItem(p, c);
      case 'ult': return this.cmdUlt(p);
    }
    return 'Неизвестная команда';
  }

  validateBuild(p, c) {
    const def = DATA.buildings[c.b];
    if (!def || def.faction !== p.faction || def.upgradeOnly) return 'Нельзя построить';
    const slot = c.slot | 0;
    if (slot < 0 || slot >= S.slots) return 'Неверная клетка';
    if (this.buildings.some(b => b.o === p.side && b.slot === slot)) return 'Клетка занята';
    if (def.requires && !this.buildings.some(b => b.o === p.side && b.type === def.requires)) {
      return 'Нужен ' + DATA.buildings[def.requires].name;
    }
    if (!this.canPay(p, def.cost)) return 'Не хватает ресурсов';
    return null;
  }

  cmdBuild(p, c) {
    const err = this.validateBuild(p, c);
    if (err) return err;
    this.placeBuilding(p, c.b, c.slot | 0);
    return null;
  }

  // Ремонт идёт постепенно, пока хватает золота: repairCostPerHp за HP
  cmdRepair(p, c) {
    const bd = this.myBuilding(p, c.id);
    if (!bd) return 'Нет такого здания';
    if (bd.hp >= bd.max) return 'Здание целое';
    bd.repair = true;
    return null;
  }

  placeBuilding(p, type, slot) {
    const def = DATA.buildings[type];
    this.pay(p, def.cost);
    this.addBuilding(p.side, type, slot, def.cost.g || 0);
    p.stats.built++;
  }

  addBuilding(o, type, slot, invested) {
    const def = DATA.buildings[type];
    const sp = slotPos(o, slot);
    this.buildings.push({
      id: this.nextId++, o, type, slot,
      x: sp.x, y: sp.y, hp: def.hp, max: def.hp, cd: 0,
      spawnT: def.interval || 0, invested, income: def.kind === 'spawner', lastHit: -1
    });
  }

  myBuilding(p, id) { return this.buildings.find(b => b.id === id && b.o === p.side); }

  cmdUpgrade(p, c) {
    const b = this.myBuilding(p, c.id);
    if (!b) return 'Нет такого здания';
    const def = DATA.buildings[b.type];
    if (!def.upgradeTo) return 'Нельзя улучшить';
    const nd = DATA.buildings[def.upgradeTo];
    if (!this.canPay(p, nd.cost)) return 'Не хватает ресурсов';
    this.pay(p, nd.cost);
    const ratio = b.hp / b.max;
    b.type = def.upgradeTo;
    b.max = nd.hp; b.hp = nd.hp * ratio;
    b.invested += nd.cost.g || 0;
    b.spawnT = Math.min(b.spawnT, nd.interval); // очередь производства не сбрасывается
    return null;
  }

  cmdSell(p, c) {
    const b = this.myBuilding(p, c.id);
    if (!b) return 'Нет такого здания';
    p.gold += Math.floor(b.invested * S.sellRefund);
    this.buildings.splice(this.buildings.indexOf(b), 1);
    return null;
  }

  inArea(o, x, fn) {
    for (const u of this.units) {
      if (u.o === o && u.hp > 0 && Math.abs(u.x - x) <= S.areaRadius) fn(u);
    }
    const h = this.players[o].hero;
    if (!h.dead && Math.abs(h.x - x) <= S.areaRadius) fn(h);
  }

  cmdAbility(p, c) {
    const b = this.myBuilding(p, c.id);
    if (!b) return 'Нет такого здания';
    const ab = DATA.buildings[b.type].ability;
    if (!ab) return 'Нет способности';
    if (b.cd > 0) return 'Перезарядка';
    if (!this.canPay(p, ab.cost)) return 'Не хватает ресурсов';
    if (ab.type === 'heal') {
      const x = Math.max(0, Math.min(S.world, +c.x));
      if (!isFinite(x)) return 'Неверная область';
      this.pay(p, ab.cost);
      this.inArea(p.side, x, u => { u.hp = Math.min(this.maxHpOf(u), u.hp + ab.amount); this.ev({ k: 'h', x: u.x, y: this.unitY(u) }); });
      this.ev({ k: 'ring', x, o: p.side, c: '#4ade80' });
    } else if (ab.type === 'haste') {
      this.pay(p, ab.cost);
      for (const u of this.units) if (u.o === p.side) u.lodgeU = this.t + ab.duration;
    }
    b.cd = ab.cooldown;
    return null;
  }

  cmdItem(p, c) {
    const it = DATA.items[c.item];
    if (!it) return 'Нет такого предмета';
    if (!this.canPay(p, it.cost)) return 'Не хватает ресурсов';
    if (c.item === 'salve') {
      const u = c.target === 'h' + p.side ? (p.hero.dead ? null : p.hero) : this.units.find(u => u.id === c.target && u.o === p.side && u.hp > 0);
      if (!u) return 'Выберите своего юнита или героя';
      this.pay(p, it.cost);
      u.hp = Math.min(this.maxHpOf(u), u.hp + it.amount);
      this.ev({ k: 'h', x: u.x, y: this.unitY(u) });
    } else if (c.item === 'drum') {
      const x = Math.max(0, Math.min(S.world, +c.x));
      if (!isFinite(x)) return 'Неверная область';
      this.pay(p, it.cost);
      this.inArea(p.side, x, u => { u.drumU = this.t + it.duration; });
      this.ev({ k: 'ring', x, o: p.side, c: '#facc15' });
    }
    return null;
  }

  cmdUlt(p) {
    const u = DATA.ults[p.faction];
    if (p.ult < S.ultMax) return 'Ультимейт не заряжен';
    if (p.ultCd > 0) return 'Перезарядка ультимейта';
    if (!this.canPay(p, u.cost)) return 'Не хватает ресурсов';
    this.pay(p, u.cost);
    p.ult = 0; p.ultCd = S.ultCooldown;
    if (p.faction === 'human') {
      const cx = this.castles[p.side].x + this.dir(p.side) * 70;
      for (let i = 0; i < 3; i++) this.spawnUnit(p.side, 'royalguard', cx + this.dir(p.side) * i * 14, L.laneY + (i - 1) * 24);
    } else {
      for (const un of this.units) if (un.o === p.side) un.bloodU = this.t + u.duration;
    }
    this.ev({ k: 'ult', o: p.side });
    return null;
  }

  // ---------- шаг симуляции ----------
  step() {
    if (this.over) return;
    this.t += DT;

    for (const p of this.players) {
      p.incomeT += DT;
      if (p.incomeT >= S.incomeInterval) {
        p.incomeT -= S.incomeInterval;
        const inc = this.incomeOf(p.side);
        p.gold += inc; p.stats.gold += inc;
      }
      if (p.crystals < S.maxCrystals) {
        p.crystalT += DT;
        if (p.crystalT >= S.crystalRegen) { p.crystals++; p.crystalT = 0; }
      } else p.crystalT = 0;
      p.ultCd = Math.max(0, p.ultCd - DT);
      if (p.bot) { this.botThink(p); this.botHero(p); }
      this.stepHero(p);
    }

    const count = [this.armyCount(0), this.armyCount(1)];
    for (const b of this.buildings) {
      b.cd = Math.max(0, b.cd - DT);
      if (b.repair) {
        const own = this.players[b.o];
        const amt = Math.min(S.repairRate * DT, b.max - b.hp), cost = amt * S.repairCostPerHp;
        if (own.gold < cost) { b.repair = false; this.msgs.push({ side: b.o, msg: 'Не хватает золота на ремонт' }); }
        else { own.gold -= cost; b.hp += amt; if (b.hp >= b.max - 0.01) { b.hp = b.max; b.repair = false; } }
      }
      const def = DATA.buildings[b.type];
      if (def.kind !== 'spawner') continue;
      b.spawnT = Math.max(0, b.spawnT - DT);
      if (b.spawnT <= 0 && count[b.o] < S.unitLimit) {
        const n = Math.min(S.waveSize, S.unitLimit - count[b.o]);
        for (let i = 0; i < n; i++) this.spawnUnit(b.o, def.unit, b.x + this.dir(b.o) * (28 + i * 10), b.y + (i - 1) * 8);
        count[b.o] += n;
        b.spawnT = def.interval;
      }
    }

    for (const b of this.buildings) if (DATA.buildings[b.type].kind === 'tower') this.actTower(b);
    for (const u of this.units) if (u.hp > 0) this.actUnit(u);
    this.stepCamps();
    this.reap();
    if (this.over) return;

    if (this.t >= S.matchSeconds) {
      const a = this.castles[0].hp, b = this.castles[1].hp;
      this.finish(a === b ? -1 : (a > b ? 0 : 1), 'Время вышло: побеждает замок с большим здоровьем');
    }
  }

  // ---------- герои и нейтралы ----------
  armorOf(e) {
    if (e.isHero) return DATA.heroes[this.players[e.o].faction];
    if (e.neutral) return DATA.neutrals[e.type];
    return DATA.units[e.type];
  }
  maxHpOf(e) { return e.isHero ? e.mh : e.neutral ? DATA.neutrals[e.type].hp : DATA.units[e.type].hp; }
  hurt(e, dmg, side, byHero) {
    e.hp -= dmg; e.lastHit = side; e.byHero = !!byHero;
    if (e.isHero) e.lastDmgT = this.t;
  }
  hostile(side, e) {
    if (!e || e.hp <= 0) return false;
    if (e.isHero) return !e.dead && e.o !== side;
    if (e.neutral) return true;
    return e.o !== side;
  }
  findEnt(id) {
    if (typeof id === 'string') { const m = /^h([01])$/.exec(id); return m ? this.players[+m[1]].hero : null; }
    return this.units.find(u => u.id === id) || this.neutrals.find(n => n.id === id) || null;
  }
  nearestHostile(side, from, reach) {
    let best = null, bd = reach;
    const test = e => { if (!this.hostile(side, e)) return; const d = Math.hypot(e.x - from.x, e.y - from.y); if (d <= bd) { bd = d; best = e; } };
    for (const n of this.neutrals) test(n);
    test(this.players[1 - side].hero);
    for (const u of this.units) test(u);
    return best;
  }
  placeHero(p) {
    const h = p.hero;
    h.x = (p.side === 0 ? L.castleX : S.world - L.castleX) + this.dir(p.side) * 90; h.y = L.laneY + (p.side === 0 ? 40 : -40);
  }
  addXp(p, xp) {
    const h = p.hero;
    h.xp += xp;
    const lv = Math.min(S.maxLevel, 1 + Math.floor(h.xp / S.xpPerLevel));
    while (h.lv < lv) { h.lv++; h.mh += S.hpPerLevel; if (!h.dead) h.hp += S.hpPerLevel; this.ev({ k: 'lvl', x: h.x, y: h.y }); }
  }
  heroDamage(h) {
    const d = DATA.heroes[this.players[h.o].faction], bonus = (h.lv - 1) * S.dmgPerLevel;
    return randInt(d.damage[0] + bonus, d.damage[1] + bonus);
  }

  cmdHeroMove(p, c) {
    let dx = +c.dx || 0, dy = +c.dy || 0;
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }
    p.hero.dx = dx; p.hero.dy = dy;
    if (len > 0) { p.hero.tgt = null; p.hero.go = null; }
    return null;
  }
  cmdHeroGo(p, c) {
    const x = +c.x, y = +c.y;
    if (!isFinite(x) || !isFinite(y)) return 'Неверная точка';
    p.hero.go = { x, y }; p.hero.tgt = null;
    return null;
  }
  // Удержание ЛКМ/Пробела: клиент шлёт точку прицела ~10 раз в секунду
  cmdHeroAttack(p, c) {
    const ax = +c.ax, ay = +c.ay, h = p.hero;
    if (!isFinite(ax) || !isFinite(ay)) return 'Неверная цель';
    if (h.dead) return null;
    h.aim = Math.atan2(ay - h.y, ax - h.x); h.atkUntil = this.t + 0.3;
    return null;
  }

  // Musou: полная шкала -> взрыв вокруг героя
  cmdHeroSkill(p) {
    const h = p.hero, sk = DATA.heroes[p.faction].skill;
    if (h.dead) return 'Герой мёртв';
    if (this.t < h.stunU) return 'Герой оглушён';
    if (h.mg < S.gaugeMax) return 'Шкала Musou не заполнена';
    h.mg = 0;
    const dmg = sk.damage + (h.lv - 1) * sk.perLevel;
    for (const e of [...this.units, ...this.neutrals, this.players[1 - p.side].hero]) {
      if (!this.hostile(p.side, e)) continue;
      const dx = e.x - h.x, dy = e.y - h.y, dist = Math.hypot(dx, dy);
      if (dist > sk.radius) continue;
      const a = this.armorOf(e);
      let d = dmg * DATA.damageTable.Normal[a.armorType] * 100 / (100 + 6 * a.armor);
      if (e.isHero) d *= S.swing.heroMult;
      this.hurt(e, d, p.side, true);
      if (e.isHero || e.neutral) e.stunU = this.t + sk.stun;
      if (!e.isHero && dist > 0) { e.x += dx / dist * sk.kb; if (!e.neutral) e.y += dy / dist * sk.kb * 0.3; }
    }
    for (const u of this.units) {
      if (u.o !== p.side || u.hp <= 0 || Math.hypot(u.x - h.x, u.y - h.y) > sk.radius) continue;
      if (sk.ally === 'heal') u.hp = Math.min(this.maxHpOf(u), u.hp + sk.heal);
      else u.bloodU = this.t + sk.hasteDur;
    }
    this.ev({ k: 'burst', x: h.x, y: h.y, o: p.side, r: sk.radius });
    return null;
  }

  // Взмах: бьёт всех врагов в дуге (каждый 4-й удар — финишер по кругу с отбрасыванием)
  swing(p) {
    const h = p.hero, d = DATA.heroes[p.faction], W_ = S.swing;
    h.cd = W_.interval;
    h.combo = this.t - h.comboT <= W_.comboWindow ? (h.combo % 4) + 1 : 1;
    h.comboT = this.t;
    const fin = h.combo === 4, R = fin ? W_.finRadius : W_.radius, kb = fin ? W_.finKb : W_.kb;
    const ax = Math.cos(h.aim), ay = Math.sin(h.aim);
    let hits = 0;
    for (const e of [...this.units, ...this.neutrals, this.players[1 - p.side].hero]) {
      if (!this.hostile(p.side, e)) continue;
      const dx = e.x - h.x, dy = e.y - h.y, dist = Math.hypot(dx, dy);
      if (dist > R) continue;
      if (!fin && dist > 22 && (dx * ax + dy * ay) / dist < 0) continue; // передняя полусфера
      const a = this.armorOf(e);
      let dmg = this.heroDamage(h) * (fin ? W_.finMult : 1) * DATA.damageTable.Normal[a.armorType] * 100 / (100 + 6 * a.armor);
      if (this.t < h.drumU) dmg *= 1 + DATA.items.drum.bonus;
      if (e.isHero) dmg *= W_.heroMult;
      this.hurt(e, dmg, p.side, true);
      hits++;
      if (!e.isHero && dist > 0) { e.x += dx / dist * kb; if (!e.neutral) e.y += dy / dist * kb * 0.3; }
    }
    if (hits) h.mg = Math.min(S.gaugeMax, h.mg + hits * W_.gaugePerHit);
    this.ev({ k: 'slash', x: h.x, y: h.y, ang: h.aim, fin: fin ? 1 : 0, cb: h.combo, o: p.side, r: R });
  }

  stepHero(p) {
    const h = p.hero, d = DATA.heroes[p.faction];
    if (h.dead) { h.rt -= DT; if (h.rt <= 0) { h.dead = false; h.hp = h.mh; h.stunU = 0; this.placeHero(p); } return; }
    h.cd -= DT;
    if (this.t - h.lastDmgT >= S.heroRegenDelay) h.hp = Math.min(h.mh, h.hp + S.heroRegen * DT);
    if (this.t < h.stunU) return;
    const speed = d.speed * S.heroSpeedScale * DT;
    const clampPos = () => { h.x = Math.max(20, Math.min(S.world - 20, h.x)); h.y = Math.max(20, Math.min(L.worldH - 20, h.y)); };
    if (h.dx || h.dy) { h.x += h.dx * speed; h.y += h.dy * speed; clampPos(); if (this.t >= h.atkUntil) h.aim = Math.atan2(h.dy, h.dx); }
    else if (h.go) {
      const dx = h.go.x - h.x, dy = h.go.y - h.y, dist = Math.hypot(dx, dy);
      if (dist <= 4) h.go = null; else { const st = Math.min(speed, dist); h.x += dx / dist * st; h.y += dy / dist * st; clampPos(); }
    }
    if (this.t < h.atkUntil && h.cd <= 0) this.swing(p);
  }

  spawnCamp(c) {
    const def = c.def, nd = DATA.neutrals[def.unit];
    for (let i = 0; i < def.count; i++) {
      const ox = def.count > 1 ? (i - (def.count - 1) / 2) * 34 : 0, oy = def.count > 1 ? (i % 2 ? 18 : -10) : 0;
      this.neutrals.push({ id: this.nextId++, neutral: true, camp: c.id, type: def.unit, x: c.x + ox, y: c.y + oy, hx: c.x + ox, hy: c.y + oy, hp: nd.hp, cd: rand(0, 1), stunU: 0, lastHit: -1 });
    }
    c.alive = def.count; c.respawnT = 0;
  }

  stepCamps() {
    for (const c of this.camps) {
      if (c.alive === 0) { c.respawnT -= DT; if (c.respawnT <= 0) this.spawnCamp(c); continue; }
      // агрессия на героя: радиус 250, сброс за 300
      let tgt = null, bd = Infinity;
      for (const p of this.players) {
        const h = p.hero;
        if (h.dead) continue;
        const d = Math.hypot(h.x - c.x, h.y - c.y);
        const lim = c.aggro === h.o ? S.neutralLeash : S.neutralAggro;
        if (d <= lim && d < bd) { bd = d; tgt = h; }
      }
      c.aggro = tgt ? tgt.o : null;
      for (const n of this.neutrals) {
        if (n.camp !== c.id) continue;
        const nd = DATA.neutrals[n.type];
        n.cd -= DT;
        if (this.t < n.stunU) continue;
        const speed = nd.speed * S.heroSpeedScale * DT;
        const go = (tx, ty, stop) => { const dx = tx - n.x, dy = ty - n.y, dist = Math.hypot(dx, dy); if (dist <= stop) return; const st = Math.min(speed, dist - stop); n.x += dx / dist * st; n.y += dy / dist * st; };
        if (tgt) {
          const dist = Math.hypot(tgt.x - n.x, tgt.y - n.y);
          if (dist > nd.reach) go(tgt.x, tgt.y, nd.reach - 6);
          else if (n.cd <= 0) {
            n.cd = nd.interval;
            const a = this.armorOf(tgt);
            this.hurt(tgt, randInt(nd.damage[0], nd.damage[1]) * DATA.damageTable.Normal[a.armorType] * 100 / (100 + 6 * a.armor), -1);
            this.ev({ k: 'a', x1: n.x, y1: n.y, x2: tgt.x, y2: tgt.y, r: 0, c: 0, o: -1 });
          }
        } else {
          go(n.hx, n.hy, 2);
          n.hp = Math.min(nd.hp, n.hp + nd.hp * 0.1 * DT);
        }
      }
    }
  }

  botHero(p) {
    const h = p.hero;
    if (h.dead) return;
    h.go = null; h.dx = h.dy = 0;
    const goTo = (x, y) => { const dx = x - h.x, dy = y - h.y, len = Math.hypot(dx, dy); if (len > 14) { h.dx = dx / len; h.dy = dy / len; } };
    const foe = this.nearestHostile(p.side, h, 110);
    const camp = this.camps[p.side];
    if (h.hp < h.mh * 0.35) goTo(this.castles[p.side].x + this.dir(p.side) * 100, L.laneY);
    else if (foe) { h.aim = Math.atan2(foe.y - h.y, foe.x - h.x); h.atkUntil = this.t + 0.3; goTo(foe.x - this.dir(p.side) * 20, foe.y); }
    else if (camp.alive > 0 && h.lv < 4) { const n = this.neutrals.find(n => n.camp === camp.id); if (n) goTo(n.x, n.y); }
    else {
      const mine = this.units.filter(u => u.o === p.side).sort((a, b) => this.dir(p.side) * (b.x - a.x))[0];
      goTo(mine ? mine.x + this.dir(p.side) * 70 : this.castles[p.side].x + this.dir(p.side) * 330, L.laneY);
    }
    if (h.mg >= S.gaugeMax && foe) this.cmdHeroSkill(p);
  }

  calcDamage(def, armorType, armor) {
    return randInt(def.damage[0], def.damage[1]) * DATA.damageTable[def.attackType][armorType] * 100 / (100 + 6 * armor);
  }

  actTower(b) {
    const t = DATA.buildings[b.type].tower;
    b.tcd = (b.tcd || 0) - DT;
    let tgt = null, best = Infinity;
    for (const e of this.units) {
      if (e.o === b.o || e.hp <= 0) continue;
      const d = Math.abs(e.x - b.x);
      if (d <= t.reach && d < best) { best = d; tgt = e; }
    }
    for (const pl of this.players) {
      const h = pl.hero;
      if (h.dead || h.o === b.o) continue;
      const d = Math.hypot(h.x - b.x, h.y - b.y);
      if (d <= t.reach && d < best) { best = d; tgt = h; }
    }
    if (!tgt || b.tcd > 0) return;
    b.tcd = t.interval;
    const td = this.armorOf(tgt);
    this.hurt(tgt, this.calcDamage(t, td.armorType, td.armor), b.o);
    this.ev({ k: 'a', x1: b.x, y1: b.y, x2: tgt.x, y2: tgt.y, r: 1, c: 0, o: b.o, tw: 1 });
  }

  // навыки магов: срабатывают, когда есть вражеский юнит в зоне атаки
  castSkill(u, def, tgt) {
    const sk = def.skill;
    u.sk = sk.cooldown;
    if (sk.type === 'nova') {
      for (const e of this.units) {
        if (e.o === u.o || e.hp <= 0 || Math.abs(e.x - tgt.x) > sk.radius) continue;
        const td = DATA.units[e.type];
        this.hurt(e, sk.damage * DATA.damageTable.Magic[td.armorType] * 100 / (100 + 6 * td.armor), u.o);
      }
      const eh = this.players[1 - u.o].hero;
      if (!eh.dead && Math.hypot(eh.x - tgt.x, eh.y - tgt.y) <= sk.radius) {
        const td = this.armorOf(eh);
        this.hurt(eh, sk.damage * DATA.damageTable.Magic[td.armorType] * 100 / (100 + 6 * td.armor), u.o);
      }
      this.ev({ k: 'nova', x: tgt.x, y: tgt.y, o: u.o });
    } else if (sk.type === 'lust') {
      for (const a of this.units) if (a.o === u.o && a.hp > 0 && Math.abs(a.x - u.x) <= sk.radius) a.lustU = this.t + sk.duration;
      this.ev({ k: 'lust', x: u.x, y: u.y, o: u.o });
    }
  }

  actUnit(u) {
    const def = DATA.units[u.type];
    const reach = this.reach[u.type];
    const aspd = 1 + (this.t < u.lodgeU ? DATA.buildings.spiritlodge.ability.bonus : 0) + (this.t < u.bloodU ? DATA.ults.orc.aspd : 0) + (this.t < u.lustU ? DATA.units.shaman.skill.aspd : 0);
    u.cd -= DT * aspd;

    // приоритет: юнит -> здание -> замок
    let tgt = null, kind = null, best = Infinity;
    for (const e of this.units) {
      if (e.o === u.o || e.hp <= 0) continue;
      const d = Math.abs(e.x - u.x);
      if (d <= reach && d < best) { best = d; tgt = e; kind = 'u'; }
    }
    const eh = this.players[1 - u.o].hero;
    if (!eh.dead) {
      const d = Math.hypot(eh.x - u.x, eh.y - u.y);
      if (d <= reach && d < best) { best = d; tgt = eh; kind = 'u'; }
    }
    if (!tgt) {
      for (const b of this.buildings) {
        if (b.o === u.o) continue;
        const d = Math.abs(b.x - u.x) - L.bldW / 2;
        if (d <= reach && d < best) { best = d; tgt = b; kind = 'b'; }
      }
    }
    if (!tgt) {
      const c = this.castles[1 - u.o];
      if (Math.abs(c.x - u.x) - L.castleW / 2 <= reach) { tgt = c; kind = 'c'; }
    }

    if (!tgt) {
      const mv = 1 + (this.t < u.bloodU ? DATA.ults.orc.move : 0);
      u.x += this.dir(u.o) * def.speed * S.speedScale * mv * DT;
      const dy = u.ly - u.y;
      u.y += Math.max(-L.unitDrift * DT, Math.min(L.unitDrift * DT, dy));
      return;
    }
    if (def.skill) { u.sk -= DT; if (u.sk <= 0 && kind === 'u') this.castSkill(u, def, tgt); }
    if (u.cd > 0) return;
    u.cd = def.interval;
    this.attack(u, def, tgt, kind);
  }

  attack(u, def, tgt, kind) {
    let armorType, armor;
    if (kind === 'u') { const td = this.armorOf(tgt); armorType = td.armorType; armor = td.armor; }
    else if (kind === 'b') { armorType = DATA.buildingArmor.armorType; armor = DATA.buildingArmor.armor; }
    else { armorType = DATA.castle.armorType; armor = DATA.castle.armor; }

    let dmg = randInt(def.damage[0], def.damage[1]) * DATA.damageTable[def.attackType][armorType] * 100 / (100 + 6 * armor);
    let crit = false;
    if (def.crit && Math.random() < def.crit.chance) { dmg *= 1 + def.crit.bonus; crit = true; }
    if (kind !== 'u' && def.buildingMult) dmg *= def.buildingMult;
    if (this.t < u.drumU) dmg *= 1 + DATA.items.drum.bonus;
    this.hurt(tgt, dmg, u.o);

    if (kind === 'b' && def.pillage && this.t >= u.pillT) {
      u.pillT = this.t + def.pillage.cooldown;
      const p = this.players[u.o];
      p.gold += def.pillage.gold; p.stats.gold += def.pillage.gold;
    }
    const ty = kind === 'u' ? this.unitY(tgt) : (kind === 'b' ? tgt.y : L.laneY);
    this.ev({ k: 'a', x1: u.x, y1: this.unitY(u), x2: tgt.x, y2: ty, r: def.range > 200 ? 1 : 0, c: crit ? 1 : 0, o: u.o });
  }

  reap() {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.hp > 0) continue;
      this.units.splice(i, 1);
      this.ev({ k: 'd', x: u.x, y: this.unitY(u) });
      this.players[u.o].stats.lost++;
      if (u.lastHit >= 0) {
        const k = this.players[u.lastHit];
        const g = DATA.units[u.type].bounty;
        k.gold += g; k.stats.gold += g; k.stats.kills++;
        k.ult = Math.min(S.ultMax, k.ult + S.ultPerKill);
        if (u.byHero) { k.hero.kos++; k.stats.ko++; k.hero.mg = Math.min(S.gaugeMax, k.hero.mg + S.swing.gaugePerKill); this.addXp(k, S.xpPerKo); }
        this.ev({ k: 't', x: u.x, y: this.unitY(u) - 18, s: '+' + g, o: u.lastHit });
      }
    }
    for (let i = this.buildings.length - 1; i >= 0; i--) {
      const b = this.buildings[i];
      if (b.hp > 0) continue;
      this.buildings.splice(i, 1);
      this.ev({ k: 'boom', x: b.x, y: this.bldCenterY(b) });
      if (b.lastHit >= 0) {
        const k = this.players[b.lastHit];
        const g = Math.floor(b.invested * S.buildingBounty);
        k.gold += g; k.stats.gold += g; k.stats.bKills++;
        this.ev({ k: 't', x: b.x, y: this.bldCenterY(b) - 30, s: '+' + g, o: b.lastHit });
      }
    }
    for (let i = this.neutrals.length - 1; i >= 0; i--) {
      const n = this.neutrals[i];
      if (n.hp > 0) continue;
      this.neutrals.splice(i, 1);
      this.ev({ k: 'd', x: n.x, y: n.y });
      const c = this.camps[n.camp];
      if (--c.alive > 0) continue;
      c.respawnT = c.def.respawn; c.aggro = null;
      if (n.lastHit >= 0) {
        const k = this.players[n.lastHit];
        k.gold += c.def.gold; k.stats.gold += c.def.gold; k.stats.camps++;
        this.addXp(k, c.def.xp);
        if (c.def.shards) {
          k.shards += c.def.shards;
          while (k.shards >= S.shardsPerCrystal) { k.shards -= S.shardsPerCrystal; if (k.crystals < S.maxCrystals) k.crystals++; else k.shards = 0; }
        }
        this.ev({ k: 't', x: n.x, y: n.y - 24, s: '+' + c.def.gold + (c.def.shards ? ' 💠' : ''), o: n.lastHit });
      }
    }
    for (const p of this.players) {
      const h = p.hero;
      if (h.dead || h.hp > 0) continue;
      h.dead = true; h.hp = 0; h.rt = S.respawnBase + S.respawnPerLevel * h.lv; h.tgt = null; h.go = null; h.dx = h.dy = 0;
      this.ev({ k: 'd', x: h.x, y: h.y });
      if (h.lastHit >= 0 && h.lastHit !== p.side) {
        const k = this.players[h.lastHit];
        k.gold += S.heroKillGold; k.stats.gold += S.heroKillGold; k.stats.heroKills++;
        this.addXp(k, S.heroKillXp);
        this.ev({ k: 't', x: h.x, y: h.y - 24, s: '+' + S.heroKillGold, o: h.lastHit });
      }
    }
    const dead = this.castles.filter(c => c.hp <= 0);
    if (dead.length === 2) this.finish(-1, 'Оба замка разрушены одновременно');
    else if (dead.length === 1) this.finish(1 - dead[0].o, 'Замок противника разрушен');
  }

  finish(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.result = {
      winner, reason, time: Math.round(this.t),
      castles: this.castles.map(c => Math.max(0, Math.round(c.hp))),
      stats: this.players.map(p => p.stats)
    };
  }

  forfeit(side) { this.finish(1 - side, 'Соперник отключился'); }

  // ---------- простой бот ----------
  botThink(p) {
    p.botT -= DT;
    if (p.botT > 0) return;
    p.botT = 2.5 + Math.random() * 2;
    const mine = this.buildings.filter(b => b.o === p.side);
    if (p.ult >= S.ultMax && this.armyCount(p.side) >= 4) this.cmd(p.side, { c: 'ult' });
    for (const b of mine) {
      const ab = DATA.buildings[b.type].ability;
      if (!ab || b.cd > 0) continue;
      const front = this.units.filter(u => u.o === p.side).sort((a, c) => (this.dir(p.side) * (c.x - a.x)))[0];
      if (!front) continue;
      if (ab.type === 'haste' && this.armyCount(p.side) >= 5) this.cmd(p.side, { c: 'ability', id: b.id });
      if (ab.type === 'heal' && p.gold > 150) this.cmd(p.side, { c: 'ability', id: b.id, x: front.x });
    }
    if (Math.random() < 0.3) {
      const up = mine.find(b => DATA.buildings[b.type].upgradeTo);
      if (up && this.cmd(p.side, { c: 'upgrade', id: up.id }) === null) return;
    }
    const types = Object.keys(DATA.buildings).filter(k => DATA.buildings[k].faction === p.faction && !DATA.buildings[k].upgradeOnly);
    const t = types[Math.floor(Math.random() * types.length)];
    const used = new Set(mine.map(b => b.slot));
    const free = [];
    for (let i = 0; i < 28; i++) if (!used.has(i)) free.push(i); // бот занимает первые 28 клеток
    if (free.length) {
      const c = { b: t, slot: free[Math.floor(Math.random() * free.length)] };
      if (this.validateBuild(p, c) === null) this.placeBuilding(p, t, c.slot);
    }
  }

  // ---------- снимок для клиентов ----------
  snapshot() {
    const snap = {
      tm: Math.round(this.t * 10) / 10,
      p: this.players.map(p => ({
        g: Math.floor(p.gold), c: p.crystals, ct: Math.round(p.crystalT),
        u: Math.floor(p.ult), uc: Math.ceil(p.ultCd), inc: this.incomeOf(p.side),
        it: Math.round(p.incomeT * 10) / 10, n: this.armyCount(p.side), k: p.stats.kills
      })),
      ch: this.castles.map(c => Math.max(0, Math.round(c.hp))),
      b: this.buildings.map(b => ({
        id: b.id, o: b.o, ty: b.type, s: b.slot, hp: Math.max(0, Math.round(b.hp)), mh: b.max,
        pr: DATA.buildings[b.type].interval ? Math.round((1 - b.spawnT / DATA.buildings[b.type].interval) * 100) / 100 : 0,
        cd: Math.ceil(b.cd), rp: b.repair ? 1 : 0
      })),
      hr: this.players.map(p => { const h = p.hero; return {
        x: Math.round(h.x), y: Math.round(h.y), hp: Math.max(0, Math.ceil(h.hp)), mh: h.mh, lv: h.lv, xp: h.xp,
        d: h.dead ? 1 : 0, rt: Math.ceil(h.rt), mg: Math.floor(h.mg), cb: this.t - h.comboT <= S.swing.comboWindow ? h.combo : 0, ko: h.kos, st: this.t < h.stunU ? 1 : 0, tg: null, sh: p.shards }; }),
      nu: this.neutrals.map(n => [n.id, n.camp, n.type, Math.round(n.x), Math.round(n.y), Math.ceil(n.hp), this.t < n.stunU ? 1 : 0]),
      cp: this.camps.map(c => ({ n: c.alive, rt: Math.ceil(Math.max(0, c.respawnT)) })),
      u: this.units.map(u => [
        u.id, u.o, u.type, Math.round(u.x * 10) / 10, Math.round(u.y), Math.ceil(u.hp),
        (this.t < u.drumU ? 1 : 0) | (this.t < u.lodgeU ? 2 : 0) | (this.t < u.bloodU ? 4 : 0) | (this.t < u.lustU ? 8 : 0)
      ]),
      ev: this.events
    };
    if (this.pause) snap.pause = this.pause;
    this.events = [];
    return snap;
  }
}

module.exports = { Game, DT };
