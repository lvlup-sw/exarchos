import { parseDuration } from './impl.ts';

type Case = { input: string; expected: number };

const passingCases: Case[] = [
  { input: '500ms', expected: 500 },
  { input: '1s', expected: 1000 },
  { input: '5m', expected: 300000 },
  { input: '1h', expected: 3600000 },
  { input: '1d', expected: 86400000 },
  { input: '1h30m', expected: 5400000 },
  { input: '1h30m15s', expected: 5415000 },
  { input: '90m', expected: 5400000 },
  { input: '2d', expected: 172800000 },
  { input: '0s', expected: 0 },
  { input: '0ms', expected: 0 },
  { input: '1000ms', expected: 1000 },
  { input: '1d1h1m1s1ms', expected: 86400000 + 3600000 + 60000 + 1000 + 1 },
  { input: '007s', expected: 7000 },
];

const invalidCases: string[] = [
  '',
  '1',
  'h',
  '1x',
  '1H',
  '1.5s',
  ' 1s',
  '1s ',
  '1s1',
  '1s-1m',
  '-1s',
  '1ss',
];

let failures = 0;

for (const { input, expected } of passingCases) {
  try {
    const actual = parseDuration(input);
    if (actual !== expected) {
      console.error(
        `FAIL parseDuration(${JSON.stringify(input)}) = ${actual}, expected ${expected}`
      );
      failures++;
    } else {
      console.log(`PASS parseDuration(${JSON.stringify(input)}) = ${actual}`);
    }
  } catch (e) {
    console.error(
      `FAIL parseDuration(${JSON.stringify(input)}) threw unexpectedly: ${(e as Error).message}`
    );
    failures++;
  }
}

for (const input of invalidCases) {
  let threw = false;
  let result: number | undefined;
  try {
    result = parseDuration(input);
  } catch {
    threw = true;
  }

  if (threw) {
    console.log(`PASS parseDuration(${JSON.stringify(input)}) threw as expected`);
  } else {
    console.error(
      `FAIL parseDuration(${JSON.stringify(input)}) should have thrown, got ${result}`
    );
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll checks passed.`);
}
