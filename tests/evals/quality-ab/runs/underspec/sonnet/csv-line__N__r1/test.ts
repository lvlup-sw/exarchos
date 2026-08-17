import { csvParseLine } from './impl.ts';

interface Case {
  readonly name: string;
  readonly input: string;
  readonly expected: string[];
}

const cases: Case[] = [
  { name: 'simple unquoted fields', input: 'a,b,c', expected: ['a', 'b', 'c'] },
  { name: 'quoted field containing a comma', input: '"a,b",c', expected: ['a,b', 'c'] },
  { name: 'quoted field with escaped quote', input: '"a""b"', expected: ['a"b'] },
  { name: 'unquoted field with embedded quote (not at start)', input: 'a"b', expected: ['a"b'] },
  { name: 'empty line yields one empty field', input: '', expected: [''] },
  { name: 'trailing comma yields trailing empty field', input: 'a,', expected: ['a', ''] },
  { name: 'leading comma yields leading empty field', input: ',a', expected: ['', 'a'] },
  { name: 'lone comma yields two empty fields', input: ',', expected: ['', ''] },
  {
    name: 'multiple quoted fields, one with comma, one with escaped quote',
    input: '"a","b,c","d""e"',
    expected: ['a', 'b,c', 'd"e'],
  },
  { name: 'four quotes: escaped quote then closing quote', input: '""""', expected: ['"'] },
  { name: 'empty quoted field', input: '""', expected: [''] },
  { name: 'quoted field that is only a comma', input: '","', expected: [','] },
  { name: 'two simple quoted fields', input: '"x","y"', expected: ['x', 'y'] },
  { name: 'unquoted fields preserve surrounding whitespace', input: ' a , b ', expected: [' a ', ' b '] },
  {
    name: 'unquoted field with embedded quote, followed by another field',
    input: 'a"b,c',
    expected: ['a"b', 'c'],
  },
  { name: 'single unquoted field, no comma', input: 'abc', expected: ['abc'] },
  { name: 'single quoted field, no comma', input: '"abc"', expected: ['abc'] },
];

let passed = 0;
let failed = 0;

for (const { name, input, expected } of cases) {
  let actual: string[] | undefined;
  let error: string | undefined;

  try {
    actual = csvParseLine(input);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const ok =
    error === undefined &&
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((v, idx) => v === expected[idx]);

  if (ok) {
    passed += 1;
    console.log(`PASS: ${name} — csvParseLine(${JSON.stringify(input)}) => ${JSON.stringify(actual)}`);
  } else {
    failed += 1;
    if (error !== undefined) {
      console.error(`FAIL: ${name} — csvParseLine(${JSON.stringify(input)}) threw: ${error}`);
    } else {
      console.error(
        `FAIL: ${name} — csvParseLine(${JSON.stringify(input)}) => ${JSON.stringify(actual)}, expected ${JSON.stringify(
          expected,
        )}`,
      );
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  throw new Error(`${failed} test case(s) failed`);
}
