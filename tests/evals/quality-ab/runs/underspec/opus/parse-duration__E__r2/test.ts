import { parseDuration } from './impl.ts';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ ${name}\n    ${message}`);
  }
}

function eq(name: string, input: string, expected: number): void {
  check(name, () => {
    const actual = parseDuration(input);
    if (actual !== expected) {
      throw new Error(
        `parseDuration(${JSON.stringify(input)}) => ${actual}, expected ${expected}`,
      );
    }
  });
}

function throws(name: string, input: string): void {
  check(name, () => {
    let result: number | undefined;
    try {
      result = parseDuration(input);
    } catch {
      return; // expected
    }
    throw new Error(
      `parseDuration(${JSON.stringify(input)}) should have thrown, got ${result}`,
    );
  });
}

// --- Spec examples ---------------------------------------------------------
eq('500ms', '500ms', 500);
eq('1s', '1s', 1000);
eq('5m', '5m', 300000);
eq('1h', '1h', 3600000);
eq('1d', '1d', 86400000);
eq('1h30m', '1h30m', 5400000);
eq('1h30m15s', '1h30m15s', 5415000);

// --- Single units ----------------------------------------------------------
eq('1ms', '1ms', 1);
eq('90m', '90m', 5400000);
eq('2d', '2d', 172800000);
eq('60s', '60s', 60000);
eq('24h', '24h', 86400000);

// --- Multi-segment combinations -------------------------------------------
eq('full stack', '1d1h1m1s1ms', 86400000 + 3600000 + 60000 + 1000 + 1);
eq('ms precedence over m', '500ms', 500);
eq('m then s not confused', '1m1s', 61000);
eq('mixed order', '2d3h', 172800000 + 10800000);
eq('repeated unit sums', '30m30m', 3600000);

// --- Zero amounts ----------------------------------------------------------
eq('0ms', '0ms', 0);
eq('0s', '0s', 0);
eq('0h0m0s', '0h0m0s', 0);
eq('leading zeros', '007s', 7000);

// --- Invalid inputs --------------------------------------------------------
throws('empty string', '');
throws('bare number', '1');
throws('unknown unit', '5x');
throws('uppercase unit', '5S');
throws('trailing junk', '1hfoo');
throws('leading space', ' 1h');
throws('trailing space', '1h ');
throws('interior junk', '1h x2m');
throws('missing amount', 'ms');
throws('negative amount', '-5s');
throws('decimal amount', '1.5s');

// --- Summary ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
