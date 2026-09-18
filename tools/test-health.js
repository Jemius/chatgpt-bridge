// chatgpt-bridge · test-health.js
//
// Verifies the /health endpoint (v1.2.11 "which build is running"):
//   1. relay.version always matches package.json
//   2. before any hello, the extension identity fields are null
//   3. a hello carrying version+protocol is recorded verbatim
//   4. unknown message types don't touch extInfo
//   5. after a disconnect the last-known identity is kept
//   6. an old-style empty hello resets the fields to null (pre-1.2.11 compat)
//   7. an end-to-end result round-trip forwards blockedFeatures (P0 fix guard)
//   8. composer wall is boundary-exact: 10000 -> 413, 9999 -> passes (audit
//      F1 + tester re-check: a guard tested one step outside its boundary is
//      untested)
//   9. timeoutMs=1 is clamped: a fast reply beats the timer (no fake timeout)
//  10. the heartbeat keeps live clients and terminates silent ones (audit F3)
//  11. a non-numeric BRIDGE_COMPOSER_LIMIT falls back loudly, no NaN silence
//      (tester re-check)
//
// Spawns its own relay instance on PORT=8799 so it never fights the real one.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failures.push(label); console.log(`FAIL  ${label}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}/health`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('health timeout')));
  });
}

// POST /api/chat and resolve { status, json } — no extension needed for the
// relay-side rejections (413 composer wall fires before the no-client gate).
function postChat(base, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('post timeout')));
    req.end(body);
  });
}

