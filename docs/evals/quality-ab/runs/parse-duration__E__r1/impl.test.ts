import { parseDuration } from './impl.ts';

let pass = 0;
let fail = 0;

function eq(label: string, actual: number, expected: number): void {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${label}: got ${actual}, expected ${expected}`);
  }
}

function throws(label: string, fn: () => unknown): void {
  try {
    const r = fn();
    fail++;
    console.error(`FAIL ${label}: expected throw, got ${String(r)}`);
  } catch {
    pass++;
  }
}

// Spec examples
eq('500ms', parseDuration('500ms'), 500);
eq('1s', parseDuration('1s'), 1000);
eq('5m', parseDuration('5m'), 300000);
eq('1h', parseDuration('1h'), 3600000);
eq('1d', parseDuration('1d'), 86400000);
eq('1h30m', parseDuration('1h30m'), 5400000);
eq('1h30m15s', parseDuration('1h30m15s'), 5415000);

// ms/m distinction is the crux
eq('500m != 500ms', parseDuration('500m'), 500 * 60 * 1000);
eq('multi with ms', parseDuration('1h30m15s250ms'), 5415000 + 250);
eq('90m', parseDuration('90m'), 90 * 60 * 1000);

// Whitespace ignored anywhere
eq('1h 30m', parseDuration('1h 30m'), 5400000);
eq('leading/trailing ws', parseDuration('  2d  '), 2 * 86400000);
eq('interior ws in number', parseDuration('1 h 3 0 m'), 5400000);

// Zero amounts
eq('0s', parseDuration('0s'), 0);
eq('0h0m0s', parseDuration('0h0m0s'), 0);

// Order-independent sum (grammar is concatenation; still just a sum)
eq('multi-digit', parseDuration('120s'), 120000);

// Errors
throws('empty', () => parseDuration(''));
throws('only whitespace', () => parseDuration('   '));
throws('number no unit', () => parseDuration('10'));
throws('unknown unit', () => parseDuration('10x'));
throws('trailing junk', () => parseDuration('1h30'));
throws('leading junk', () => parseDuration('x1h'));
throws('unit no number', () => parseDuration('ms'));
throws('negative', () => parseDuration('-5s'));
throws('decimal', () => parseDuration('1.5h'));
throws('uppercase unit', () => parseDuration('5M'));
throws('bare unit mid', () => parseDuration('1hm'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
