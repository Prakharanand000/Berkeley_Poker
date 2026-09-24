// Berkeley Poker server.
// Serves the game page and relays table state between browsers over a WebSocket.
// The game logic itself runs in one player's browser (the "host"); this server only stores
// a few shared documents, hands out the host lease, and broadcasts presence and events.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// Only these files are served; everything else in the folder (server code, data) stays private.
const FILES = new Set(['/index.html', '/claude-shim.js']);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------- static files ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  let p = url.pathname;
  if (p === '/') p = '/index.html';
  if (!FILES.has(p)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const file = path.join(__dirname, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

/* ---------- tables: each ?table=name is its own game ---------- */
const tables = new Map();
function cleanName(s, n = 40) { return String(s || '').slice(0, n).replace(/[^\w-]/g, ''); }
function loadTable(name) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf8'));
    return new Map(Object.entries(raw));
  } catch (e) { return new Map(); }
}
function table(name) {
  if (!tables.has(name)) tables.set(name, { name, docs: loadTable(name), leases: new Map(), peers: new Map(), subs: new Map(), saveTimer: null });
  return tables.get(name);
}
function scheduleSave(T) {
  clearTimeout(T.saveTimer);
  T.saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, T.name + '.json'), JSON.stringify(Object.fromEntries(T.docs)));
    } catch (e) { /* disk may be read-only on some hosts; the game still works from memory */ }
  }, 2000);
}

/* ---------- websocket relay ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
let seq = 0;

function peersList(T) {
  return [...T.peers].map(([peer, p]) => ({ peer, by: p.by, presence: p.presence, updatedAt: p.updatedAt }));
}
function broadcastPeers(T) {
  const msg = { t: 'peers', peers: peersList(T) };
  for (const p of T.peers.values()) send(p.ws, msg);
}
function notifyDoc(T, docPath) {
  const subs = T.subs.get(docPath);
  if (!subs) return;
  const data = T.docs.has(docPath) ? T.docs.get(docPath) : null;
  for (const ws of subs) send(ws, { t: 'doc', path: docPath, data });
}
function handleDb(T, ws, m) {
  const docPath = String(m.path || '').slice(0, 200);
  const reply = (body) => send(ws, { t: 'dbr', rid: m.rid, ...body });
  if (!docPath) return reply({ ok: false, code: 'invalid_argument' });
  const isObj = (d) => d && typeof d === 'object' && !Array.isArray(d);
  switch (m.op) {
    case 'get':
      return reply({ ok: true, data: T.docs.has(docPath) ? T.docs.get(docPath) : null });
    case 'set':
      if (!isObj(m.data)) return reply({ ok: false, code: 'invalid_argument' });
      T.docs.set(docPath, m.data); scheduleSave(T); notifyDoc(T, docPath);
      return reply({ ok: true });
    case 'update':
      if (!isObj(m.data) || !T.docs.has(docPath)) return reply({ ok: false, code: 'invalid_argument' });
      T.docs.set(docPath, { ...T.docs.get(docPath), ...m.data }); scheduleSave(T); notifyDoc(T, docPath);
      return reply({ ok: true });
    case 'delete':
      T.docs.delete(docPath); scheduleSave(T); notifyDoc(T, docPath);
      return reply({ ok: true });
    case 'acquire': {
      const holder = String(m.holder || '').slice(0, 80);
      const ttl = Math.min(600000, Math.max(1000, Number(m.ttlMs) || 30000));
      const now = Date.now();
      const l = T.leases.get(docPath);
      if (!l || l.exp < now || l.holder === holder) {
        T.leases.set(docPath, { holder, exp: now + ttl });
        return reply({ ok: true, data: { acquired: true, holder, expiresAt: new Date(now + ttl).toISOString() } });
      }
      return reply({ ok: true, data: { acquired: false, expiresAt: new Date(l.exp).toISOString() } });
    }
    case 'sub': {
      if (!T.subs.has(docPath)) T.subs.set(docPath, new Set());
      T.subs.get(docPath).add(ws);
      send(ws, { t: 'doc', path: docPath, data: T.docs.has(docPath) ? T.docs.get(docPath) : null });
      return;
    }
    default:
      return reply({ ok: false, code: 'invalid_argument' });
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const T = table(cleanName(url.searchParams.get('table')) || 'main');
  const cid = cleanName(url.searchParams.get('cid'));
  const peer = 'p' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
  const me = { ws, by: cid ? 'u_' + cid : null, presence: {}, updatedAt: Date.now() };
  ws.isAlive = true;
  T.peers.set(peer, me);
  send(ws, { t: 'welcome', peer, by: me.by });
  broadcastPeers(T);

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'pres' && m.patch && typeof m.patch === 'object') {
      const next = { ...me.presence };
      for (const [k, v] of Object.entries(m.patch)) { if (v === null) delete next[k]; else next[k] = v; }
      if (JSON.stringify(next).length > 4096) return;
      me.presence = next;
      me.updatedAt = Date.now();
      broadcastPeers(T);
    } else if (m.t === 'emit') {
      const msg = { t: 'emit', topic: String(m.topic || '').slice(0, 48), data: m.data, peer, by: me.by };
      for (const p of T.peers.values()) send(p.ws, msg);
    } else if (m.t === 'db') {
      handleDb(T, ws, m);
    }
  });
  ws.on('close', () => {
    T.peers.delete(peer);
    for (const set of T.subs.values()) set.delete(ws);
    broadcastPeers(T);
  });
});

// Drop dead connections so everyone's "who is online" stays accurate.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`Berkeley Poker is running on http://localhost:${PORT}`));
