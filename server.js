// Dead Shift game server: serves the game and relays messages between the host and
// their friends over WebSockets, so nobody needs a direct peer-to-peer connection.
// No dependencies — run with:  node server.js   (then open http://localhost:8765)
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8765;
const GAME = path.join(__dirname, 'index.html');

// ---- leaderboard: saved to leaderboard.json next to this file ----
// on Railway, point this at a mounted volume so scores survive redeploys
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const LB_FILE = path.join(DATA_DIR, 'leaderboard.json');
const MODES = ['solo', 'duo', 'squad'], KEEP = 100, CHARS = ['elon', 'trump', 'kitty', 'cz'];
let board = { solo: [], duo: [], squad: [] };
// runs that ended in round 1 without a single kill aren't real runs (quits, tests) — keep them off the board
const counts = e => e.round >= 2 || e.kills > 0;
try { const saved = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); for (const m of MODES) if (Array.isArray(saved[m])) board[m] = saved[m].filter(counts); } catch (e) {}
const rankOrder = (a, b) => b.round - a.round || b.kills - a.kills || a.at - b.at; // highest round, then most kills, then first to get there
function saveBoard() {
  const tmp = LB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(board), err => { if (!err) fs.rename(tmp, LB_FILE, () => {}); });
}
const lastPost = new Map();
function addScore(body) {
  const players = (Array.isArray(body.players) ? body.players : []).slice(0, 8).map(p => ({
    n: String(p && p.n || 'Survivor').replace(/[<>&"\u0000-\u001f]/g, '').trim().slice(0, 14) || 'Survivor',
    ch: CHARS.includes(p && p.ch) ? p.ch : null,
    k: Math.max(0, Math.min(100000, Math.floor(+(p && p.k) || 0))),
    left: p && +p.left >= 1 ? Math.min(999, Math.floor(+p.left)) : null, // round they left in, if they quit early
  }));
  const round = Math.floor(+body.round || 0), gid = String(body.gid || '').slice(0, 24);
  if (!players.length || round < 1 || round > 999 || !gid) return { error: 'bad score' };
  // the mode the host picked (players who left mid-run still count toward its size)
  const SIZE = { solo: 1, duo: 2, squad: 4 };
  const mode = MODES.includes(body.mode) && players.length === SIZE[body.mode] ? body.mode : players.length === 1 ? 'solo' : players.length === 2 ? 'duo' : 'squad';
  if (!counts({ round, kills: players.reduce((a, p) => a + p.k, 0) })) return { mode, rank: null, top: board[mode].slice(0, 5), skipped: true };
  const list = board[mode];
  if (list.some(e => e.gid === gid)) return { mode, rank: list.findIndex(e => e.gid === gid) + 1, top: list.slice(0, 5) };
  const entry = { gid, round, kills: players.reduce((a, p) => a + p.k, 0), players, at: Date.now() };
  list.push(entry); list.sort(rankOrder); list.length = Math.min(list.length, KEEP);
  saveBoard();
  const i = list.indexOf(entry);
  log(`leaderboard ${mode}: round ${round}, ${entry.kills} kills -> ${i >= 0 ? '#' + (i + 1) : 'not ranked'}`);
  return { mode, rank: i >= 0 ? i + 1 : null, top: list.slice(0, 5) };
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(GAME).pipe(res);
  } else if (pathname === '/leaderboard' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ solo: board.solo.slice(0, 25), duo: board.duo.slice(0, 25), squad: board.squad.slice(0, 25) }));
  } else if (pathname === '/leaderboard' && req.method === 'POST') {
    const ip = req.socket.remoteAddress, t = Date.now();
    if (t - (lastPost.get(ip) || 0) < 1000) { res.writeHead(429); return res.end('{"error":"slow down"}'); }
    lastPost.set(ip, t);
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = addScore(JSON.parse(body)); } catch (e) { out = { error: 'bad json' }; }
      res.writeHead(out.error ? 400 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
    });
  } else if (pathname === '/relay-ok') {
    // also tells the host page its public link (written by the launcher once the tunnel is up)
    let publicUrl = process.env.PUBLIC_URL || null;
    try { publicUrl = fs.readFileSync(path.join(__dirname, '.public-url'), 'utf8').trim() || publicUrl; } catch (e) {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: 1, publicUrl }));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ---- minimal WebSocket (RFC 6455) ----
server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  onConnection(wrap(sock), url.searchParams);
});

function wrap(sock) {
  const ws = {
    closed: false, onmessage: null, onclose: null,
    send(text) {
      if (ws.closed) return;
      const body = Buffer.from(text);
      let head;
      if (body.length < 126) head = Buffer.from([0x81, body.length]);
      else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(body.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
      sock.write(Buffer.concat([head, body]));
    },
    close() {
      if (ws.closed) return;
      ws.closed = true;
      try { sock.write(Buffer.from([0x88, 0])); sock.end(); } catch (e) {}
      if (ws.onclose) ws.onclose();
    },
  };
  let buf = Buffer.alloc(0), parts = [];
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return ws.close(); // nothing in this game is anywhere near 1MB
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)];
      buf = buf.subarray(off + len);
      if (op === 0x8) return ws.close();
      if (op === 0x9) { if (payload.length < 126) sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 0xa) continue;
      parts.push(payload);
      if (fin) { const text = Buffer.concat(parts).toString(); parts = []; if (ws.onmessage) ws.onmessage(text); }
    }
  });
  sock.on('close', () => { if (!ws.closed) { ws.closed = true; if (ws.onclose) ws.onclose(); } });
  sock.on('error', () => {});
  return ws;
}

// ---- rooms: one host, any number of friends ----
const rooms = new Map();
let nextId = 1;
const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };

function onConnection(ws, q) {
  const hostCode = (q.get('host') || '').toUpperCase().slice(0, 8);
  const joinCode = (q.get('join') || '').toUpperCase().slice(0, 8);
  if (hostCode) {
    if (rooms.has(hostCode)) { ws.send(JSON.stringify({ err: 'taken' })); return ws.close(); }
    const room = { host: ws, clients: new Map() };
    rooms.set(hostCode, room);
    ws.send(JSON.stringify({ ok: 1 }));
    log(`room ${hostCode} opened`);
    ws.onmessage = s => { const d = parse(s); if (!d) return; const c = room.clients.get(d.to); if (c) c.send(JSON.stringify({ m: d.m })); };
    ws.onclose = () => { rooms.delete(hostCode); for (const c of room.clients.values()) c.close(); log(`room ${hostCode} closed`); };
  } else if (joinCode) {
    const room = rooms.get(joinCode);
    if (!room) { ws.send(JSON.stringify({ err: 'noroom' })); return ws.close(); }
    const id = 'c' + nextId++;
    room.clients.set(id, ws);
    ws.send(JSON.stringify({ ok: 1, id }));
    room.host.send(JSON.stringify({ join: id }));
    log(`player joined ${joinCode}`);
    ws.onmessage = s => { const d = parse(s); if (d) room.host.send(JSON.stringify({ from: id, m: d.m })); };
    ws.onclose = () => { room.clients.delete(id); room.host.send(JSON.stringify({ leave: id })); };
  } else ws.close();
}
const log = msg => console.log(new Date().toLocaleTimeString(), msg);

server.listen(PORT, () => console.log(`Dead Shift is running: http://localhost:${PORT}`));
