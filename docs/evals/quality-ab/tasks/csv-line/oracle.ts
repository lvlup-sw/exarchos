// HIDDEN ORACLE — the agent never sees this. Grades impl.ts against the spec's
// quoting/escaping edge cases. Run: `tsx oracle.ts` in a dir with `impl.ts`.
import { csvParseLine } from './impl.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function eq(input: string, want: string[]): void {
  const got = csvParseLine(input);
  assert(
    Array.isArray(got) && got.length === want.length && got.every((v, i) => v === want[i]),
    `csvParseLine(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );
}
function throws(input: string): void {
  let threw = false;
  try {
    csvParseLine(input);
  } catch {
    threw = true;
  }
  assert(threw, `csvParseLine(${JSON.stringify(input)}) should throw`);
}

const checks: Array<[string, () => void]> = [
  ['simple', () => eq('a,b,c', ['a', 'b', 'c'])],
  ['empty middle field', () => eq('a,,c', ['a', '', 'c'])],
  ['lone comma', () => eq(',', ['', ''])],
  ['empty string is one empty field', () => eq('', [''])],
  ['quoted empty', () => eq('""', [''])],
  ['single field', () => eq('hello', ['hello'])],
  ['unquoted whitespace preserved', () => eq(' a , b ', [' a ', ' b '])],
  ['trailing comma', () => eq('a,', ['a', ''])],
  ['leading comma', () => eq(',b', ['', 'b'])],
  ['quoted field', () => eq('"a"', ['a'])],
  ['comma inside quotes', () => eq('"a,b",c', ['a,b', 'c'])],
  ['escaped quote inside quotes', () => eq('"a""b"', ['a"b'])],
  ['escaped quote then more', () => eq('"a""b",c', ['a"b', 'c'])],
  ['quote literal in unquoted field', () => eq('a"b', ['a"b'])],
  ['multiple quoted with commas', () => eq('"a,b","c,d"', ['a,b', 'c,d'])],
  ['mixed quoted/empty/quoted', () => eq('"hi",,"x,y"', ['hi', '', 'x,y'])],
  ['quoted empty between values', () => eq('a,"",b', ['a', '', 'b'])],
  ['only-quotes escaped pair', () => eq('""""', ['"'])],
  ['unterminated quote throws', () => throws('"abc')],
  ['junk after closing quote throws', () => throws('"a"b')],
  ['unterminated after escaped quote throws', () => throws('"a""')],
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
