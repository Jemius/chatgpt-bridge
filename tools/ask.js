// chatgpt-bridge · minimal end-to-end harness
//
// Sends one message through relay -> extension -> ChatGPT and prints the reply
// with its length. This is the reproduction harness for the P0 bug (see
// ISSUES.md): run it repeatedly with the built-in long-reply prompt and compare
// the lengths — a correct bridge returns the same complete answer every time.
//
// Usage:
//   node tools/ask.js                       # built-in long-reply repro
//   node tools/ask.js <message-file>        # send a file's contents
//   node tools/ask.js <message-file> 240000 continue
//
// Env:
//   BRIDGE_RELAY   relay base URL (default http://127.0.0.1:8742)
const fs = require('fs');

// The repro prompt. Short replies only ever produce a single stream fragment,
// so they can never expose the bug — this one forces a long, multi-frame answer.
const REPRO = '从1数到30，用逗号分隔，只输出数字。';

const file = process.argv[2];
const timeoutMs = Number(process.argv[3] || 240000);
const conversation = process.argv[4] || 'new';
const RELAY = process.env.BRIDGE_RELAY || 'http://127.0.0.1:8742';

async function main() {
  const message = file ? fs.readFileSync(file, 'utf8') : REPRO;
  console.log('[ask] sending ' + message.length + ' chars to ' + RELAY + ' (conversation=' + conversation + ')');

  const t0 = Date.now();
  const r = await fetch(RELAY + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, timeoutMs, conversation })
  });
  const j = await r.json();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!j.ok) { console.error('[ask] FAILED after ' + secs + 's: ' + j.error); process.exit(1); }

  const md = j.markdown || '';
  console.log('[ask] reply in ' + secs + 's (' + md.length + ' chars)\n');
  console.log('================ CHATGPT ================');
  console.log(md);
  console.log('=========================================');

  // For the built-in repro, a correct answer is exactly "1,2,...,30" (58 chars).
  if (!file) {
    const expected = Array.from({ length: 30 }, (_, i) => i + 1).join(',');
    console.log(md.trim() === expected
      ? '[ask] PASS — the reply is complete'
      : '[ask] FAIL — expected ' + expected.length + ' chars, got ' + md.trim().length +
        ' (missing: ' + expected.split(',').filter((n) => !md.split(',').includes(n)).join(',') + ')');
  }

  if (j.attachments && j.attachments.length) console.log('[ask] attachments:', j.attachments.map((x) => x.filename).join(', '));
  if (j.failed && j.failed.length) console.log('[ask] failed attachments:', JSON.stringify(j.failed));
}

main().catch((e) => { console.error('[ask] harness error:', e && e.message); process.exit(2); });
