// HIDDEN ORACLE — the agent never sees this. Grades impl.ts against the spec's
// edge cases. Run: `tsx oracle.ts` in a dir containing the produced `impl.ts`.
import { parseDuration } from './impl.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function eq(input: string, want: number): void {
  const got = parseDuration(input);
  assert(got === want, `parseDuration(${JSON.stringify(input)}) = ${got}, want ${want}`);
}
function throws(input: string): void {
  let threw = false;
  try {
    parseDuration(input);
  } catch {
    threw = true;
  }
  assert(threw, `parseDuration(${JSON.stringify(input)}) should throw`);
}

const checks: Array<[string, () => void]> = [
  ['ms unit', () => eq('500ms', 500)],
  ['s unit', () => eq('1s', 1000)],
  ['m unit', () => eq('5m', 300000)],
  ['h unit', () => eq('1h', 3600000)],
  ['d unit', () => eq('1d', 86400000)],
  ['multi-segment h+m', () => eq('1h30m', 5400000)],
  ['multi-segment h+m+s', () => eq('1h30m15s', 5415000)],
  ['minutes overflow into value', () => eq('90m', 5400000)],
  ['ms vs m: 500ms is not 500 minutes', () => eq('500ms', 500)],
  ['ms after other segments', () => eq('1s500ms', 1500)],
  ['multi-digit amount', () => eq('1000ms', 1000)],
  ['zero amount', () => eq('0s', 0)],
  ['whitespace ignored', () => eq('1h 30m', 5400000)],
  ['leading/trailing whitespace', () => eq('  2d  ', 172800000)],
  ['empty string throws', () => throws('')],
  ['whitespace-only throws', () => throws('   ')],
  ['number with no unit throws', () => throws('10')],
  ['unknown unit throws', () => throws('10x')],
  ['trailing junk throws', () => throws('1h30')],
  ['pure junk throws', () => throws('abc')],
  ['unit with no amount throws', () => throws('ms')],
];

let passed = 0;
const failures: string[] = [];
for (const [name, fn] of checks) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(JSON.stringify({ passed, failed: failures.length, total: checks.length, failures }));
