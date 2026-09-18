// chatgpt-bridge · diagnostic harness
//
// Sends a chat request with `debug: true` and analyses the RAW captured SSE
// stream that comes back, so the capture/merge pipeline can be diagnosed from
// real data instead of guesswork.
//
// What it answers:
//   - which `o` ops actually appear on the wire (append / add / replace / set / patch)?
//   - which ops carry text, and how much?
//   - what does "collect only o=append" produce (= the OLD parser's behaviour)?
//   - what does an op-aware merge produce (= the intended behaviour)?
//   - does either match the reply that was actually returned?
//
// Usage:
//   node tools/ask-debug.js <message-file> [timeoutMs] [conversation]
//   node tools/ask-debug.js message.txt
//
// Requires the extension to be reloaded AND the ChatGPT tab refreshed (see
// README Troubleshooting, protocol-version handshake), otherwise `rawSample`
// is never returned.
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const timeoutMs = Number(process.argv[3] || 180000);
const conversation = process.argv[4] || 'new';
const RELAY = process.env.BRIDGE_RELAY || 'http://127.0.0.1:8742';

// The content path that holds the assistant's text.
const CONTENT_PATH = /^\/message\/content\/parts\/(\d+)$/;

function analyse(raw) {
  const lines = raw.split('\n');
  const ops = {};
  const paths = {};
  const writes = []; // { p, o, v } for content-path writes, in arrival order
  let badJson = 0;
  let dataLines = 0;

  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.o) ops[o.o] = (ops[o.o] || 0) + 1;
    if (typeof o.p === 'string' && o.p) paths[o.p] = (paths[o.p] || 0) + 1;
    if (CONTENT_PATH.test(o.p || '') && typeof o.v === 'string') {
      writes.push({ p: o.p, o: o.o || '(none)', v: o.v });
    }
    if (o.o === 'patch' && Array.isArray(o.v)) { o.v.forEach(walk); return; }
    if (o.v && typeof o.v === 'object') walk(o.v);
    if (o.message) walk(o.message);
  };

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('data:')) { line = line.slice(5).trim(); dataLines++; }
    if (line === '[DONE]') { ops['[DONE]'] = (ops['[DONE]'] || 0) + 1; continue; }
    let obj;
    try { obj = JSON.parse(line); } catch (e) { badJson++; continue; }
    walk(obj);
  }

  // (a) what the OLD parser produced: only o=append, then joined.
  const appendOnly = writes.filter((w) => w.o === 'append').map((w) => w.v).join('');

  // (b) what an op-aware merge produces: set/replace/add overwrite the path,
  //     append concatenates.
  const acc = new Map();
  for (const w of writes) {
    const cur = acc.get(w.p) || '';
    if (w.o === 'append') acc.set(w.p, cur + w.v);
    else acc.set(w.p, w.v); // add / replace / set => the value IS the content
  }
  const opAware = [...acc.keys()]
    .sort((a, b) => Number(CONTENT_PATH.exec(a)[1]) - Number(CONTENT_PATH.exec(b)[1]))
    .map((k) => acc.get(k))
    .join('');

  const byOp = {};
  for (const w of writes) {
    byOp[w.o] = byOp[w.o] || { frames: 0, chars: 0 };
    byOp[w.o].frames++;
    byOp[w.o].chars += w.v.length;
  }

  return { dataLines, badJson, ops, paths, writes, byOp, appendOnly, opAware };
}

async function main() {
  if (!file) {
    console.error('usage: node tools/ask-debug.js <message-file> [timeoutMs] [conversation]');
    process.exit(2);
  }
  const message = fs.readFileSync(file, 'utf8');
  console.log('[ask-debug] ' + message.length + ' chars -> ' + RELAY + ' (conversation=' + conversation + ', debug=true)');

  const r = await fetch(RELAY + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, timeoutMs, conversation, debug: true })
  });
  const j = await r.json();
  if (!j.ok) { console.error('[ask-debug] FAILED: ' + j.error); process.exit(1); }

  const md = j.markdown || '';
  console.log('\n=== REPLY (' + md.length + ' chars) ===');
  console.log(md);
  console.log('=== END REPLY ===\n');

  const raw = j.rawSample;
  if (!raw) {
    console.log('!! rawSample was NOT returned.');
    console.log('   The relay always forwards it, so the break is on the extension side:');
    console.log('   either background.js is stale (never forwards `debug`) or content.js is');
    console.log('   stale (never returns `rawSample`). Reload the extension at');
    console.log('   chrome://extensions AND refresh the ChatGPT tab, then retry.');
    console.log('   See README Troubleshooting — an already-open tab keeps the old');
    console.log('   injected.js forever because its MAIN-world guard survives the reload.');
    process.exit(2);
  }

  const out = path.join(__dirname, 'raw-stream.txt');
  fs.writeFileSync(out, raw, 'utf8');
  console.log('raw stream: ' + raw.length + ' chars -> ' + out + '\n');

  const a = analyse(raw);

  console.log('data: lines                ' + a.dataLines);
  console.log('unparseable lines          ' + a.badJson);
  console.log('ops on the wire            ' + JSON.stringify(a.ops));
  console.log('paths                      ' + JSON.stringify(a.paths));
  console.log('content-path writes        ' + a.writes.length);
  console.log('chars per op               ' + JSON.stringify(a.byOp));

  console.log('\nfirst 8 content writes:');
  a.writes.slice(0, 8).forEach((w, i) => console.log('  [' + i + '] o=' + w.o + ' ' + w.p + ' = ' + JSON.stringify(w.v.slice(0, 60))));
  console.log('last 4 content writes:');
  a.writes.slice(-4).forEach((w, i) => console.log('  [' + (a.writes.length - 4 + i) + '] o=' + w.o + ' ' + w.p + ' = ' + JSON.stringify(w.v.slice(0, 60))));

  console.log('\n--- hypothesis test ---');
  console.log('A) append-only merge (OLD parser)  ' + a.appendOnly.length + ' chars');
  console.log('   ' + JSON.stringify(a.appendOnly.slice(0, 200)));
  console.log('B) op-aware merge (intended)       ' + a.opAware.length + ' chars');
  console.log('   ' + JSON.stringify(a.opAware.slice(0, 200)));
  console.log('C) reply actually returned         ' + md.length + ' chars');
  console.log('   ' + JSON.stringify(md.slice(0, 200)));
  console.log('');
  console.log('reply == append-only ? ' + (md === a.appendOnly ? 'YES -> the OLD parser is live' : 'no'));
  console.log('reply == op-aware    ? ' + (md === a.opAware ? 'YES -> the new merge is live' : 'no'));
  console.log('op-aware is complete ? ' + (a.opAware.length > a.appendOnly.length ? 'YES (longer than append-only)' : 'NO'));

  console.log('\ncontains finished_successfully: ' + (raw.indexOf('finished_successfully') >= 0));
  console.log('contains [DONE]:                ' + (raw.indexOf('[DONE]') >= 0));
}

if (require.main === module) {
  main().catch((e) => { console.error('[ask-debug] harness error:', e && e.message); process.exit(2); });
}

// Exported so the stream analyser can be unit-tested without a live ChatGPT.
module.exports = { analyse };