// Poll /health until `pred` holds (or timeout) — avoids racing the async hello.
async function waitFor(pred, label, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    let h = null;
    try { h = await getHealth(); } catch (e) { /* relay not up yet */ }
    if (h && pred(h)) return h;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await sleep(100);
  }
}

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 4000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function main() {
  console.log(`test-health: spawning relay on port ${PORT} (relay v${PKG.version})`);
  const child = spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js')], {
    // BRIDGE_HEARTBEAT_MS=200 speeds the heartbeat up ~150x so case [9] runs
    // in milliseconds instead of half a minute of real time.
    env: { ...process.env, PORT: String(PORT), BRIDGE_HEARTBEAT_MS: '200' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));

  // Total-time guard so a wedged relay can't hang the whole test chain.
  const killTimer = setTimeout(() => {
    try { child.kill(); } catch (e) {}
    console.error('test-health: overall timeout — relay logs:\n' + logs.join(''));
    process.exit(1);
  }, 30000);

  try {
    // [1] relay comes up; initial extension identity is all-null.
    const h0 = await waitFor((h) => h && h.ok === true, 'relay up');
    if (child.exitCode !== null) throw new Error('relay exited early (port in use?) — see logs');
    assert(h0.relay && h0.relay.version === PKG.version, 'relay.version matches package.json');
    assert(h0.extension && h0.extension.version === null, 'initial extension.version is null');
    assert(h0.extension.protocol === null, 'initial extension.protocol is null');
    assert(h0.extension.seenAt === null, 'initial extension.seenAt is null');
    assert(h0.extension.ageMs === null, 'initial extension.ageMs is null');
    assert(h0.extension.lastPongMs === null, 'initial extension.lastPongMs is null');

    // [2] hello with version+protocol is recorded verbatim.
    let ws = await wsConnect();
    await waitFor((h) => h.clients === 1, 'ws client counted');
    assert((await getHealth()).clients === 1, 'clients === 1 after connect');
    ws.send(JSON.stringify({ type: 'hello', version: '9.9.9-test', protocol: '7' }));
    const h2 = await waitFor((h) => h.extension.version === '9.9.9-test', 'hello recorded');
    assert(h2.extension.version === '9.9.9-test', 'hello version recorded');
    assert(h2.extension.protocol === '7', 'hello protocol recorded');
    assert(typeof h2.extension.seenAt === 'number' && h2.extension.seenAt > 0, 'hello seenAt set');
    assert(typeof h2.extension.ageMs === 'number' && h2.extension.ageMs < 5000,
      'hello ageMs is a small fresh number');
    assert(h2.extension.lastPongMs != null && h2.extension.lastPongMs < 2000,
      'lastPongMs is fresh on a live link (distinct from ageMs)');

    // [3] unknown message types must not touch extInfo.
    ws.send(JSON.stringify({ type: 'definitely-not-a-type' }));
    await sleep(300);
    const h3 = await getHealth();
    assert(h3.extension.version === '9.9.9-test' && h3.extension.protocol === '7',
      'unknown type leaves extInfo alone');

    // [4] disconnect keeps the last-known identity.
    const seenAt2 = h3.extension.seenAt;
    ws.close();
    const h4 = await waitFor((h) => h.clients === 0, 'client disconnected');
    assert(h4.clients === 0, 'clients back to 0 after close');
    assert(h4.extension.version === '9.9.9-test', 'last-known version kept after disconnect');

    // [5] old-style empty hello (pre-1.2.11) resets fields to null.
    await sleep(10); // ensure seenAt strictly advances past the previous hello
    ws = await wsConnect();
    ws.send(JSON.stringify({ type: 'hello' }));
    const h5 = await waitFor((h) => h.extension.version === null, 'empty hello resets version');
    assert(h5.extension.version === null, 'empty hello -> version null (old extension)');
    assert(h5.extension.protocol === null, 'empty hello -> protocol null (old extension)');
    assert(h5.extension.seenAt > seenAt2, 'empty hello refreshes seenAt');
    ws.close();

    // [6] end-to-end: a relay `result` must forward blockedFeatures to the
    // /api/chat caller (P0-fix guard at the HTTP boundary — the extension-side
    // hops are pinned by tools/test-bridge-fields.js).
    ws = await wsConnect();
    const chatRes = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ message: 'field-chain probe', timeoutMs: 8000 });
      const req = http.request(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      // The relay pushes the chat over WS; answer it exactly like the fixed
      // extension does — a result carrying blockedFeatures.
      ws.on('message', (data) => {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'chat' && m.id) {
            ws.send(JSON.stringify({
              type: 'result',
              id: m.id,
              markdown: 'probe reply',
              attachments: [],
              failed: [],
              blockedFeatures: [{ name: 'file_upload', resetsAfter: '2030-01-01T00:00:00Z', description: 'probe quota block' }]
            }));
          }
        } catch (e) {}
      });
      req.end(body);
    });
    assert(chatRes.ok === true, 'end-to-end probe resolves ok');
    assert(chatRes.markdown === 'probe reply', 'end-to-end: markdown forwarded');
    assert(Array.isArray(chatRes.blockedFeatures) && chatRes.blockedFeatures.length === 1 &&
      chatRes.blockedFeatures[0].name === 'file_upload',
      'end-to-end: blockedFeatures forwarded through /api/chat');
    ws.close();

    // [7] audit F1 + tester re-check (2026-09-18): the wall is INCLUSIVE.
    // The first cut used `> 10000` and its two test points (10,001 / 9,999)
    // both sat ONE STEP OUTSIDE the boundary — zero information about the
    // boundary itself, so exactly-10,000 sailed through to die in the
    // browser. Both points now sit ON the boundary: 10,000 -> 413, and 9,999
    // -> falls through the guard (reaching the no-extension 503, NOT 413).
    // Note the 413 fires BEFORE the no-client gate, so no ws is needed.
    const wallRes = await postChat(BASE, { message: 'x'.repeat(10000), timeoutMs: 5000 });
    assert(wallRes.status === 413, 'composer wall: exactly 10000 chars -> 413 (boundary is >=)');
    assert(wallRes.json.ok === false && /composer/i.test(wallRes.json.error || ''),
      'composer wall: error names the composer limit, not "empty composer"');
    const passRes = await postChat(BASE, { message: 'y'.repeat(9999), timeoutMs: 5000 });
    assert(passRes.status === 503,
      'composer wall: 9999 chars passes the guard (no-extension 503, not 413)');

    // [8] v1.2.12 clamp behavior — the audit used it to fingerprint the stale
    // relay: timeoutMs=1 must be clamped to 5s so a fast extension reply WINS
    // over the timer instead of a 1ms fake timeout. (Unclamped: the 1ms timer
    // always resolves first with ok:false.)
    ws = await wsConnect();
    const clampRes = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ message: 'clamp probe', timeoutMs: 1 });
      const req = http.request(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      ws.on('message', (data) => {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'chat' && m.id) {
            ws.send(JSON.stringify({ type: 'result', id: m.id, markdown: 'clamp ok', attachments: [], failed: [], blockedFeatures: [] }));
          }
        } catch (e) {}
      });
      req.end(body);
    });
    assert(clampRes.ok === true && clampRes.markdown === 'clamp ok',
      'timeoutMs=1 is clamped: a fast reply beats the timer (no 1ms fake timeout)');
    ws.close();

    // [9] audit F3: the heartbeat keeps live clients (browsers auto-pong at
    // the protocol level) and terminates sockets that stop answering — a
    // simulated half-open (socket paused -> pings never processed -> no
    // pongs) must be kicked instead of sitting green forever.
    const hb = await wsConnect();
    await sleep(700); // ~3 heartbeat periods at BRIDGE_HEARTBEAT_MS=200
    assert((await getHealth()).clients === 1, 'heartbeat: live client survives 3+ ping cycles');
    if (hb._socket && typeof hb._socket.pause === 'function') {
      hb._socket.pause(); // stop reading -> pings pile up unprocessed -> no pongs
      const hbDead = await waitFor((h) => h.clients === 0, 'heartbeat terminates a silent socket');
      assert(hbDead.clients === 0, 'heartbeat: socket that stops answering is terminated');
    } else {
      hb.terminate();
      await waitFor((h) => h.clients === 0, 'socket disconnected');
      console.log('  (i) ws internals unavailable for half-open simulation; fell back to terminate');
    }

    // [10] tester re-check (2026-09-18): BRIDGE_COMPOSER_LIMIT=abc used to
    // NaN the guard into silence (Number('abc')=NaN, `length > NaN` is always
    // false) — a typo disabled the wall with zero feedback. Now: loud startup
    // warning + fallback to the default wall. Spawn a second relay on :8798
    // with the poisoned env and prove both.
    const badChild = spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js')], {
      env: { ...process.env, PORT: '8798', BRIDGE_COMPOSER_LIMIT: 'abc' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const badLogs = [];
    badChild.stdout.on('data', (c) => badLogs.push(String(c)));
    badChild.stderr.on('data', (c) => badLogs.push(String(c)));
    try {
      let wall2 = null;
      const t0 = Date.now();
      for (;;) {
        try {
          wall2 = await postChat('http://127.0.0.1:8798', { message: 'x'.repeat(10000), timeoutMs: 1000 });
          break;
        } catch (e) {
          if (Date.now() - t0 > 6000) throw new Error('bad-env relay never came up: ' + (e.message || e));
          await sleep(100);
        }
      }
      assert(wall2.status === 413,
        'bad env (BRIDGE_COMPOSER_LIMIT=abc): guard falls back to default, 10000 -> 413');
      assert(badLogs.join('').includes('ignoring invalid BRIDGE_COMPOSER_LIMIT'),
        'bad env value logs a loud startup warning');
    } finally {
      try { badChild.kill(); } catch (e) {}
    }

    console.log(`\ntest-health: ${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.error('relay logs:\n' + logs.join(''));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`test-health: ERROR ${err && err.message}`);
    console.error('relay logs:\n' + logs.join(''));
    process.exitCode = 1;
  } finally {
    clearTimeout(killTimer);
    try { child.kill(); } catch (e) {}
  }
}

main();
