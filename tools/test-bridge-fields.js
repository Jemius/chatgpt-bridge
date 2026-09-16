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
assert(/relayVersion:\s*\(data && data\.relay && data\.relay\.version\)\s*\|\|\s*null/.test(mcpSrc),
  'mcp status forwards relayVersion from /health');
assert(/extension:\s*\(data && data\.extension\)\s*\|\|\s*null/.test(mcpSrc),
  'mcp status forwards extension identity from /health');

// Version sources must agree: package.json, manifest.json, package-lock.json.
const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('extension/manifest.json'));
const lock = JSON.parse(read('package-lock.json'));
assert(pkg.version === manifest.version,
  `package.json (${pkg.version}) === manifest.json (${manifest.version})`);
assert(pkg.version === lock.packages[''].version,
  `package.json (${pkg.version}) === package-lock.json (${lock.packages[''].version})`);

console.log(`\ntest-bridge-fields: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
