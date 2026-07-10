import { parseDuration } from './impl.ts';

type Check = () => void;

const checks: Array<{ name: string; run: Check }> = [];
let failures = 0;

function test(name: string, run: Check): void {
  checks.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => void, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(`${message}: expected function to throw, but it did not`);
  }
}

// --- Basic single-unit segments ---
test('500ms -> 500', () => {
  assertEqual(parseDuration('500ms'), 500, '500ms');
});

test('1s -> 1000', () => {
  assertEqual(parseDuration('1s'), 1000, '1s');
});

test('5m -> 300000', () => {
  assertEqual(parseDuration('5m'), 300000, '5m');
});

test('1h -> 3600000', () => {
  assertEqual(parseDuration('1h'), 3600000, '1h');
});

test('1d -> 86400000', () => {
  assertEqual(parseDuration('1d'), 86400000, '1d');
});

// --- Multi-segment combinations ---
test('1h30m -> 5400000', () => {
  assertEqual(parseDuration('1h30m'), 5400000, '1h30m');
});

test('1h30m15s -> 5415000', () => {
  assertEqual(parseDuration('1h30m15s'), 5415000, '1h30m15s');
});

test('90m -> 5400000', () => {
  assertEqual(parseDuration('90m'), 5400000, '90m');
});

test('segment order does not matter (30m1h == 1h30m)', () => {
  assertEqual(parseDuration('30m1h'), parseDuration('1h30m'), '30m1h vs 1h30m');
});

test('all five units combined', () => {
  // 1d + 1h + 1m + 1s + 1ms
  const expected = 86400000 + 3600000 + 60000 + 1000 + 1;
  assertEqual(parseDuration('1d1h1m1s1ms'), expected, '1d1h1m1s1ms');
});

// --- Edge cases ---
test('zero-amount segment', () => {
  assertEqual(parseDuration('0ms'), 0, '0ms');
});

test('zero amount combined with nonzero', () => {
  assertEqual(parseDuration('0h5m'), 300000, '0h5m');
});

test('multi-digit amount', () => {
  assertEqual(parseDuration('1000ms'), 1000, '1000ms');
});

test('repeated same unit sums', () => {
  assertEqual(parseDuration('1h1h'), 7200000, '1h1h');
});

// --- Invalid input handling ---
test('empty string throws', () => {
  assertThrows(() => parseDuration(''), 'empty string');
});

test('no unit throws', () => {
  assertThrows(() => parseDuration('123'), 'no unit');
});

test('no amount throws', () => {
  assertThrows(() => parseDuration('h'), 'no amount');
});

test('unknown unit throws', () => {
  assertThrows(() => parseDuration('1x'), 'unknown unit');
});

test('trailing garbage throws', () => {
  assertThrows(() => parseDuration('1h30'), 'trailing garbage (dangling amount)');
});

test('leading garbage throws', () => {
  assertThrows(() => parseDuration('x1h'), 'leading garbage');
});

test('interior garbage throws', () => {
  assertThrows(() => parseDuration('1h!30m'), 'interior garbage');
});

test('negative amount throws', () => {
  assertThrows(() => parseDuration('-5m'), 'negative amount');
});

test('decimal amount throws', () => {
  assertThrows(() => parseDuration('1.5h'), 'decimal amount');
});

test('uppercase unit throws', () => {
  assertThrows(() => parseDuration('1H'), 'uppercase unit');
});

test('whitespace throws', () => {
  assertThrows(() => parseDuration('1h 30m'), 'whitespace between segments');
});

// --- Run all checks ---
let passed = 0;
for (const { name, run } of checks) {
  try {
    run();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures += 1;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FAIL: ${name} -- ${message}`);
  }
}

console.log(`\n${passed}/${checks.length} checks passed`);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
