import { parseDuration } from './impl.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, actual: number, expected: number): void {
  if (Object.is(actual, expected)) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}: expected ${expected}, got ${actual}`);
  }
}

function expectThrows(name: string, fn: () => unknown): void {
  try {
    fn();
    failed++;
    failures.push(`${name}: expected to throw, but returned normally`);
  } catch {
    passed++;
  }
}

// --- Spec examples ---------------------------------------------------------
check('500ms', parseDuration('500ms'), 500);
check('1s', parseDuration('1s'), 1_000);
check('5m', parseDuration('5m'), 300_000);
check('1h', parseDuration('1h'), 3_600_000);
check('1d', parseDuration('1d'), 86_400_000);
check('1h30m', parseDuration('1h30m'), 5_400_000);
check('1h30m15s', parseDuration('1h30m15s'), 5_415_000);

// --- Additional valid cases ------------------------------------------------
check('90m == 1h30m', parseDuration('90m'), 5_400_000);
check('2d', parseDuration('2d'), 172_800_000);
check('0ms', parseDuration('0ms'), 0);
check('0s', parseDuration('0s'), 0);

// Order-independent concatenation (grammar allows any ordering).
check('15s1h30m', parseDuration('15s1h30m'), 5_415_000);

// Repeated units accumulate.
check('30m30m', parseDuration('30m30m'), 3_600_000);

// All units together.
check(
  '1d1h1m1s1ms',
  parseDuration('1d1h1m1s1ms'),
  86_400_000 + 3_600_000 + 60_000 + 1_000 + 1,
);

// `ms` must not be mis-parsed as `m` + `s`.
check('100ms', parseDuration('100ms'), 100);
check('1m1s vs 1ms distinct', parseDuration('1m1s'), 61_000);

// Large amount.
check('1000000ms', parseDuration('1000000ms'), 1_000_000);

// --- Invalid inputs (must throw) ------------------------------------------
expectThrows('empty string', () => parseDuration(''));
expectThrows('no unit', () => parseDuration('1'));
expectThrows('bare unit', () => parseDuration('ms'));
expectThrows('unknown unit', () => parseDuration('1x'));
expectThrows('uppercase unit', () => parseDuration('1H'));
expectThrows('decimal amount', () => parseDuration('1.5s'));
expectThrows('leading space', () => parseDuration(' 1s'));
expectThrows('trailing space', () => parseDuration('1s '));
expectThrows('inner space', () => parseDuration('1h 30m'));
expectThrows('negative amount', () => parseDuration('-1s'));
expectThrows('trailing garbage', () => parseDuration('1h30'));
expectThrows('non-string', () => parseDuration(42 as unknown as string));

// --- Summary ---------------------------------------------------------------
console.log(`parseDuration tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) {
    console.error(`  ✗ ${f}`);
  }
  process.exit(1);
}
console.log('All parseDuration checks passed.');
