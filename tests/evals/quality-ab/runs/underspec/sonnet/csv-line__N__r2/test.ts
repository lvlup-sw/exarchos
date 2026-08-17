import { csvParseLine } from './impl.ts';

interface Case {
  name: string;
  input: string;
  expected: string[];
}

const cases: Case[] = [
  { name: 'basic unquoted fields', input: 'a,b,c', expected: ['a', 'b', 'c'] },
  { name: 'quoted field containing a comma', input: '"a,b",c', expected: ['a,b', 'c'] },
  { name: 'escaped quote inside quoted field', input: '"a""b"', expected: ['a"b'] },
  { name: 'unquoted field with embedded quote (not at start)', input: 'a"b', expected: ['a"b'] },
  { name: 'empty line -> single empty field', input: '', expected: [''] },
  { name: 'trailing comma -> trailing empty field', input: 'a,', expected: ['a', ''] },
  { name: 'leading comma -> leading empty field', input: ',a', expected: ['', 'a'] },
  { name: 'empty quoted field', input: '""', expected: [''] },
  { name: 'all fields quoted, no special chars', input: '"a","b","c"', expected: ['a', 'b', 'c'] },
  { name: 'quoted field that is only an escaped quote', input: '""""', expected: ['"'] },
  { name: 'unquoted fields preserve internal whitespace', input: '  a  ,  b  ', expected: ['  a  ', '  b  '] },
  { name: 'embedded quote mid-field stays literal (unquoted)', input: 'ab"cd,ef', expected: ['ab"cd', 'ef'] },
  { name: 'mix of quoted and unquoted fields', input: '"a",b,"c,d"', expected: ['a', 'b', 'c,d'] },
  { name: 'single unquoted field, no comma', input: 'hello', expected: ['hello'] },
  { name: 'single quoted field, no comma', input: '"hello"', expected: ['hello'] },
  {
    name: 'multiple escaped quotes inside one quoted field',
    input: '"say ""hi"" now"',
    expected: ['say "hi" now'],
  },
  {
    name: 'escaped quote in a non-first field',
    input: 'a,"b""c",d',
    expected: ['a', 'b"c', 'd'],
  },
  { name: 'three empty quoted fields', input: '"","",""', expected: ['', '', ''] },
  {
    name: 'quoted fields with commas and escaped quotes mixed with plain field',
    input: '"quoted,with,commas","and ""quotes"" too",plain',
    expected: ['quoted,with,commas', 'and "quotes" too', 'plain'],
  },
];

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, idx) => v === b[idx]);
}

let passed = 0;
let failed = 0;

for (const c of cases) {
  try {
    const actual = csvParseLine(c.input);
    if (arraysEqual(actual, c.expected)) {
      passed++;
      console.log(`PASS: ${c.name}`);
    } else {
      failed++;
      console.error(
        `FAIL: ${c.name}\n  input:    ${JSON.stringify(c.input)}\n  expected: ${JSON.stringify(
          c.expected
        )}\n  actual:   ${JSON.stringify(actual)}`
      );
    }
  } catch (err) {
    failed++;
    console.error(
      `FAIL (threw): ${c.name}\n  input: ${JSON.stringify(c.input)}\n  error: ${(err as Error).message}`
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${cases.length} total`);

if (failed > 0) {
  process.exit(1);
}
