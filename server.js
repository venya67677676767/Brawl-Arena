// BRAWL ARENA — общий сервер (Node, без установки пакетов).
// Запуск:  node server.js
// Игра:    http://localhost:3000  (или http://ТВОЙ-IP:3000 для друзей по Wi-Fi)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = path.normalize(__dirname + '/..');
const DBF = __dirname + '/db.json';

let DB = { users: {}, tokens: {} };
try { DB = JSON.parse(fs.readFileSync(DBF, 'utf8')); DB.users ||= {}; DB.tokens ||= {}; }
catch (e) { DB = { users: {}, tokens: {} }; }
function persistDb() { try { fs.writeFileSync(DBF, JSON.stringify(DB)); } catch (e) {} }

const NICK_RE = /^[\p{L}\p{N}_.-]{3,16}$/u;
const norm = n => String(n || '').trim().toLowerCase();
const esc = s => String(s ?? '').slice(0, 200);

function hashPw(pw, salt) { return crypto.createHash('sha256').update(salt + '::' + pw).digest('hex'); }
function userByToken(tok) {
  const key = DB.tokens[tok];
  if (!key || !DB.users[key]) return null;
  return { key, u: DB.users[key] };
}

// SSE клиенты: key -> Set(res)
const sse = new Map();
function sseSend(key, obj) {
  const set = sse.get(key);
  if (!set) return;
  const data = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of [...set]) { try { res.write(data); } catch (e) {} }
}
// Пати: partyId -> {leader, members:[keys]}
const parties = new Map();       // partyId -> party
const userParty = new Map();     // key -> partyId
function getPartyOf(key) {
  const pid = userParty.get(key);
  if (!pid) return null;
  return parties.get(pid) || null;
}
function partyView(p) {
  return {
    t: 'party', leader: p.leader,
    members: p.members.map(k => ({
      key: k, nick: DB.users[k] ? DB.users[k].nick : k,
      fighter: (DB.users[k] && DB.users[k].save && DB.users[k].save.selected) || 'rookie',
      lv: 1
    }))
  };
}
function broadcastParty(p) { for (const k of p.members) sseSend(k, partyView(p)); }
function leavePartyFn(key) {
  const p = getPartyOf(key);
  if (!p) return;
  p.members = p.members.filter(k => k !== key);
  userParty.delete(key);
  if (p.members.length < 2) {
    for (const k of p.members) { userParty.delete(k); sseSend(k, { t: 'party', members: [] }); }
    for (const [pid, pp] of parties) if (pp === p) parties.delete(pid);
  } else {
    if (p.leader === key) p.leader = p.members[0];
    broadcastParty(p);
  }
}

// Подбор случайных игроков: [{key, mode, ts}]
let queue = [];
function cleanQueue() { const n = Date.now(); queue = queue.filter(q => n - q.ts < 20000 && DB.users[q.key]); }

