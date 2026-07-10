import { parseDuration } from './impl.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, msg = ''): void {
  if (actual !== expected) {
    throw new Error(`${msg} expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertThrows(fn: () => void, msg = 'expected throw'): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(`${msg} but nothing was thrown`);
  }
}

// --- Spec examples ---------------------------------------------------------
check('500ms -> 500', () => assertEqual(parseDuration('500ms'), 500));
check('1s -> 1000', () => assertEqual(parseDuration('1s'), 1000));
check('5m -> 300000', () => assertEqual(parseDuration('5m'), 300_000));
check('1h -> 3600000', () => assertEqual(parseDuration('1h'), 3_600_000));
check('1d -> 86400000', () => assertEqual(parseDuration('1d'), 86_400_000));
check('1h30m -> 5400000', () => assertEqual(parseDuration('1h30m'), 5_400_000));
check('1h30m15s -> 5415000', () =>
  assertEqual(parseDuration('1h30m15s'), 5_415_000));

// --- Unit relationships ----------------------------------------------------
check('90m equals 1h30m', () =>
  assertEqual(parseDuration('90m'), parseDuration('1h30m')));
check('2d -> 172800000', () => assertEqual(parseDuration('2d'), 172_800_000));
check('1d1h1m1s1ms sums each unit', () =>
  assertEqual(
    parseDuration('1d1h1m1s1ms'),
    86_400_000 + 3_600_000 + 60_000 + 1_000 + 1,
  ));

// --- ms vs m disambiguation (the load-bearing edge case) -------------------
check('ms is milliseconds, not minutes+seconds', () =>
  assertEqual(parseDuration('500ms'), 500));
check('1m1s distinct from 1ms', () => {
  assertEqual(parseDuration('1m1s'), 61_000);
  assertEqual(parseDuration('1ms'), 1);
});

// --- Zero and leading zeros ------------------------------------------------
check('0s -> 0', () => assertEqual(parseDuration('0s'), 0));
check('0ms0s0m0h0d -> 0', () => assertEqual(parseDuration('0ms0s0m0h0d'), 0));
check('leading zeros parsed as decimal', () =>
  assertEqual(parseDuration('007s'), 7_000));

// --- Repeated units accumulate ---------------------------------------------
check('repeated units add up', () =>
  assertEqual(parseDuration('30m30m'), 3_600_000));

// --- Invalid inputs throw --------------------------------------------------
check('empty string throws', () => assertThrows(() => parseDuration('')));
check('bare number throws', () => assertThrows(() => parseDuration('10')));
check('bare unit throws', () => assertThrows(() => parseDuration('ms')));
check('unknown unit throws', () => assertThrows(() => parseDuration('5x')));
check('uppercase unit throws', () => assertThrows(() => parseDuration('5S')));
check('whitespace throws', () => assertThrows(() => parseDuration('1h 30m')));
check('trailing garbage throws', () => assertThrows(() => parseDuration('1h!')));
check('leading garbage throws', () => assertThrows(() => parseDuration('x1h')));

// --- Summary ---------------------------------------------------------------
console.log(`\nparseDuration tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
console.log('All checks passed.');
