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
  '\nreturn { entryFor, mergeInto, assemble, cleanReplyText, captures };';
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
  },

  // --- N-2: ChatGPT-internal citation markers must not leak into the reply ---
  // Real replies with uploaded files carried `filecite turn0file0 L6-L10`
  // wrapped in private-use sentinel characters; both are stripped at assembly.
  {
    name: 'cleanReplyText: filecite marker with private-use sentinels is stripped',
    clean: '我已读到文件内容，第三点的关键词是「蓝鲸协议」。\uE200filecite\uE204turn0file0\uE202L6-L10\uE201',
    expectClean: '我已读到文件内容，第三点的关键词是「蓝鲸协议」。 '
  },
  {
    name: 'cleanReplyText: plain citation phrase between words is removed',
    clean: 'before filecite turn0file0 L6-L10 after',
    expectClean: 'before after'
  },
  {
    name: 'cleanReplyText: multiple locators stripped, leading text kept',
    clean: 'filecite turn0file0 L6-L10 L12-L20 tail',
    expectClean: ' tail'
  },
  {
    name: 'cleanReplyText: text without citations is untouched',
    clean: 'plain **markdown** — 中文 — stays untouched',
    expectClean: 'plain **markdown** — 中文 — stays untouched'
  },

  // --- N-9: the :::writing canvas directive wrapper must not leak ------------
  // When the answer is produced in document/canvas mode the raw stream wraps
  // the whole text in `:::writing{variant="document" id="…"}` … `:::`.
  {
    name: 'cleanReplyText: :::writing wrapper stripped, body kept',
    clean: ':::writing{variant="document" id="58321"}\n\n# 标题\n\n正文段落。\n\n:::\n',
    expectClean: '\n# 标题\n\n正文段落。\n\n'
  },
  {
    name: 'cleanReplyText: :::writing opening without closing line (truncated stream)',
    clean: ':::writing{variant="document" id="58321"}\n正文开头，流在此被截断。',
    expectClean: '正文开头，流在此被截断。'
  },
  {
    name: 'cleanReplyText: bare ::: line in a reply without :::writing is kept',
    clean: '正常回复。\n\n:::\n\n上面那行是正文自己的分隔线，不是画布包装。',
    expectClean: '正常回复。\n\n:::\n\n上面那行是正文自己的分隔线，不是画布包装。'
  },
  {
    name: 'cleanReplyText: only the FIRST bare ::: after :::writing is consumed',
    clean: ':::writing{variant="document" id="1"}\nA\n\n:::\n\nB\n\n:::\n',
    expectClean: 'A\n\n\nB\n\n:::\n'
  },
  {
    name: 'cleanReplyText: filecite stripped inside a :::writing wrapper',
    clean: ':::writing{variant="document" id="2"}\n我已读到文件。\uE200filecite\uE204turn0file0\uE202L6-L10\uE201\n\n:::\n',
    expectClean: '我已读到文件。 \n\n'
  },

  // --- N-14: ChatGPT-side blocked_features must reach the caller -------------
  // Real sample: attachment quota exhausted, carried inside a metadata frame.
  {
    name: 'blocked_features: quota block inside metadata frame is collected',
    blockedBodies: [
      frame({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, content: { parts: ['好的'] } },
        conversation_detail_metadata: { blocked_features: [
          { name: 'file_upload', resets_after: '2026-09-18T01:03:13Z', description: '你目前已用完附件额度。' }
        ] } } })
    ],
    expectBlocked: [
      { name: 'file_upload', resetsAfter: '2026-09-18T01:03:13Z', description: '你目前已用完附件额度。' }
    ]
  },
  {
    name: 'blocked_features: repeats of the same block collapse to one entry',
    blockedBodies: [
      frame({ p: '', o: 'add', v: { conversation_detail_metadata: { blocked_features: [
        { name: 'file_upload', resets_after: '2026-09-18T01:03:13Z', description: '额度' }
      ] } } }),
      frame({ p: '/conversation/metadata', o: 'replace', v: { blocked_features: [
        { name: 'file_upload', resets_after: '2026-09-18T01:03:13Z', description: '额度' }
      ] } })
    ],
    expectBlocked: [
      { name: 'file_upload', resetsAfter: '2026-09-18T01:03:13Z', description: '额度' }
    ]
  },
  {
    name: 'blocked_features: different names are both kept, text-only frames collect nothing',
    blockedBodies: [
      frame({ p: '', o: 'add', v: { conversation_detail_metadata: { blocked_features: [
        { name: 'file_upload', resets_after: 'T1', description: 'a' },
        { name: 'code_interpreter', resets_after: 'T2', description: 'b' }
      ] } } }),
      deltas(['1,2,3'])
    ],
    expectBlocked: [
      { name: 'file_upload', resetsAfter: 'T1', description: 'a' },
      { name: 'code_interpreter', resetsAfter: 'T2', description: 'b' }
    ]
  }
];

let pass = 0, fail = 0;
for (const c of cases) {
  let got, err = null;
  try {
    if ('clean' in c) got = api.cleanReplyText(c.clean);
    else if ('blockedBodies' in c) {
      // Feed the bodies, then compare the blockedFeatures collected on the
      // entry itself (N-14) — they travel on the entry, not through assemble.
      const id = 'req-test-' + Math.random().toString(36).slice(2, 8);
      const entry = api.entryFor(id);
      for (const b of c.blockedBodies) api.mergeInto(entry, b);
      got = JSON.stringify(entry.blockedFeatures || []);
    }
    else got = run(c.bodies);
  } catch (e) { err = e; }
  const expected = 'clean' in c ? c.expectClean
    : ('blockedBodies' in c ? JSON.stringify(c.expectBlocked) : c.expect);
  const ok = !err && got === expected;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!ok) {
    console.log('        expected: ' + JSON.stringify(expected));
    console.log('        actual  : ' + JSON.stringify(err ? 'THREW ' + err.message : got));
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
