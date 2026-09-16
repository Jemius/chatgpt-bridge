// Unit test for the reply-parsing logic in extension/injected.js.
//
// The functions live inside an IIFE, so we slice the real source out of the file
// and eval it with the minimum surrounding state — this tests the SHIPPED code,
// not a copy of it.
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../extension/injected.js');
const full = fs.readFileSync(SRC, 'utf8');

const head = '  function entryFor(reqId) {';
const tailMarker = '  // Poll for the content script\'s "watch" instruction';
const start = full.indexOf(head);
const end = full.indexOf(tailMarker);
if (start < 0 || end < 0) throw new Error('could not locate the parser block in injected.js');

const slice = full.slice(start, end);
global.document = { documentElement: { setAttribute() {}, getAttribute() { return null; }, removeAttribute() {} } };
global.window = global;

const harness = 'let watching = null;\nconst captures = new Map();\n' + slice +
  '\nreturn { entryFor, mergeInto, assemble, captures };';
const api = new Function(harness)();

// ---- helpers ---------------------------------------------------------------
function frame(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }

function delta(text) {
  let s = frame({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, content: { parts: [''] } } } });
  for (const ch of text) s += frame({ p: '/message/content/parts/0', o: 'append', v: ch });
  return s;
}
function deltas(chunks) {
  let s = '';
  for (const c of chunks) s += frame({ p: '/message/content/parts/0', o: 'append', v: c });
  return s;
}
function snapshots(values) {
  let s = '';
  for (const v of values) s += frame({ p: '/message/content/parts/0', o: 'replace', v });
  return s;
}
function messageEvent(text) {
  return frame({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, content: { parts: [text] } } } });
}

// Feed one or more response bodies for a single request id, then assemble.
function run(bodies) {
  const id = 'req-test-' + Math.random().toString(36).slice(2, 8);
  const entry = api.entryFor(id);
  for (const b of bodies) api.mergeInto(entry, b);
  return api.assemble(entry);
}

// ---- cases -----------------------------------------------------------------
const FULL30 = Array.from({ length: 30 }, (_, i) => i + 1).join(',');

const cases = [
  {
    name: 'per-char delta stream -> full text',
    bodies: [delta(FULL30)],
    expect: FULL30
  },
  {
    name: 'chunked delta stream -> full text',
    bodies: [deltas(FULL30.match(/.{1,3}/g))],
    expect: FULL30
  },
  {
    name: 'snapshot (replace) stream -> last snapshot',
    bodies: [snapshots(['1', '1,2', '1,2,3', FULL30])],
    expect: FULL30
  },
  {
    name: 'THE ORIGINAL BUG: 3 bodies, answer continues in a follow-up',
    bodies: [delta('1,2,3'), deltas([',4', ',5', ',6', ',7'])],
    expect: '1,2,3,4,5,6,7'
  },
  {
    name: 'follow-up body re-sends the whole message (must not duplicate)',
    bodies: [delta('1,2,3'), deltas(['1,2,3', ',4', ',5'])],
    expect: '1,2,3,4,5'
  },
  {
    name: 'follow-up body restarts from scratch with replace',
    bodies: [snapshots(['1,2', '1,2,3']), snapshots(['1,2,3,4', '1,2,3,4,5'])],
    expect: '1,2,3,4,5'
  },
  {
    name: 'whole-message fallback only (no path writes)',
    bodies: [messageEvent('hello')],
    expect: 'hello'
  },
  {
    name: 'fallback snapshot longer than path writes -> snapshot wins',
    bodies: [deltas(['hel', 'lo']), messageEvent('hello world')],
    expect: 'hello world'
  },
  {
    name: 'multi-part content -> parts joined in index order',
    bodies: [frame({ p: '/message/content/parts/0', o: 'append', v: 'AAA' }),
             frame({ p: '/message/content/parts/1', o: 'append', v: 'BBB' })],
    expect: 'AAABBB'
  },
  {
    name: 'duplicate frames are ignored',
    bodies: [deltas(['ab', 'ab', 'cd'])],
    expect: 'abcd'
  },
  {
    name: 'markdown with newlines and unicode survives',
    bodies: [deltas(['- **① 结论**', '\n', '中文段落。', '\n', '```js', '\nlet a=1;', '\n```'])],
    expect: '- **① 结论**\n中文段落。\n```js\nlet a=1;\n```'
  },
  {
    name: 'no assistant content at all -> null',
    bodies: [frame({ p: '', o: 'add', v: { message: { author: { role: 'user' }, content: { parts: ['hi'] } } } })],
    expect: null
  },

  // --- delta_encoding "v1" (shape of the real captured stream, 2026-09) ------
  // ChatGPT declares `event: delta_encoding / data: "v1"`: a frame with only
  // `v` inherits p/o from the last frame that carried an operation. Frames
  // carrying `type` are event notifications and must never inherit.
  {
    name: 'delta_encoding v1: bare {"v":...} frames inherit p/o from last op frame',
    bodies: [
      frame({ p: '/message/content/parts/0', o: 'append', v: '1,2,3,' }) +
      frame({ v: '4,5,6,7,' }) +
      frame({ v: '8,9,10,11,12,13,14,15,' }) +
      frame({ p: '', o: 'patch', v: [
        { p: '/message/content/parts/0', o: 'append', v: '16,17,18,19,20,21,22,23,24,25,26,27,28,29,30' },
        { p: '/message/status', o: 'replace', v: 'finished_successfully' },
        { p: '/message/end_turn', o: 'replace', v: true }
      ] })
    ],
    expect: FULL30
  },
  {
    name: 'delta_encoding v1: bare frames continue across response bodies',
    bodies: [
      frame({ p: '/message/content/parts/0', o: 'append', v: '1,2,3,' }) + frame({ v: '4,5,' }),
      frame({ v: '6,7,8' })
    ],
    expect: '1,2,3,4,5,6,7,8'
  },
  {
    name: 'delta_encoding v1: event frames (type field) never inherit p/o',
    bodies: [
      frame({ p: '/message/content/parts/0', o: 'append', v: 'A' }) +
      frame({ type: 'message_marker', conversation_id: 'x', marker: 'user_visible_token' }) +
      frame({ type: 'synthetic_event', v: 'SHOULD_NOT_APPEAR' }) +
      frame({ v: 'B' })
    ],
    expect: 'AB'
  },
  {
    name: '"add" on a content path is a set (JSON-Patch), not an append',
    bodies: [
      frame({ p: '/message/content/parts/0', o: 'append', v: '1,2,3' }) +
      frame({ p: '/message/content/parts/0', o: 'add', v: '9,9' })
    ],
    expect: '9,9'
  },
  {
    name: 'conflicting fallback snapshot clearly longer -> snapshot wins (no prefix gate)',
    bodies: [
      frame({ p: '/message/content/parts/0', o: 'append', v: '29,30' }),
      messageEvent(FULL30)
    ],
    expect: FULL30
  }
];

let pass = 0, fail = 0;
for (const c of cases) {
  let got, err = null;
  try { got = run(c.bodies); } catch (e) { err = e; }
  const ok = !err && got === c.expect;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!ok) {
    console.log('        expected: ' + JSON.stringify(c.expect));
    console.log('        actual  : ' + JSON.stringify(err ? 'THREW ' + err.message : got));
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
