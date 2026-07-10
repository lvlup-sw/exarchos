import { parseDuration } from './impl.ts';

type Check = () => void;

const failures: string[] = [];
let checkCount = 0;

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  checkCount++;
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: Check, label: string): void {
  checkCount++;
  try {
    fn();
    failures.push(`${label}: expected to throw, but did not`);
  } catch {
    // expected
  }
}

// --- Spec examples ---
assertEqual(parseDuration('500ms'), 500, 'parseDuration("500ms")');
assertEqual(parseDuration('1s'), 1000, 'parseDuration("1s")');
assertEqual(parseDuration('5m'), 300000, 'parseDuration("5m")');
assertEqual(parseDuration('1h'), 3600000, 'parseDuration("1h")');
assertEqual(parseDuration('1d'), 86400000, 'parseDuration("1d")');
assertEqual(parseDuration('1h30m'), 5400000, 'parseDuration("1h30m")');
assertEqual(parseDuration('1h30m15s'), 5415000, 'parseDuration("1h30m15s")');

// --- Additional valid combinations ---
assertEqual(parseDuration('90m'), 5400000, 'parseDuration("90m")');
assertEqual(parseDuration('2d'), 172800000, 'parseDuration("2d")');
assertEqual(parseDuration('1d1h1m1s1ms'), 90061001, 'parseDuration("1d1h1m1s1ms")');
assertEqual(parseDuration('0s'), 0, 'parseDuration("0s")');
assertEqual(parseDuration('0ms'), 0, 'parseDuration("0ms")');
assertEqual(parseDuration('007s'), 7000, 'parseDuration("007s") (leading zeros)');
assertEqual(parseDuration('100ms100ms'), 200, 'parseDuration("100ms100ms") (repeated unit)');
assertEqual(parseDuration('1m1m'), 120000, 'parseDuration("1m1m") (repeated same unit sums)');

// --- Invalid inputs must throw ---
assertThrows(() => parseDuration(''), 'parseDuration("") should throw');
assertThrows(() => parseDuration('abc'), 'parseDuration("abc") should throw');
assertThrows(() => parseDuration('5'), 'parseDuration("5") (no unit) should throw');
assertThrows(() => parseDuration('h'), 'parseDuration("h") (no amount) should throw');
assertThrows(() => parseDuration('5x'), 'parseDuration("5x") (bad unit) should throw');
assertThrows(() => parseDuration('1h x30m'), 'parseDuration("1h x30m") (gap) should throw');
assertThrows(() => parseDuration('1h30m garbage'), 'parseDuration("1h30m garbage") (trailing garbage) should throw');
assertThrows(() => parseDuration('-5m'), 'parseDuration("-5m") (negative) should throw');
assertThrows(() => parseDuration('5.5m'), 'parseDuration("5.5m") (decimal) should throw');
assertThrows(() => parseDuration('5M'), 'parseDuration("5M") (uppercase unit) should throw');
assertThrows(() => parseDuration(' 5m'), 'parseDuration(" 5m") (leading space) should throw');

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length}/${checkCount} checks failed`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
} else {
  console.log(`PASS: all ${checkCount} checks passed`);
}
