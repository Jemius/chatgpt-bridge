// chatgpt-bridge · test-bridge-fields.js
//
// Field-chain assertions: every hop of the pipeline must forward the fields
// the caller depends on. This is the structural fix for the P0 found by the
// 2026-09-17 external audit: injected.js → content.js both carried
// `blockedFeatures`, but background.js:227-234 rebuilt the result object
// WITHOUT it, so the relay/MCP always saw []. Each hop below is anchored to
// the exact construction site, so dropping the field anywhere breaks the test.
//
// Also guards version-source consistency: package.json = manifest.json =
// package-lock.json (they drifted once: lock said 1.0.0 while the rest said
// 1.2.x), and the MCP serverInfo must read PKG.version instead of a literal.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failures.push(label); console.log(`FAIL  ${label}`); }
}

// ---- blockedFeatures field chain (N-14), hop by hop -------------------------

const chain = [
  ['injected.js flush payload carries blockedFeatures',
   'extension/injected.js',
   /blockedFeatures:\s*entry\.blockedFeatures\s*\|\|\s*\[\]/],

  ['content.js return body carries blockedFeatures',
   'extension/content.js',
   /blockedFeatures:\s*net\.blockedFeatures\s*\|\|\s*\[\]/],

  ['background.js result response forwards blockedFeatures (P0 fix)',
   'extension/background.js',
   /respond\(msg\.id,\s*\{[\s\S]{0,800}?blockedFeatures:\s*\(r\s*&&\s*r\.blockedFeatures\)/],

  ['relay result assembly forwards blockedFeatures',
   'relay/server.js',
   /blockedFeatures:\s*msg\.blockedFeatures\s*\|\|\s*\[\]/],

  ['mcp callChatgpt return carries blockedFeatures',
   'mcp/index.js',
   /blockedFeatures:\s*Array\.isArray\(data\.blockedFeatures\)/],

  ['mcp tools/call output carries blockedFeatures',
   'mcp/index.js',
   /blockedFeatures:\s*r\.blockedFeatures\s*\|\|\s*\[\]/],
];

for (const [label, file, re] of chain) {
  assert(re.test(read(file)), label);
}

// ---- version visibility chain (v1.2.11+ / v1.2.12) -------------------------

const mcpSrc = read('mcp/index.js');
assert(/serverInfo:\s*\{\s*name:\s*'chatgpt-bridge',\s*version:\s*PKG\.version\s*\}/.test(mcpSrc),
  'mcp serverInfo version comes from package.json (no hardcoded drift)');
assert(/relayVersion,\s*\n\s*extension,\s*\n\s*driftWarning/.test(mcpSrc) &&
  /data && data\.relay && data\.relay\.version/.test(mcpSrc) && /data && data\.extension/.test(mcpSrc),
  'mcp status forwards relayVersion + extension identity from /health');
assert(/driftWarning/.test(mcpSrc) && /version drift:/.test(mcpSrc) &&
  /did not report a version/.test(mcpSrc) && /no extension has connected/.test(mcpSrc),
  'mcp status reports version drift — incl. null-version and never-connected extensions (R5/R6)');
// v1.2.18 (tester round 4, D1): the warning must key off the RELAY-AXIS wire
// protocol numbers, not semver — a pure version difference between
// wire-compatible builds is a false alarm (live instance: relay 1.2.16 vs
// extension 1.2.17). The wire numbers exist on both sides and the mcp compares
// them; equal numbers + different versions degrade to versionNotice.
assert(/wire protocol MISMATCH/.test(mcpSrc) && /wireProtocol/.test(mcpSrc) &&
  /versionNotice/.test(mcpSrc) && /informational only, no restart required/.test(mcpSrc),
  'mcp drift warning keys off wire protocol numbers; equal-number version drift degrades to versionNotice (D1)');
assert(/BRIDGE_WIRE_PROTOCOL\s*=\s*1/.test(read('extension/background.js')) &&
  /type: 'hello'.*wireProtocol: BRIDGE_WIRE_PROTOCOL/.test(read('extension/background.js')),
  'extension hello carries the relay-axis wireProtocol number (BRIDGE_WIRE_PROTOCOL)');
// v1.2.18 (D1): behavioral test of evaluateDrift — slice the real function out
// of mcp/index.js and eval it (same pattern as isLoopbackHost above), so the
// JUDGMENT is pinned, not just the presence of the strings. The first case is
// the live false alarm from the tester's round 4: relay 1.2.16 + extension
// 1.2.17, frames byte-identical — the old semver comparison flagged it, the
// number comparison must stay silent (versionNotice only).
const driftMatch = mcpSrc.match(/function evaluateDrift\(data\) \{[\s\S]*?\n\}/);
assert(!!driftMatch, 'evaluateDrift found in mcp/index.js (pure, sliceable decision core)');
if (driftMatch) {
  const evaluateDrift = new Function(`return (${driftMatch[0]});`)();
  const a = evaluateDrift({ relay: { version: '1.2.16', wireProtocol: 1 }, extension: { version: '1.2.17', wireProtocol: '1' }, clients: 1 });
  assert(a.driftWarning === undefined && /informational only/.test(a.versionNotice || ''),
    'D1 live false alarm now silent: wire numbers match (1 == "1"), versions differ -> versionNotice only');
  const b = evaluateDrift({ relay: { version: '1.2.18', wireProtocol: 2 }, extension: { version: '1.2.18', wireProtocol: '1' }, clients: 1 });
  assert(/wire protocol MISMATCH/.test(b.driftWarning || ''),
    'wire number mismatch -> hard warning even with EQUAL versions (semver cannot do this)');
  const c = evaluateDrift({ relay: { version: '1.2.16' }, extension: { version: '1.2.18', wireProtocol: '1' }, clients: 1 });
  assert(/predates wire-protocol tagging/.test(c.driftWarning || ''),
    'old relay (no wire number) + version drift -> upgrade hint, not an incompatibility claim');
  const d = evaluateDrift({ relay: { version: '1.2.18', wireProtocol: 1 }, extension: { version: '1.2.17' }, clients: 1 });
  assert(/did not report a wire protocol/.test(d.driftWarning || ''),
    'old extension (no wire number) + version drift -> reload hint');
  const e = evaluateDrift({ relay: { version: '1.2.18', wireProtocol: 1 }, extension: { version: null, wireProtocol: '1' }, clients: 1 });
  assert(/did not report a version/.test(e.driftWarning || ''),
    'null extension version -> R5 warning (pre-1.2.11, unidentifiable)');
  const f = evaluateDrift({ relay: { version: '1.2.18', wireProtocol: 1 }, extension: null, clients: 0 });
  assert(/no extension has connected/.test(f.driftWarning || ''),
    'never-connected -> R5 "load the extension" hint');
  const g = evaluateDrift({ relay: { version: '1.2.18', wireProtocol: 1 }, extension: { version: '1.2.18', wireProtocol: '1' }, clients: 1 });
  assert(g.driftWarning === undefined && g.versionNotice === undefined,
    'identical builds: no warning, no notice');
}

// Version sources must agree: package.json, manifest.json, package-lock.json.
const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('extension/manifest.json'));
const lock = JSON.parse(read('package-lock.json'));
assert(pkg.version === manifest.version,
  `package.json (${pkg.version}) === manifest.json (${manifest.version})`);
assert(pkg.version === lock.packages[''].version,
  `package.json (${pkg.version}) === package-lock.json (${lock.packages[''].version})`);

// ---- relay loopback matcher (audit F5) --------------------------------------
// The two loopback checks must share ONE matcher that accepts the whole 127/8
// range: the old pair enabled Host validation for HOST=127.0.0.2 but then
// rejected every Host header it produced (self-lockout). Slice the real
// function out of server.js and eval it, so the behavior — not a copy — is
// what gets tested.
const serverSrc = read('relay/server.js');
assert(/RELAY_WIRE_PROTOCOL\s*=\s*1/.test(serverSrc) &&
  /relay: \{ version: RELAY_VERSION, wireProtocol: RELAY_WIRE_PROTOCOL \}/.test(serverSrc) &&
  /wireProtocol: msg\.wireProtocol == null \? null : String\(msg\.wireProtocol\)/.test(serverSrc),
  'relay exposes its wire protocol in /health and records the extension-reported number (D1)');
const fnMatch = serverSrc.match(/function isLoopbackHost\(host\) \{[\s\S]*?\n\}/);
assert(!!fnMatch, 'isLoopbackHost found in relay/server.js');
assert(/const HOST_IS_LOOPBACK = isLoopbackHost\(HOST\);/.test(serverSrc),
  'HOST_IS_LOOPBACK reuses isLoopbackHost (single source, audit F5)');
if (fnMatch) {
  const isLoopbackHost = new Function(`return (${fnMatch[0]});`)();
  assert(isLoopbackHost('127.0.0.1:8742') === true, 'loopback: 127.0.0.1:8742 accepted');
  assert(isLoopbackHost('127.0.0.2:8742') === true, 'loopback: 127.0.0.2:8742 accepted (whole 127/8, F5)');
  assert(isLoopbackHost('localhost:8742') === true, 'loopback: localhost:8742 accepted');
  assert(isLoopbackHost('[::1]:8742') === true, 'loopback: [::1]:8742 accepted');
  assert(isLoopbackHost('evil.com') === false, 'loopback: evil.com rejected');
  assert(isLoopbackHost('127.0.0.1.evil.com') === false, 'loopback: DNS-rebinding variant rejected');
  assert(isLoopbackHost('') === false && isLoopbackHost(undefined) === false,
    'loopback: empty/undefined rejected');
}

console.log(`\ntest-bridge-fields: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
