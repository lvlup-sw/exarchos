import { parseDuration } from './impl.ts';

let passed = 0;
let failed = 0;

function check(name: string, got: unknown, want: unknown): void {
  if (Object.is(got, want)) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: ${name}\n  expected: ${String(want)}\n  actual:   ${String(got)}`,
    );
  }
}

function checkThrows(name: string, fn: () => unknown): void {
  try {
    const r = fn();
    failed++;
    console.error(`FAIL: ${name}\n  expected throw, got: ${String(r)}`);
  } catch {
    passed++;
  }
}

// --- Spec examples ---------------------------------------------------------
check('500ms', parseDuration('500ms'), 500);
check('1s', parseDuration('1s'), 1000);
check('5m', parseDuration('5m'), 300000);
check('1h', parseDuration('1h'), 3600000);
check('1d', parseDuration('1d'), 86400000);
check('1h30m', parseDuration('1h30m'), 5400000);
check('1h30m15s', parseDuration('1h30m15s'), 5415000);

// --- Additional single-unit cases ------------------------------------------
check('1ms', parseDuration('1ms'), 1);
check('2d', parseDuration('2d'), 172800000);
check('90m', parseDuration('90m'), 5400000);
check('0s', parseDuration('0s'), 0);
check('0ms', parseDuration('0ms'), 0);

// --- Multi-segment composition ---------------------------------------------
check('1d2h3m4s5ms', parseDuration('1d2h3m4s5ms'), 93784005);
check('60s equals 1m', parseDuration('60s'), parseDuration('1m'));
check('60m equals 1h', parseDuration('60m'), parseDuration('1h'));
check('24h equals 1d', parseDuration('24h'), parseDuration('1d'));
check('1000ms equals 1s', parseDuration('1000ms'), parseDuration('1s'));

// ms/m disambiguation: "1m1s" must not be read as "1", "m1s"
check('1m1s', parseDuration('1m1s'), 61000);
check('1ms1s', parseDuration('1ms1s'), 1001);

// leading zeros are fine (still base-10 integers)
check('007s', parseDuration('007s'), 7000);

// --- Invalid inputs must throw ---------------------------------------------
checkThrows('empty string', () => parseDuration(''));
checkThrows('letters only', () => parseDuration('abc'));
checkThrows('unknown unit', () => parseDuration('1x'));
checkThrows('digits without unit', () => parseDuration('1'));
checkThrows('unit without digits', () => parseDuration('h'));
checkThrows('trailing digits', () => parseDuration('1h30'));
checkThrows('fractional amount', () => parseDuration('1.5h'));
checkThrows('negative amount', () => parseDuration('-1h'));
checkThrows('whitespace', () => parseDuration('1h 30m'));
checkThrows('uppercase unit', () => parseDuration('1H'));

// --- Summary ---------------------------------------------------------------
const total = passed + failed;
console.log(`\n${passed}/${total} checks passed.`);
if (failed > 0) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log('All checks passed.');
