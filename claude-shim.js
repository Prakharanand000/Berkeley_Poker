// A small stand-in for the Claude artifact runtime (window.claude.use), backed by this
// project's WebSocket server. It gives the game the same `db`, `room` and `user` interfaces
// it uses on claude.ai. When no server answers (for example on GitHub Pages), every
// capability resolves to null and the game falls back to solo mode against bots.
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const tableName = (qs.get('table') || 'main').replace(/[^\w-]/g, '').slice(0, 40) || 'main';

  let cid = null;
  try { cid = localStorage.getItem('bp.cid'); } catch (e) {}
  if (!cid || !/^[\w-]{4,40}$/.test(cid)) {
    cid = Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
    try { localStorage.setItem('bp.cid', cid); } catch (e) {}
  }

  let ws = null, open = false, everOpened = false, myPeer = null, myBy = null;
  let myPresence = {};
  let peersSnap = Object.freeze([]);
  const peerL = new Set(), connL = new Set(), topicL = new Map();
  const docSubs = new Map();         // path -> Set(listener)
  const pending = new Map();         // rid -> {res, rej, timer}
  let rseq = 0, retry = 0;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?table=' + encodeURIComponent(tableName) + '&cid=' + encodeURIComponent(cid);
  const rawSend = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const snap = (path, data) => Object.freeze({
    id: path.split('/').pop(),
    exists: data != null,
    data: () => (data == null ? undefined : data),
    metadata: { fromCache: false, hasPendingWrites: false },
  });

  function setConnected(v) {
    if (open === v) return;
    open = v;
    connL.forEach((fn) => { try { fn(v); } catch (e) { console.error(e); } });
  }

  function onPeersMessage(list) {
    const old = new Map(peersSnap.map((p) => [p.peer, p]));
    const next = list.map((p) => {
      const prev = old.get(p.peer);
      const same = prev && JSON.stringify(prev.presence) === JSON.stringify(p.presence);
      return same ? prev : Object.freeze({
        peer: p.peer, by: p.by || null, isMe: !!myBy && p.by === myBy, sameTab: p.peer === myPeer,
        kind: 'viewer', guest: false, presence: Object.freeze({ ...(p.presence || {}) }), updatedAt: Date.now(),
      });
    });
    const nextIds = new Set(next.map((p) => p.peer));
    const joined = next.filter((p) => !old.has(p.peer));
    const left = peersSnap.filter((p) => !nextIds.has(p.peer));
    const updated = next.filter((p) => old.has(p.peer) && old.get(p.peer) !== p);
    peersSnap = Object.freeze(next);
    if (!joined.length && !left.length && !updated.length) return;
    const change = { peers: peersSnap, joined, left, updated };
    peerL.forEach((fn) => { try { fn(change); } catch (e) { console.error(e); } });
  }

  function connect() {
    try { ws = new WebSocket(wsUrl); } catch (e) { readyResolve(false); return; }
    const giveUp = setTimeout(() => { if (!everOpened) { readyResolve(false); try { ws.close(); } catch (e) {} } }, 4000);
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'welcome') {
        myPeer = m.peer; myBy = m.by;
        everOpened = true; retry = 0;
        clearTimeout(giveUp);
        setConnected(true);
        if (Object.keys(myPresence).length) rawSend({ t: 'pres', patch: myPresence });
        for (const path of docSubs.keys()) rawSend({ t: 'db', op: 'sub', path });
        readyResolve(true);
      } else if (m.t === 'peers') {
        onPeersMessage(Array.isArray(m.peers) ? m.peers : []);
      } else if (m.t === 'emit') {
        const fns = topicL.get(m.topic);
        if (!fns) return;
        const msg = Object.freeze({ topic: m.topic, data: m.data, peer: m.peer, by: m.by || null, isMe: !!myBy && m.by === myBy, sameTab: m.peer === myPeer, kind: 'viewer', guest: false });
        fns.forEach((fn) => { try { fn(msg); } catch (e) { console.error(e); } });
      } else if (m.t === 'dbr') {
        const p = pending.get(m.rid);
        if (!p) return;
        pending.delete(m.rid);
        clearTimeout(p.timer);
        if (m.ok) p.res(m.data); else p.rej({ code: m.code || 'unavailable', message: 'Request failed' });
      } else if (m.t === 'doc') {
        const fns = docSubs.get(m.path);
        if (!fns) return;
        const s = snap(m.path, m.data);
        fns.forEach((fn) => { try { fn(s); } catch (e) { console.error(e); } });
      }
    };
    ws.onclose = () => {
      clearTimeout(giveUp);
      setConnected(false);
      for (const [rid, p] of pending) { clearTimeout(p.timer); p.rej({ code: 'unavailable', message: 'Disconnected' }); pending.delete(rid); }
      if (!everOpened) { readyResolve(false); return; }
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * retry);
    };
    ws.onerror = () => {};
  }

  function request(op, path, extra) {
    return new Promise((res, rej) => {
      if (!open) return rej({ code: 'unavailable', message: 'Not connected' });
      const rid = ++rseq;
      const timer = setTimeout(() => { if (pending.delete(rid)) rej({ code: 'unavailable', message: 'Timed out' }); }, 8000);
      pending.set(rid, { res, rej, timer });
      rawSend({ t: 'db', op, path, rid, ...(extra || {}) });
    });
  }

  const db = Object.freeze({
    doc(path) {
      return Object.freeze({
        id: String(path).split('/').pop(),
        path,
        get: () => request('get', path).then((d) => snap(path, d)),
        set: (data) => request('set', path, { data }).then(() => undefined),
        update: (data) => request('update', path, { data }).then(() => undefined),
        delete: () => request('delete', path).then(() => undefined),
        acquire: (o) => request('acquire', path, { holder: o && o.holder, ttlMs: o && o.ttlMs }),
        onSnapshot(next) {
          if (!docSubs.has(path)) docSubs.set(path, new Set());
          docSubs.get(path).add(next);
          rawSend({ t: 'db', op: 'sub', path });
          return () => { const s = docSubs.get(path); if (s) s.delete(next); };
        },
      });
    },
    collection() { throw new TypeError('Collections are not available in the standalone server'); },
  });

  const room = Object.freeze({
    emit(topic, data) { if (open) rawSend({ t: 'emit', topic, data }); return Promise.resolve(); },
    on(topic, fn) {
      if (!topicL.has(topic)) topicL.set(topic, new Set());
      topicL.get(topic).add(fn);
      return () => topicL.get(topic).delete(fn);
    },
    presence(patch) {
      for (const [k, v] of Object.entries(patch || {})) { if (v === null) delete myPresence[k]; else myPresence[k] = v; }
      rawSend({ t: 'pres', patch });
      return Promise.resolve();
    },
    peers: () => peersSnap,
    onPeers(fn) {
      peerL.add(fn);
      setTimeout(() => { if (peerL.has(fn) && peersSnap.length) fn({ peers: peersSnap, joined: peersSnap, left: [], updated: [] }); }, 0);
      return () => peerL.delete(fn);
    },
    connected: () => open,
    onConnection(fn) { connL.add(fn); setTimeout(() => fn(open), 0); return () => connL.delete(fn); },
  });

  // Everyone may host on the standalone server; the first browser to take the lease runs the game.
  const user = Object.freeze({
    id: async () => myBy,
    isOwner: async () => false,
    canEdit: async () => false,
    can: async (name) => (name === 'data.write' ? true : null),
    me: async () => ({ id: myBy, name: '', avatarUrl: '', color: '#888', email: null, isOwner: false, canEdit: false }),
    profiles: async (ids) => Object.fromEntries([].concat(ids).map((id) => [id, { id, name: '', avatarUrl: '', color: '#888', email: null, isMe: id === myBy, guest: false }])),
  });

  const caps = { db, room, user };
  window.claude = Object.freeze({
    use: async (name) => ((await ready) ? caps[name] || null : null),
  });

  if (location.protocol === 'http:' || location.protocol === 'https:') connect();
  else readyResolve(false);
})();
