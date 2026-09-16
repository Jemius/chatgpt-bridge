// Cross-file consistency test: the capture-protocol version is declared in
// TWO files that must be bumped in pairs —
//   extension/injected.js   const PROTOCOL = <n>;
//   extension/content.js    const EXPECTED_PROTOCOL = '<n>';
// A half-bump makes the handshake fail loudly on EVERY request (and F5 cannot
// fix it, because the freshly loaded injected.js still carries the old
// constant). This test catches that class of accident before it ships.
const fs = require('fs');
const path = require('path');

const injectedSrc = fs.readFileSync(path.resolve(__dirname, '../extension/injected.js'), 'utf8');
const contentSrc = fs.readFileSync(path.resolve(__dirname, '../extension/content.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  —  ' + detail));
}

const mInj = /const\s+PROTOCOL\s*=\s*(\d+)\s*;/.exec(injectedSrc);
const mCon = /const\s+EXPECTED_PROTOCOL\s*=\s*'(\d+)'/.exec(contentSrc);

check('injected.js declares  const PROTOCOL = <n>;', !!mInj, 'pattern not found in extension/injected.js');
check('content.js declares  const EXPECTED_PROTOCOL = \'<n>\';', !!mCon, 'pattern not found in extension/content.js');

if (mInj && mCon) {
  check(
    'PROTOCOL (' + mInj[1] + ') === EXPECTED_PROTOCOL (\'' + mCon[1] + '\')',
    mInj[1] === mCon[1],
    'pair mismatch — bump both constants together (injected.js and content.js)'
  );
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
