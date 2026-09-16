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
    env: { ...process.env, PORT: String(PORT) },
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

    // [2] hello with version+protocol is recorded verbatim.
    let ws = await wsConnect();
    await waitFor((h) => h.clients === 1, 'ws client counted');
    assert((await getHealth()).clients === 1, 'clients === 1 after connect');
    ws.send(JSON.stringify({ type: 'hello', version: '9.9.9-test', protocol: '7' }));
    const h2 = await waitFor((h) => h.extension.version === '9.9.9-test', 'hello recorded');
    assert(h2.extension.version === '9.9.9-test', 'hello version recorded');
    assert(h2.extension.protocol === '7', 'hello protocol recorded');
    assert(typeof h2.extension.seenAt === 'number' && h2.extension.seenAt > 0, 'hello seenAt set');

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
