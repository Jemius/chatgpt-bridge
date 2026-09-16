// Unit tests for extension/content.js artifact capture:
//   - N-1: capture-target selection (dedup by filename, skip own uploads)
//   - N-7: click-bound canvas reading (stale canvases never shadow a capture)
//
// The functions live inside an IIFE, so we slice the real source out of the
// file and eval it — this tests the SHIPPED code, not a copy of it.
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../extension/content.js');
const full = fs.readFileSync(SRC, 'utf8');

const head = '  // ---------- HTML -> Markdown ----------';
const tailMarker = '  // Serialize requests';
const start = full.indexOf(head);
const end = full.indexOf(tailMarker);
if (start < 0 || end < 0) throw new Error('could not locate the capture block in content.js');

const slice = full.slice(start, end);

// Controllable fake DOM: `canvases` is what document.querySelectorAll returns
// for the Canvas editor selector; `cards` is what it returns for the artifact
// card selector (N-15). Each entry is a minimal node that the real
// extractMarkdown can walk (a single text child).
const canvases = [];
const cards = [];
global.document = {
  querySelectorAll: (sel) => (sel === 'div.ProseMirror.markdown'
    ? canvases
    : (sel === 'button[aria-label$=".md"], button[class*="peer/open-file"]' ? cards : []))
};

const harness = 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n' + slice +
  '\nreturn { artifactFilename, isUserArtifact, collectArtifactTargets, snapshotCanvases, waitForCanvasMarkdown, snapshotArtifactCards, captureArtifacts };';
const api = new Function(harness)();

// ---- fake nodes ------------------------------------------------------------
function fakeBtn(label, text, inUser) {
  return {
    getAttribute: (k) => (k === 'aria-label' ? label : null),
    textContent: text || '',
    closest: (sel) => (inUser && sel === '[data-message-author-role="user"]' ? {} : null),
    clicks: 0,
    click() { this.clicks++; }
  };
}
function fakeCanvas(text) {
  return { classList: { contains: (c) => c === 'markdown' }, childNodes: [{ nodeType: 3, textContent: text }] };
}

// ---- N-1 target-selection cases --------------------------------------------
const targetCases = [
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
  },
  {
    name: 'N-19: aria-label card + a link whose text is 「下载 x.md」 -> ONE target',
    nodes: [fakeBtn('x.md', '', false), fakeBtn('', '下载 x.md', false)],
    expect: ['x.md']
  },
  {
    name: 'N-19: english UI link text "Download x.md" -> ONE target',
    nodes: [fakeBtn('', 'Download x.md', false)],
    expect: ['x.md']
  },
  {
    name: 'N-19: observed shape - aria-label v129-hist.md + text 「下载 v129-hist.md」 -> ONE target',
    nodes: [fakeBtn('v129-hist.md', '', false), fakeBtn('', '下载 v129-hist.md', false)],
    expect: ['v129-hist.md']
  }
];

// ---- N-7 click-bound reading cases ------------------------------------------
// `setup` arranges the canvases BEFORE the snapshot (= before the click);
// `afterSnapshot` mutates them after the snapshot (= after the click).
// expect '' means "nothing qualified" (an honest timeout).
const canvasCases = [
  {
    name: 'N-7: stale canvas from a previous request is never returned',
    setup: () => { canvases.length = 0; canvases.push(fakeCanvas('STALE-FIRST-REQUEST')); },
    expect: ''
  },
  {
    name: 'N-7: reused canvas node whose content changes -> new content accepted',
    setup: () => { canvases.length = 0; canvases.push(fakeCanvas('STALE')); },
    afterSnapshot: () => { canvases[0].childNodes[0].textContent = 'SECOND-FILE-CONTENT'; },
    expect: 'SECOND-FILE-CONTENT'
  },
  {
    name: 'N-7: new canvas node appearing after the click -> accepted',
    setup: () => { canvases.length = 0; canvases.push(fakeCanvas('STALE')); },
    afterSnapshot: () => { canvases.push(fakeCanvas('NEW-NODE-CONTENT')); },
    expect: 'NEW-NODE-CONTENT'
  },
  {
    name: 'N-7: no canvas before the click, one appears after -> accepted',
    setup: () => { canvases.length = 0; },
    afterSnapshot: () => { canvases.push(fakeCanvas('FRESH')); },
    expect: 'FRESH'
  }
];

