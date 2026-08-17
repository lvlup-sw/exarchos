import { parseDuration } from './impl.ts';

type OkCase = { input: string; expected: number };
type ThrowCase = { input: string; shouldThrow: true };
type Case = OkCase | ThrowCase;

const cases: Case[] = [
  // Basic single-unit segments from the spec examples.
  { input: '500ms', expected: 500 },
  { input: '1s', expected: 1000 },
  { input: '5m', expected: 300000 },
  { input: '1h', expected: 3600000 },
  { input: '1d', expected: 86400000 },
  { input: '1h30m', expected: 5400000 },
  { input: '1h30m15s', expected: 5415000 },

  // Additional coverage.
  { input: '90m', expected: 5400000 },
  { input: '2d', expected: 172800000 },
  { input: '0ms', expected: 0 },
  { input: '007ms', expected: 7 }, // leading zeros are still a valid non-negative integer
  {
    input: '1d1h1m1s1ms',
    expected: 24 * 60 * 60 * 1000 + 60 * 60 * 1000 + 60 * 1000 + 1000 + 1,
  },

  // Invalid input handling.
  { input: '', shouldThrow: true },
  { input: 'abc', shouldThrow: true },
  { input: '1x', shouldThrow: true },
  { input: 'ms', shouldThrow: true },
  { input: '1h 30m', shouldThrow: true }, // whitespace not allowed
  { input: '1H', shouldThrow: true }, // units must be lowercase
  { input: '-5m', shouldThrow: true }, // negative not allowed
  { input: '1.5h', shouldThrow: true }, // fractional not allowed
  { input: '1h30', shouldThrow: true }, // trailing amount with no unit
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  try {
    const result = parseDuration(c.input);
    if ('shouldThrow' in c) {
      console.error(
        `FAIL: parseDuration(${JSON.stringify(c.input)}) expected to throw, but returned ${result}`
      );
      failed++;
    } else if (result !== c.expected) {
      console.error(
        `FAIL: parseDuration(${JSON.stringify(c.input)}) = ${result}, expected ${c.expected}`
      );
      failed++;
    } else {
      passed++;
    }
  } catch (err) {
    if ('shouldThrow' in c) {
      passed++;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `FAIL: parseDuration(${JSON.stringify(c.input)}) threw unexpectedly: ${message}`
      );
      failed++;
    }
  }
}

console.log(`${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
