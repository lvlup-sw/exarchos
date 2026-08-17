import { parseDuration } from './impl.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(description: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${description} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function checkThrows(description: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (threw) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${description} — expected function to throw, but it did not`);
  }
}

// Basic single-unit segments
check('500ms', parseDuration('500ms'), 500);
check('1s', parseDuration('1s'), 1000);
check('5m', parseDuration('5m'), 300000);
check('1h', parseDuration('1h'), 3600000);
check('1d', parseDuration('1d'), 86400000);

// Multi-segment combos
check('1h30m', parseDuration('1h30m'), 5400000);
check('1h30m15s', parseDuration('1h30m15s'), 5415000);
check('90m', parseDuration('90m'), 5400000);
check('2d', parseDuration('2d'), 172800000);

// Zero and multi-digit amounts
check('0ms', parseDuration('0ms'), 0);
check('0s', parseDuration('0s'), 0);
check('100d', parseDuration('100d'), 100 * 86400000);
check('1000ms', parseDuration('1000ms'), 1000);

// Combining ms with other units, and repeated units (sum semantics)
check('1s500ms', parseDuration('1s500ms'), 1500);
check('1m1m', parseDuration('1m1m'), 120000);
check('1h1h', parseDuration('1h1h'), 7200000);

// All units together
check(
  '1d1h1m1s1ms',
  parseDuration('1d1h1m1s1ms'),
  86400000 + 3600000 + 60000 + 1000 + 1
);

// Invalid inputs should throw
checkThrows('empty string throws', () => parseDuration(''));
checkThrows('bare number throws', () => parseDuration('100'));
checkThrows('bare unit throws', () => parseDuration('h'));
checkThrows('unknown unit throws', () => parseDuration('5x'));
checkThrows('trailing garbage throws', () => parseDuration('1h30m!'));
checkThrows('leading garbage throws', () => parseDuration('!1h'));
checkThrows('space between segments throws', () => parseDuration('1h 30m'));
checkThrows('negative amount throws', () => parseDuration('-5m'));
checkThrows('decimal amount throws', () => parseDuration('1.5h'));
checkThrows('uppercase unit throws', () => parseDuration('1H'));

console.log(`parseDuration tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) {
    console.error(f);
  }
  process.exit(1);
}
