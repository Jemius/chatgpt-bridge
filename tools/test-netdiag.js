// Unit tests for extension/content.js N-16 network diagnostics:
//   - formatNetDiag: turns the injected-side scratchpad
//     (<html data-bridge-net-diag>, written by recordNetDiag in injected.js)
//     into an additive suffix for timeout errors. Must return '' on absent,
//     empty, or corrupt input — diagnostics must never break the message.
//   - waitForNetworkReply: end-to-end timeout text (with and without
//     diagnostics) and the existing resolve-on-reply path.
//
// The functions live inside an IIFE, so we slice the real source out of the
// file and eval it — this tests the SHIPPED code, not a copy of it.
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../extension/content.js');
const full = fs.readFileSync(SRC, 'utf8');

const start = full.indexOf('  // N-16: format the injected-side network diagnostics');
const end = full.indexOf('  // ---------- HTML -> Markdown ----------');
if (start < 0 || end < 0) throw new Error('could not locate the netdiag block in content.js');
const slice = full.slice(start, end);

// Minimal fake DOM: one <html> element with real attribute storage.
const el = {
  attrs: {},
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  removeAttribute(k) { delete this.attrs[k]; }
};
global.document = { documentElement: el };
global.MutationObserver = class {
  observe() {}
  disconnect() {}
};

const harness = 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n' + slice +
  '\nreturn { formatNetDiag, waitForNetworkReply };';
const api = new Function(harness)();

const cases = [
  {
    name: 'formatNetDiag: no scratchpad attribute -> empty suffix',
    setup: () => { el.removeAttribute('data-bridge-net-diag'); },
    call: () => api.formatNetDiag(Date.now()),
    expect: ''
  },
  {
    name: 'formatNetDiag: corrupt JSON -> empty suffix (never breaks the message)',
    setup: () => { el.setAttribute('data-bridge-net-diag', '{not json'); },
    call: () => api.formatNetDiag(Date.now()),
    expect: ''
  },
  {
    name: 'formatNetDiag: empty object -> empty suffix',
    setup: () => { el.setAttribute('data-bridge-net-diag', '{}'); },
    call: () => api.formatNetDiag(Date.now()),
    expect: ''
  },
  {
    name: 'formatNetDiag: non-200/HTML response is named as a challenge/limit suspect',
    setup: () => { el.setAttribute('data-bridge-net-diag', JSON.stringify({ status: 403, contentType: 'text/html', at: 1 })); },
    call: () => api.formatNetDiag(Date.now()),
    expect: '; bridge diagnostics: saw HTTP 403 (text/html) on the conversation endpoint — likely a challenge/limit page'
  },
  {
    name: 'formatNetDiag: chunk progress with sentAt gives a human "last Ns ago"',
    setup: () => { el.setAttribute('data-bridge-net-diag', JSON.stringify({ chunks: 7, lastChunkAt: Date.now() - 3000 })); },
    call: () => api.formatNetDiag(Date.now()),
    expect: '; bridge diagnostics: 7 reply chunk(s) received, last 3s ago'
  },
  {
    name: 'formatNetDiag: chunk progress without sentAt omits the ago clause',
    setup: () => { el.setAttribute('data-bridge-net-diag', JSON.stringify({ chunks: 2, lastChunkAt: Date.now() - 3000 })); },
    call: () => api.formatNetDiag(undefined),
    expect: '; bridge diagnostics: 2 reply chunk(s) received'
  },
  {
    name: 'formatNetDiag: both observations compose in one suffix',
    setup: () => { el.setAttribute('data-bridge-net-diag', JSON.stringify({ status: 429, contentType: '', chunks: 0 })); },
    call: () => api.formatNetDiag(Date.now()),
    expect: '; bridge diagnostics: saw HTTP 429 on the conversation endpoint — likely a challenge/limit page; 0 reply chunk(s) received'
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

  for (const c of cases) {
    let got, err = null;
    try { c.setup(); got = c.call(); } catch (e) { err = e; }
    check(c.name, !err && got === c.expect, c.expect, got, err);
  }

  // End-to-end: a timeout WITH diagnostics carries the suffix in the error.
  el.removeAttribute('data-bridge-net-diag');
  el.setAttribute('data-bridge-net-diag', JSON.stringify({ status: 403, contentType: 'text/html' }));
  {
    const net = await api.waitForNetworkReply('req-diag', 1100, Date.now());
    const expect = 'timed out waiting for network reply (1s)'
      + '; bridge diagnostics: saw HTTP 403 (text/html) on the conversation endpoint — likely a challenge/limit page';
    check('waitForNetworkReply: timeout error carries the diagnostics suffix',
      net.type === 'error' && net.error === expect, expect, net.error || JSON.stringify(net), null);
  }

  // End-to-end: a timeout WITHOUT diagnostics degrades to the old message.
  el.removeAttribute('data-bridge-net-diag');
  {
    const net = await api.waitForNetworkReply('req-plain', 1100, Date.now());
    const expect = 'timed out waiting for network reply (1s)';
    check('waitForNetworkReply: timeout without diagnostics keeps the old message',
      net.type === 'error' && net.error === expect, expect, net.error || JSON.stringify(net), null);
  }

  // Regression: a reply that is already present still resolves immediately.
  {
    el.setAttribute('data-bridge-reply-req-ok', encodeURIComponent(JSON.stringify({ type: 'reply', reply: 'HELLO' })));
    const net = await api.waitForNetworkReply('req-ok', 1100, Date.now());
    const ok = net.type === 'reply' && net.reply === 'HELLO'
      && el.getAttribute('data-bridge-reply-req-ok') === null; // consumed
    check('waitForNetworkReply: pre-existing reply resolves and is consumed',
      ok, '{type:"reply", reply:"HELLO"}, attribute consumed', JSON.stringify(net), null);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
