'use strict';
// Brawl Arena backend foundation. Node.js 20+; no third-party packages required.
// JSON storage is suitable for local development only. Use a managed database before public deployment.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'server-data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 3000);
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, sessions: {}, friendRequests: [], parties: {}, userParty: {}, matches: {} };
try { if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) { console.error('Could not read db.json:', e.message); }
let saveQueued = false;
function saveDb() { if (saveQueued) return; saveQueued = true; setTimeout(() => { saveQueued = false; const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }, 30); }
const clients = new Map();
const lower = s => String(s || '').trim().toLowerCase();
const safeNick = s => /^[\p{L}\p{N}_.-]{3,16}$/u.test(String(s || '').trim());
const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
function userFromToken(token) { const k = db.sessions[tokenHash(token || '')]; if (!k) return null; const u = db.users[k]; return u ? { key: k, ...u } : null; }
function publicUser(key) { const u = db.users[key]; if (!u) return null; return { key, nick: u.nick, fighter: u.save?.selected || 'rookie', lv: (u.save?.levels?.[u.save?.selected] || 1) }; }
function send(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); res.end(JSON.stringify(obj)); }
function emit(key, event) { for (const res of clients.get(key) || []) { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {} } }
function emitParty(id) { const p = db.parties[id]; if (!p) return; const members = p.members.map(publicUser).filter(Boolean); for (const key of p.members) emit(key, { t: 'party', members, leader: p.leader, code: p.code }); }
function stateFor(key) {
 const u = db.users[key]; const friends = (u.save?.friends || []).map(k => { const v = db.users[k]; if (!v) return null; return { key: k, nick: v.nick, online: [...clients.keys()].includes(k), mutual: (v.save?.friends || []).includes(key) }; }).filter(Boolean);
 const reqs = db.friendRequests.filter(r => r.to === key).map(r => publicUser(r.from)).filter(Boolean);
 return { friends, reqs };
}
function currentParty(key) { const id = db.userParty[key]; return id ? db.parties[id] : null; }
function leaveParty(key) { const id = db.userParty[key], p = id && db.parties[id]; if (!p) return; p.members = p.members.filter(k => k !== key); delete db.userParty[key]; if (!p.members.length) delete db.parties[id]; else { if (p.leader === key) p.leader = p.members[0]; emitParty(id); } saveDb(); }
async function route(req, res) {
 if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
 const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
 if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { const file = path.join(ROOT, 'www', 'index.html'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return fs.createReadStream(file).pipe(res); }
 if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, service: 'brawl-arena-api', version: '0.1.0' });
 if (req.method === 'GET' && url.pathname === '/api/events') {
   const u = userFromToken(url.searchParams.get('token')); if (!u) return send(res, 401, { e: 'Сессия истекла. Войди снова.' });
   res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' }); res.write(': connected\n\n');
   if (!clients.has(u.key)) clients.set(u.key, new Set()); clients.get(u.key).add(res);
   const p = currentParty(u.key); if (p) res.write(`data: ${JSON.stringify({ t: 'party', members: p.members.map(publicUser).filter(Boolean), leader: p.leader, code: p.code })}\n\n`);
   const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
   req.on('close', () => { clearInterval(heartbeat); const set = clients.get(u.key); if (set) { set.delete(res); if (!set.size) clients.delete(u.key); } }); return;
 }
 if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(res, 404, { e: 'Маршрут не найден' });
 let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) return send(res, 413, { e: 'Запрос слишком большой' }); }
 let b = {}; try { b = body ? JSON.parse(body) : {}; } catch { return send(res, 400, { e: 'Некорректный JSON' }); }
 const action = url.pathname.slice('/api/'.length);
 if (action === 'register' || action === 'login') {
   const nick = String(b.nick || '').trim(), key = lower(nick), pw = String(b.pw || '');
   if (!safeNick(nick)) return send(res, 200, { e: 'Ник: 3–16 букв, цифр или символов _ . -' });
   if (pw.length < 4 || pw.length > 128) return send(res, 200, { e: 'Пароль должен быть длиной от 4 до 128 символов.' });
   let u = db.users[key];
   if (action === 'register') { if (u) return send(res, 200, { e: 'Этот ник уже занят.' }); const salt = crypto.randomBytes(16).toString('hex'); u = db.users[key] = { nick, salt, pwHash: hashPw(pw, salt), save: { cups: 0, coins: 0, credits: 0, gems: 0, chests: 1, unlocked: ['rookie'], selected: 'rookie', claimed: [], wins: 0, skins: [], fighterSkins: {}, friends: [], pp: 0, levels: {} }, createdAt: Date.now() }; }
   else if (!u || !crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt)), Buffer.from(u.pwHash))) return send(res, 200, { e: 'Неверный ник или пароль.' });
   const token = crypto.randomBytes(32).toString('hex'); db.sessions[tokenHash(token)] = key; saveDb(); return send(res, 200, { token, nick: u.nick, save: u.save });
 }
 const u = userFromToken(b.token); if (!u) return send(res, 200, { e: 'Сессия истекла. Войди снова.' }); const key = u.key;
 switch (action) {
 case 'me': return send(res, 200, { nick: u.nick, save: u.save });
 case 'save': if (!b.save || typeof b.save !== 'object') return send(res, 200, { e: 'Нет данных сохранения.' }); db.users[key].save = b.save; saveDb(); return send(res, 200, { ok: true });
 case 'state': return send(res, 200, stateFor(key));
 case 'exists': return send(res, 200, { ok: !!db.users[lower(b.nick)] });
 case 'invite': {
   const target = lower(b.key), v = db.users[target]; if (!v || target === key) return send(res, 200, { e: 'Игрок не найден.' });
   if (!(u.save?.friends || []).includes(target) || !(v.save?.friends || []).includes(key)) return send(res, 200, { e: 'Сначала добавьте друг друга в друзья.' });
   let p = currentParty(key); if (!p) { const id = crypto.randomBytes(6).toString('hex'); p = db.parties[id] = { id, code: id.slice(0, 6).toUpperCase(), leader: key, members: [key] }; db.userParty[key] = id; }
   if (p.leader !== key) return send(res, 200, { e: 'Только хозяин лобби может приглашать.' }); if (p.members.length >= 5) return send(res, 200, { e: 'Лобби уже заполнено.' });
   const other = currentParty(target); if (other && other.id !== p.id) leaveParty(target); if (!p.members.includes(target)) { p.members.push(target); db.userParty[target] = p.id; } saveDb(); emitParty(p.id); return send(res, 200, { ok: true, code: p.code }); }
 case 'leave': leaveParty(key); return send(res, 200, { ok: true });
 case 'kick': { const p = currentParty(key), target = lower(b.key); if (!p || p.leader !== key || !p.members.includes(target)) return send(res, 200, { e: 'Нельзя исключить этого игрока.' }); leaveParty(target); return send(res, 200, { ok: true }); }
 case 'accept': { const from = lower(b.key); const i = db.friendRequests.findIndex(r => r.from === from && r.to === key); if (i < 0) return send(res, 200, { e: 'Запрос не найден.' }); db.friendRequests.splice(i, 1); for (const [a, z] of [[key, from], [from, key]]) { const arr = db.users[a].save.friends ||= []; if (!arr.includes(z)) arr.push(z); } saveDb(); return send(res, 200, { ok: true }); }
 case 'request': { const to = lower(b.key); if (!db.users[to] || to === key) return send(res, 200, { e: 'Игрок не найден.' }); if (db.friendRequests.some(r => r.from === key && r.to === to)) return send(res, 200, { ok: true }); db.friendRequests.push({ from: key, to }); saveDb(); return send(res, 200, { ok: true }); }
 case 'start': { const p = currentParty(key); if (!p || p.leader !== key) return send(res, 200, { e: 'Создай лобби или стань его хозяином.' }); const members = p.members.map(publicUser).filter(Boolean); const matchId = crypto.randomBytes(8).toString('hex'); db.matches[matchId] = { id: matchId, members: p.members.slice(), host: key, mode: String(b.mode || 'solo'), startedAt: Date.now() }; saveDb(); for (const playerKey of p.members) emit(playerKey, { t: 'match', host: key, members, mode: String(b.mode || 'solo'), matchId }); return send(res, 200, { ok: true, matchId }); }
 case 'relay': { const p = currentParty(key); const msg = b.msg; if (!msg || typeof msg !== 'object') return send(res, 200, { e: 'Нет данных матча.' }); if (b.to) { const target = lower(b.to); if (!p || !p.members.includes(target)) return send(res, 200, { e: 'Игрок не в твоём лобби.' }); emit(target, { t: 'r', from: key, msg }); } else if (p) { for (const target of p.members) if (target !== key) emit(target, { t: 'r', from: key, msg }); } return send(res, 200, { ok: true }); }
 default: return send(res, 404, { e: 'Маршрут не найден' });
 }
}
const server = http.createServer((req, res) => { route(req, res).catch(err => { console.error(err); if (!res.headersSent) send(res, 500, { e: 'Внутренняя ошибка сервера' }); else res.end(); }); });
server.listen(PORT, '0.0.0.0', () => console.log(`Brawl Arena API listening on http://localhost:${PORT}`));
