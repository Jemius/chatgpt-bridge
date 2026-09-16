// Unit test for the artifact-capture target selection in extension/content.js
// (N-1 fix: one file card can surface as two distinct buttons, and cards
// inside a user message are the caller's own uploads).
//
// The functions live inside an IIFE, so we slice the real source out of the
// file and eval it — this tests the SHIPPED code, not a copy of it.
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../extension/content.js');
const full = fs.readFileSync(SRC, 'utf8');

const head = '  // Resolve an artifact card\'s display filename';
const tailMarker = '  // Serialize requests';
const start = full.indexOf(head);
const end = full.indexOf(tailMarker);
if (start < 0 || end < 0) throw new Error('could not locate the artifact block in content.js');

const slice = full.slice(start, end);
const harness = slice + '\nreturn { artifactFilename, isUserArtifact, collectArtifactTargets };';
const api = new Function(harness)();

// ---- fake DOM nodes --------------------------------------------------------
// getAttribute/closest/textContent are the only members the shipped code uses.
function fakeBtn(label, text, inUser) {
  return {
    getAttribute: (k) => (k === 'aria-label' ? label : null),
    textContent: text || '',
    closest: (sel) => (inUser && sel === '[data-message-author-role="user"]' ? {} : null)
  };
}

// ---- cases -----------------------------------------------------------------
const cases = [
  {
    name: 'N-1: one file surfaced as two buttons (same aria-label) -> one target',
    nodes: [fakeBtn('checkpoint.md', '', false), fakeBtn('checkpoint.md', '', false)],
    expect: ['checkpoint.md']
  },
  {
    name: 'N-1: chip with aria-label + card with only .md text -> one target',
    nodes: [fakeBtn('checkpoint.md', '', false), fakeBtn('', 'checkpoint.md', false)],
    expect: ['checkpoint.md']
  },
  {
    name: 'two distinct files -> two targets, first-seen order kept',
    nodes: [fakeBtn('a.md', '', false), fakeBtn('b.md', '', false)],
    expect: ['a.md', 'b.md']
  },
  {
    name: 'N-1: card inside a user message (own upload) is excluded',
    nodes: [fakeBtn('upload-sample(1).md', '', true), fakeBtn('generated.md', '', false)],
    expect: ['generated.md']
  },
  {
    name: 'nameless button keeps a generic-name target (never silently dropped)',
    nodes: [fakeBtn('', '打开文档', false)],
    expect: ['document.md']
  }
];

let pass = 0, fail = 0;
for (const c of cases) {
  let got, err = null;
  try { got = api.collectArtifactTargets(c.nodes, api).map((t) => t.filename); } catch (e) { err = e; }
  const ok = !err && JSON.stringify(got) === JSON.stringify(c.expect);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!ok) {
    console.log('        expected: ' + JSON.stringify(c.expect));
    console.log('        actual  : ' + JSON.stringify(err ? 'THREW ' + err.message : got));
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