function sendJson(res, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}
function readBody(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 500000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // --- SSE ---
  if (url.pathname === '/api/events' && req.method === 'GET') {
    const u = userByToken(url.searchParams.get('token'));
    if (!u) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write(': ok\n\n');
    if (!sse.get(u.key)) sse.set(u.key, new Set());
    sse.get(u.key).add(res);
    DB.users[u.key].online = true; DB.users[u.key].lastSeen = Date.now(); persistDb();
    const p = getPartyOf(u.key);
    if (p) res.write('data: ' + JSON.stringify(partyView(p)) + '\n\n');
    req.on('close', () => {
      try { sse.get(u.key).delete(res); } catch (e) {}
      try { if (DB.users[u.key]) { DB.users[u.key].online = false; persistDb(); } } catch (e) {}
    });
    return;
  }
  // --- API ---
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const p = url.pathname.slice(5);
    if (p === 'ping' && req.method === 'GET') return sendJson(res, { ok: true, v: '1.1.0' });
    const b = req.method === 'POST' ? await readBody(req) : {};
    const me = userByToken(b.token);
    // register / login — без токена
    if (p === 'register' || p === 'login') {
      const nick = esc(b.nick).trim(), key = norm(nick), pw = String(b.pw || '');
      if (!NICK_RE.test(nick)) return sendJson(res, { e: 'Ник: 3–16 символов (буквы, цифры, _ . -)' });
      if (pw.length < 4) return sendJson(res, { e: 'Пароль — минимум 4 символа' });
      if (p === 'register') {
        if (DB.users[key]) return sendJson(res, { e: 'Такой ник уже существует. Возьми другой' });
        const salt = crypto.randomBytes(8).toString('hex');
        DB.users[key] = { nick, salt, hash: hashPw(pw, salt), save: (b.save && typeof b.save === 'object') ? b.save : null, friends: [], online: true, lastSeen: Date.now() };
      } else {
        const u = DB.users[key];
        if (!u || u.hash !== hashPw(pw, u.salt)) return sendJson(res, { e: 'Неверный ник или пароль' });
      }
      const token = crypto.randomBytes(16).toString('hex');
      DB.tokens[token] = key; DB.users[key].online = true; DB.users[key].lastSeen = Date.now(); persistDb();
      return sendJson(res, { token, nick: DB.users[key].nick, save: DB.users[key].save });
    }
    if (!me) return sendJson(res, { e: 'Войди снова' });
    const { key, u } = me;
    u.online = true; u.lastSeen = Date.now();
    if (p === 'me') { persistDb(); return sendJson(res, { nick: u.nick, save: u.save }); }
    if (p === 'save') {
      if (b.save && typeof b.save === 'object') { u.save = b.save; persistDb(); }
      return sendJson(res, { ok: true });
    }
    if (p === 'exists') {
      const k = norm(b.nick);
      return sendJson(res, { ok: !!DB.users[k], nick: DB.users[k] ? DB.users[k].nick : null });
    }
    if (p === 'state') {
      const mine = ((u.save && u.save.friends) || u.friends || []).map(norm);
      const friends = [], reqs = [];
      for (const k of Object.keys(DB.users)) {
        if (k === key) continue;
        const ou = DB.users[k];
        const theirs = ((ou.save && ou.save.friends) || ou.friends || []).map(norm);
        const iAdd = mine.includes(k), heAdds = theirs.includes(key);
        if (iAdd || heAdds) friends.push({ key: k, nick: ou.nick, online: !!ou.online && Date.now() - (ou.lastSeen || 0) < 60000, mutual: iAdd && heAdds });
        if (heAdds && !iAdd) reqs.push({ key: k, nick: ou.nick });
      }
      persistDb();
      return sendJson(res, { friends, reqs });
    }
    if (p === 'invite' || p === 'kick' || p === 'leave') {
      if (p === 'leave' || (p === 'kick' && norm(b.key) === key)) { leavePartyFn(key); return sendJson(res, { ok: true }); }
      const target = norm(b.key);
      if (!DB.users[target]) return sendJson(res, { e: 'Аккаунт не найден' });
      const myF = ((u.save && u.save.friends) || []).map(norm);
      const hisF = ((DB.users[target].save && DB.users[target].save.friends) || []).map(norm);
      if (!(myF.includes(target) && hisF.includes(key))) return sendJson(res, { e: 'Нужно взаимное «в друзья» с обеих сторон ✅' });
      let party = getPartyOf(key);
      if (!party) {
        const pid = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 999);
        party = { id: pid, leader: key, members: [key] };
        parties.set(pid, party); userParty.set(key, pid);
      }
      if (party.leader !== key) return sendJson(res, { e: 'Приглашать может хозяин лобби 👑' });
      if (party.members.length >= 5) return sendJson(res, { e: 'Лобби полное (5/5)' });
      if (p === 'kick') {
        party.members = party.members.filter(k => k !== target);
        userParty.delete(target); sseSend(target, { t: 'party', members: [] });
        broadcastParty(party); return sendJson(res, { ok: true });
      }
      if (!party.members.includes(target)) {
        const oldP = getPartyOf(target);
        if (oldP) return sendJson(res, { e: 'Друг уже в другом лобби' });
        party.members.push(target); userParty.set(target, party.id);
      }
      broadcastParty(party); return sendJson(res, { ok: true });
    }
    if (p === 'start') {
      const party = getPartyOf(key);
      if (!party) return sendJson(res, { e: 'Сначала собери лобби' });
      if (party.leader !== key) return sendJson(res, { e: 'Начать бой может только хозяин лобби 👑' });
      const mode = esc(b.mode || 'team').slice(0, 20);
      const members = party.members.map(k => ({ key: k, nick: DB.users[k].nick, fighter: (DB.users[k].save && DB.users[k].save.selected) || 'rookie', lv: 1 }));
      for (const k of party.members) sseSend(k, { t: 'match', host: key, members, mode });
      return sendJson(res, { ok: true });
    }
    if (p === 'relay') {
      const msg = b.msg;
      if (!msg) return sendJson(res, { ok: true });
      if (b.to && DB.users[norm(b.to)]) { sseSend(norm(b.to), { t: 'r', from: key, msg }); }
      else {
        const party = getPartyOf(key);
        const targets = party ? party.members.filter(k => k !== key) : [];
        for (const k of targets) sseSend(k, { t: 'r', from: key, msg });
      }
      return sendJson(res, { ok: true });
    }
    if (p === 'find') {
      cleanQueue();
      const mode = esc(b.mode || 'team').slice(0, 20);
      if (!queue.find(q => q.key === key)) queue.push({ key, mode, ts: Date.now() });
      // ищем других в том же режиме
      const others = queue.filter(q => q.key !== key && q.mode === mode);
      if (others.length >= 1) {
        const mates = [key, ...others.slice(0, 3).map(q => q.key)]; // пати до 4 из подбора
        queue = queue.filter(q => !mates.includes(q.key));
        const pid = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 999);
        const party = { id: pid, leader: mates[0], members: mates };
        parties.set(pid, party);
        for (const k of mates) { const old = getPartyOf(k); userParty.set(k, pid); }
        const members = mates.map(k => ({ key: k, nick: DB.users[k].nick, fighter: (DB.users[k].save && DB.users[k].save.selected) || 'rookie', lv: 1 }));
        for (const k of mates) sseSend(k, { t: 'match', host: mates[0], members, mode });
        return sendJson(res, { matched: mates });
      }
      return sendJson(res, { matched: [], wait: true, online: queue.length });
    }
    return sendJson(res, { e: 'Неизвестный запрос' });
  }
  // --- статика ---
  let fp = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp)) fp = path.join(ROOT, 'index.html');
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('🦊 BRAWL ARENA сервер запущен: http://localhost:' + PORT + '\nДля друзей по Wi-Fi: http://ТВОЙ-IP:' + PORT));