// ---- N-15 submit-bound card selection cases ---------------------------------
// Each `run` arranges the fake DOM itself: cards added before
// api.snapshotArtifactCards() are "from earlier turns" (must be skipped and
// never clicked); cards added after it are this reply's artifacts.
const CARD_SEL = 'button[aria-label$=".md"], button[class*="peer/open-file"]';
const n15Cases = [
  {
    name: 'N-15: pre-submit cards are skipped and never clicked; new card is captured',
    run: async () => {
      cards.length = 0; canvases.length = 0;
      const old = fakeBtn('old.md', '', false);
      cards.push(old);
      const before = api.snapshotArtifactCards();
      const fresh = fakeBtn('fresh.md', '', false);
      fresh.click = function () { this.clicks++; canvases.push(fakeCanvas('FRESH-CONTENT')); };
      cards.push(fresh);
      const { attachments, failed } = await api.captureArtifacts(1000, before);
      return JSON.stringify({ attachments, failed, oldClicks: old.clicks, freshClicks: fresh.clicks });
    },
    expect: JSON.stringify({
      attachments: [{ filename: 'fresh.md', content: 'FRESH-CONTENT' }],
      failed: [], oldClicks: 0, freshClicks: 1
    })
  },
  {
    name: 'N-15: without a snapshot (legacy single-turn path) pre-existing cards are still captured',
    run: async () => {
      cards.length = 0; canvases.length = 0;
      const old = fakeBtn('old.md', '', false);
      old.click = function () { this.clicks++; canvases.push(fakeCanvas('OLD-CONTENT')); };
      const fresh = fakeBtn('fresh.md', '', false);
      fresh.click = function () { this.clicks++; canvases.push(fakeCanvas('FRESH-CONTENT')); };
      cards.push(old, fresh);
      const { attachments } = await api.captureArtifacts(1000);
      return JSON.stringify({ names: attachments.map((a) => a.filename), oldClicks: old.clicks, freshClicks: fresh.clicks });
    },
    expect: JSON.stringify({ names: ['old.md', 'fresh.md'], oldClicks: 1, freshClicks: 1 })
  },
  {
    name: 'N-15: same-named card regenerated after submit is still captured (node-identity key)',
    run: async () => {
      cards.length = 0; canvases.length = 0;
      const prev = fakeBtn('report.md', '', false);
      cards.push(prev);
      const before = api.snapshotArtifactCards();
      const regen = fakeBtn('report.md', '', false);
      regen.click = function () { this.clicks++; canvases.push(fakeCanvas('REGENERATED-CONTENT')); };
      cards.push(regen);
      const { attachments, failed } = await api.captureArtifacts(1000, before);
      return JSON.stringify({ attachments, failed, prevClicks: prev.clicks, regenClicks: regen.clicks });
    },
    expect: JSON.stringify({
      attachments: [{ filename: 'report.md', content: 'REGENERATED-CONTENT' }],
      failed: [], prevClicks: 0, regenClicks: 1
    })
  },
  {
    name: 'N-15: continued conversation with no new cards -> empty result, zero clicks',
    run: async () => {
      cards.length = 0; canvases.length = 0;
      const old = fakeBtn('old.md', '', false);
      cards.push(old);
      const before = api.snapshotArtifactCards();
      const { attachments, failed } = await api.captureArtifacts(1000, before);
      return JSON.stringify({ attachments, failed, oldClicks: old.clicks });
    },
    expect: JSON.stringify({ attachments: [], failed: [], oldClicks: 0 })
  }
];

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, expected, got, err) => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
    if (!ok) {
      console.log('        expected: ' + JSON.stringify(expected));
      console.log('        actual  : ' + JSON.stringify(err ? 'THREW ' + err.message : got));
    }
  };

  for (const c of targetCases) {
    let got, err = null;
    try { got = api.collectArtifactTargets(c.nodes, api).map((t) => t.filename); } catch (e) { err = e; }
    check(c.name, !err && JSON.stringify(got) === JSON.stringify(c.expect), c.expect, got, err);
  }

  for (const c of canvasCases) {
    let got, err = null;
    try {
      c.setup();
      const before = api.snapshotCanvases();
      if (c.afterSnapshot) c.afterSnapshot();
      got = await api.waitForCanvasMarkdown(700, before);
    } catch (e) { err = e; }
    check(c.name, !err && got === c.expect, c.expect, got, err);
  }

  // N-15: the fake DOM routes queries by the exact selector string — if the
  // selector in content.js ever drifts, the cases below would silently pass
  // against an empty DOM. Pin it explicitly (same idea as test-protocol.js).
  const selMatch = slice.match(/const ARTIFACT_CARD_SELECTOR = '([^']+)';/);
  check('selector consistency: ARTIFACT_CARD_SELECTOR in content.js matches the test fake',
    !!selMatch && selMatch[1] === CARD_SEL, CARD_SEL, selMatch ? selMatch[1] : '(not found)', null);

  for (const c of n15Cases) {
    let got, err = null;
    try { got = await c.run(); } catch (e) { err = e; }
    check(c.name, !err && got === c.expect, c.expect, got, err);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
