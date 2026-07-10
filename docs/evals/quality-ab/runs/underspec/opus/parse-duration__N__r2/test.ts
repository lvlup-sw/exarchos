import { parseDuration } from './impl.ts';

let passed = 0;
let failed = 0;

function check(name: string, actual: number, expected: number): void {
  if (Object.is(actual, expected)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name} → expected ${expected}, got ${actual}`);
  }
}

function checkThrows(name: string, fn: () => unknown): void {
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
    console.error(`FAIL: ${name} → expected an error, but none was thrown`);
  }
}

// --- Spec examples -------------------------------------------------------
check('500ms', parseDuration('500ms'), 500);
check('1s', parseDuration('1s'), 1_000);
check('5m', parseDuration('5m'), 300_000);
check('1h', parseDuration('1h'), 3_600_000);
check('1d', parseDuration('1d'), 86_400_000);
check('1h30m', parseDuration('1h30m'), 5_400_000);
check('1h30m15s', parseDuration('1h30m15s'), 5_415_000);

// --- Additional behavior -------------------------------------------------
check('90m == 1h30m', parseDuration('90m'), 5_400_000);
check('2d', parseDuration('2d'), 172_800_000);
check('1ms', parseDuration('1ms'), 1);
check('multi ms/m disambiguation 1m1ms', parseDuration('1m1ms'), 60_001);
check('all units 1d1h1m1s1ms', parseDuration('1d1h1m1s1ms'), 90_061_001);
check('zero amount 0s', parseDuration('0s'), 0);
check('all zeros 0h0m0s', parseDuration('0h0m0s'), 0);
check('leading zeros 007ms', parseDuration('007ms'), 7);
check('repeated units 1h1h', parseDuration('1h1h'), 7_200_000);
check('large value', parseDuration('1000d'), 86_400_000_000);

// --- Invalid inputs should throw -----------------------------------------
checkThrows('empty string', () => parseDuration(''));
checkThrows('amount without unit "5"', () => parseDuration('5'));
checkThrows('unit without amount "ms"', () => parseDuration('ms'));
checkThrows('trailing garbage "1hx"', () => parseDuration('1hx'));
checkThrows('trailing amount "1h30"', () => parseDuration('1h30'));
checkThrows('leading garbage "x1h"', () => parseDuration('x1h'));
checkThrows('unknown unit "5w"', () => parseDuration('5w'));
checkThrows('uppercase unit "5S"', () => parseDuration('5S'));
checkThrows('internal whitespace "1h 30m"', () => parseDuration('1h 30m'));
checkThrows('leading whitespace " 1h"', () => parseDuration(' 1h'));
checkThrows('trailing whitespace "1h "', () => parseDuration('1h '));
checkThrows('negative amount "-1s"', () => parseDuration('-1s'));
checkThrows('decimal amount "1.5s"', () => parseDuration('1.5s'));
checkThrows('reversed order "sm"', () => parseDuration('sm'));
// @ts-expect-error — non-string input must be rejected at runtime.
checkThrows('non-string input', () => parseDuration(123));

// --- Summary -------------------------------------------------------------
const total = passed + failed;
console.log(`parseDuration: ${passed}/${total} checks passed`);

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
