import { parseDuration } from './impl.ts';

let passed = 0;
let failed = 0;

function eq(label: string, got: number, want: number): void {
  if (got === want) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${label}: got ${got}, want ${want}`);
  }
}

function throws(label: string, fn: () => unknown): void {
  try {
    const r = fn();
    failed++;
    console.error(`FAIL ${label}: expected throw, got ${JSON.stringify(r)}`);
  } catch {
    passed++;
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

// ms vs m distinction — the crux
eq('500ms not minutes', parseDuration('500ms'), 500);
eq('2m minutes', parseDuration('2m'), 120000);
eq('1m1ms mixed', parseDuration('1m1ms'), 60001);
eq('1ms1m order-independent sum', parseDuration('1ms1m'), 60001);

// Whitespace ignored anywhere
eq('1h 30m spaces', parseDuration('1h 30m'), 5400000);
eq('leading/trailing/internal ws', parseDuration('  1h30m15s  '), 5415000);
eq('tabs/newlines', parseDuration('1h\t30m\n15s'), 5415000);

// Zero and multi-segment
eq('0s', parseDuration('0s'), 0);
eq('90m', parseDuration('90m'), 5400000);
eq('all units', parseDuration('1d1h1m1s1ms'), 86400000 + 3600000 + 60000 + 1000 + 1);
eq('repeated units sum', parseDuration('1h1h'), 7200000);

// Errors
throws('empty', () => parseDuration(''));
throws('only whitespace', () => parseDuration('   '));
throws('number no unit', () => parseDuration('10'));
throws('unknown unit', () => parseDuration('10x'));
throws('trailing garbage', () => parseDuration('1h30'));
throws('leading garbage', () => parseDuration('x10s'));
throws('unit no amount', () => parseDuration('h'));
throws('bare ms no amount', () => parseDuration('ms'));
throws('embedded garbage', () => parseDuration('1h!30m'));
throws('negative', () => parseDuration('-5s'));
throws('float', () => parseDuration('1.5s'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
