import { parseDuration } from './impl.ts';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
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
    console.error(`FAIL: ${name}\n  expected: throw\n  actual:   no throw`);
  }
}

// --- Spec examples ---
check('500ms', parseDuration('500ms'), 500);
check('1s', parseDuration('1s'), 1000);
check('5m', parseDuration('5m'), 300000);
check('1h', parseDuration('1h'), 3600000);
check('1d', parseDuration('1d'), 86400000);
check('1h30m', parseDuration('1h30m'), 5400000);
check('1h30m15s', parseDuration('1h30m15s'), 5415000);

// --- Unit fundamentals ---
check('1ms', parseDuration('1ms'), 1);
check('2d', parseDuration('2d'), 172800000);
check('90m', parseDuration('90m'), 5400000);
check('1h30m15s full', parseDuration('1h30m15s'), 3600000 + 30 * 60000 + 15000);

// --- ms vs m disambiguation (load-bearing) ---
check('100ms not minutes', parseDuration('100ms'), 100);
check('1m100ms', parseDuration('1m100ms'), 60000 + 100);
check('order-preserving 15s1h', parseDuration('15s1h'), 15000 + 3600000);

// --- Zero and leading zeros ---
check('0s', parseDuration('0s'), 0);
check('0ms', parseDuration('0ms'), 0);
check('leading zero 007s', parseDuration('007s'), 7000);
check('0h0m0s', parseDuration('0h0m0s'), 0);

// --- Multi-segment aggregation ---
check('1d1h1m1s1ms', parseDuration('1d1h1m1s1ms'), 86400000 + 3600000 + 60000 + 1000 + 1);
check('repeated units 30m30m', parseDuration('30m30m'), 60 * 60000);

// --- Invalid inputs should throw ---
checkThrows('empty string', () => parseDuration(''));
checkThrows('no unit', () => parseDuration('10'));
checkThrows('unknown unit', () => parseDuration('10y'));
checkThrows('unit without amount', () => parseDuration('ms'));
checkThrows('trailing garbage', () => parseDuration('1h30'));
checkThrows('leading garbage', () => parseDuration('x1h'));
checkThrows('internal garbage', () => parseDuration('1h x30m'));
checkThrows('uppercase unit', () => parseDuration('5M'));
checkThrows('negative amount', () => parseDuration('-5s'));
checkThrows('decimal amount', () => parseDuration('1.5s'));
checkThrows('whitespace between segments', () => parseDuration('1h 30m'));

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
