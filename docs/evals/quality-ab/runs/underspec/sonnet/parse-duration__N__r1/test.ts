import { parseDuration } from './impl.ts';

type ValueCase = { input: string; expected: number; throws?: false };
type ThrowCase = { input: string; throws: true };
type Case = ValueCase | ThrowCase;

const cases: Case[] = [
  // Basic single-unit segments
  { input: '500ms', expected: 500 },
  { input: '1s', expected: 1000 },
  { input: '5m', expected: 300000 },
  { input: '1h', expected: 3600000 },
  { input: '1d', expected: 86400000 },
  { input: '2d', expected: 172800000 },
  { input: '90m', expected: 5400000 },

  // Multi-segment combinations
  { input: '1h30m', expected: 5400000 },
  { input: '1h30m15s', expected: 5415000 },
  { input: '1h30m15s500ms', expected: 5415500 },
  { input: '1d1h1m1s1ms', expected: 90061001 },

  // Zero / edge numeric values
  { input: '0ms', expected: 0 },
  { input: '0s0m0h0d', expected: 0 },
  { input: '01m', expected: 60000 },

  // Invalid grammar
  { input: '', throws: true },
  { input: 'abc', throws: true },
  { input: '1H', throws: true },
  { input: '1', throws: true },
  { input: 'ms', throws: true },
  { input: '1m1', throws: true },
  { input: '-5m', throws: true },
  { input: '1.5s', throws: true },
  { input: '1 m', throws: true },
  { input: '1m ', throws: true },
  { input: '1mm', throws: true },
  { input: '1Ms', throws: true },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  try {
    const result = parseDuration(c.input);
    if (c.throws) {
      console.error(
        `FAIL: parseDuration(${JSON.stringify(c.input)}) expected to throw but returned ${result}`
      );
      failed++;
    } else if (result === c.expected) {
      console.log(`PASS: parseDuration(${JSON.stringify(c.input)}) === ${result}`);
      passed++;
    } else {
      console.error(
        `FAIL: parseDuration(${JSON.stringify(c.input)}) expected ${c.expected} but got ${result}`
      );
      failed++;
    }
  } catch (err) {
    if (c.throws) {
      console.log(`PASS: parseDuration(${JSON.stringify(c.input)}) threw as expected`);
      passed++;
    } else {
      console.error(
        `FAIL: parseDuration(${JSON.stringify(c.input)}) threw unexpectedly: ${(err as Error).message}`
      );
      failed++;
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
