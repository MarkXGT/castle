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
      builder: { x: i === 0 ? 130 : S.world - 130, y: L.laneY, tx: null, ty: null, orders: [] },
      stats: { kills: 0, lost: 0, bKills: 0, built: 0, gold: 0 }
    }));
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
      case 'move': return this.cmdMove(p, c);
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

  cmdMove(p, c) {
    const x = +c.x, y = +c.y;
    if (!isFinite(x) || !isFinite(y)) return 'Неверная точка';
    const b = p.builder;
    b.orders = []; b.tx = x; b.ty = y;
    return null;
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

  // Заказы стоят в очереди: строитель подходит к клетке на buildRange; платёж и постройка — в момент прибытия.
  cmdBuild(p, c) {
    const err = this.validateBuild(p, c);
    if (err) return err;
    const q = p.builder.orders;
    const slot = c.slot | 0;
    if (q.some(o => o.slot === slot)) return 'Клетка уже в очереди';
    if (q.length >= 8) return 'Очередь заполнена';
    q.push({ k: 'build', b: c.b, slot });
    return null;
  }

  cmdRepair(p, c) {
    const bd = this.myBuilding(p, c.id);
    if (!bd) return 'Нет такого здания';
    if (bd.hp >= bd.max) return 'Здание целое';
    const q = p.builder.orders;
    if (q.some(o => o.k === 'repair' && o.id === bd.id)) return 'Уже в очереди';
    if (q.length >= 8) return 'Очередь заполнена';
    q.push({ k: 'repair', id: bd.id });
    return null;
  }

  placeBuilding(p, type, slot) {
    const def = DATA.buildings[type];
    this.pay(p, def.cost);
    this.addBuilding(p.side, type, slot, def.cost.g || 0);
    p.stats.built++;
  }

  stepBuilder(p) {
    const b = p.builder;
    b.rep = false;
    let tx = b.tx, ty = b.ty, reach = L.buildRange;
    const order = b.orders[0];
    let target = null;
    if (order && order.k === 'repair') {
      target = this.buildings.find(x => x.id === order.id && x.o === p.side);
      if (!target || target.hp >= target.max) { b.orders.shift(); return; }
      tx = target.x; ty = target.y; reach = S.repairRange;
    } else if (order) {
      const sp = slotPos(p.side, order.slot); tx = sp.x; ty = sp.y;
    }
    if (tx === null) return;
    const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy);
    if (order && d <= reach) {
      if (order.k === 'repair') { // ремонт идёт постепенно: золото за каждый HP
        const amt = Math.min(S.repairRate * DT, target.max - target.hp);
        const cost = amt * S.repairCostPerHp;
        if (p.gold < cost) { this.msgs.push({ side: p.side, msg: 'Не хватает золота на ремонт' }); b.orders.shift(); return; }
        p.gold -= cost; target.hp += amt; b.rep = true;
        if (target.hp >= target.max - 0.01) { target.hp = target.max; b.orders.shift(); }
        return;
      }
      b.orders.shift();
      const err = this.validateBuild(p, order);
      if (err) this.msgs.push({ side: p.side, msg: err });
      else this.placeBuilding(p, order.b, order.slot);
      return;
    }
    if (!order && d < 4) { b.tx = null; return; }
    const stepLen = Math.min(d, L.builderSpeed * DT);
    const nx = b.x + dx / d * stepLen, ny = b.y + dy / d * stepLen;
    const minX = p.side === 0 ? 20 : S.world - BASE_MAX_X, maxX = p.side === 0 ? BASE_MAX_X : S.world - 20;
    b.x = Math.max(minX, Math.min(maxX, nx)); b.y = Math.max(20, Math.min(L.worldH - 20, ny));
    if (!order && Math.abs(b.x - nx) > 0.01) b.tx = null; // упёрся в границу зоны
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
      this.inArea(p.side, x, u => { u.hp = Math.min(DATA.units[u.type].hp, u.hp + ab.amount); this.ev({ k: 'h', x: u.x, y: this.unitY(u) }); });
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
      const u = this.units.find(u => u.id === c.target && u.o === p.side && u.hp > 0);
      if (!u) return 'Выберите своего юнита';
      this.pay(p, it.cost);
      u.hp = Math.min(DATA.units[u.type].hp, u.hp + it.amount);
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
      if (p.bot) this.botThink(p); else this.stepBuilder(p);
    }

    const count = [this.armyCount(0), this.armyCount(1)];
    for (const b of this.buildings) {
      b.cd = Math.max(0, b.cd - DT);
      const def = DATA.buildings[b.type];
      if (def.kind !== 'spawner') continue;
      b.spawnT = Math.max(0, b.spawnT - DT);
      if (b.spawnT <= 0 && count[b.o] < S.unitLimit) {
        this.spawnUnit(b.o, def.unit, b.x + this.dir(b.o) * 28, b.y);
        count[b.o]++;
        b.spawnT = def.interval;
      }
    }

    for (const b of this.buildings) if (DATA.buildings[b.type].kind === 'tower') this.actTower(b);
    for (const u of this.units) if (u.hp > 0) this.actUnit(u);
    this.reap();
    if (this.over) return;

    if (this.t >= S.matchSeconds) {
      const a = this.castles[0].hp, b = this.castles[1].hp;
      this.finish(a === b ? -1 : (a > b ? 0 : 1), 'Время вышло: побеждает замок с большим здоровьем');
    }
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
    if (!tgt || b.tcd > 0) return;
    b.tcd = t.interval;
    const td = DATA.units[tgt.type];
    tgt.hp -= this.calcDamage(t, td.armorType, td.armor); tgt.lastHit = b.o;
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
        e.hp -= sk.damage * DATA.damageTable.Magic[td.armorType] * 100 / (100 + 6 * td.armor); e.lastHit = u.o;
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
    if (kind === 'u') { const td = DATA.units[tgt.type]; armorType = td.armorType; armor = td.armor; }
    else if (kind === 'b') { armorType = DATA.buildingArmor.armorType; armor = DATA.buildingArmor.armor; }
    else { armorType = DATA.castle.armorType; armor = DATA.castle.armor; }

    let dmg = randInt(def.damage[0], def.damage[1]) * DATA.damageTable[def.attackType][armorType] * 100 / (100 + 6 * armor);
    let crit = false;
    if (def.crit && Math.random() < def.crit.chance) { dmg *= 1 + def.crit.bonus; crit = true; }
    if (kind !== 'u' && def.buildingMult) dmg *= def.buildingMult;
    if (this.t < u.drumU) dmg *= 1 + DATA.items.drum.bonus;
    tgt.hp -= dmg; tgt.lastHit = u.o;

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
        cd: Math.ceil(b.cd)
      })),
      bl: this.players.map(p => ({ x: Math.round(p.builder.x), y: Math.round(p.builder.y), m: p.builder.tx !== null || p.builder.orders.length ? 1 : 0, rp: p.builder.rep ? 1 : 0, q: p.builder.orders.map(o => o.slot) })),
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
