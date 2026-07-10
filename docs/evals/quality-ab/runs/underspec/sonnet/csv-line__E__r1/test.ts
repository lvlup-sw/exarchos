import { csvParseLine } from './impl.ts';

interface Case {
  readonly name: string;
  readonly input: string;
  readonly expected: readonly string[];
}

const cases: Case[] = [
  { name: 'basic unquoted fields', input: 'a,b,c', expected: ['a', 'b', 'c'] },
  {
    name: 'quoted field containing a comma',
    input: '"a,b",c',
    expected: ['a,b', 'c'],
  },
  {
    name: 'escaped quote inside quoted field',
    input: '"a""b"',
    expected: ['a"b'],
  },
  {
    name: 'unquoted field with an embedded quote (literal, not escaped)',
    input: 'a"b',
    expected: ['a"b'],
  },
  { name: 'empty line yields one empty field', input: '', expected: [''] },
  {
    name: 'trailing comma yields trailing empty field',
    input: 'a,b,',
    expected: ['a', 'b', ''],
  },
  {
    name: 'leading comma yields leading empty field',
    input: ',a',
    expected: ['', 'a'],
  },
  { name: 'empty quoted field', input: '""', expected: [''] },
  {
    name: 'two empty quoted fields',
    input: '"",""',
    expected: ['', ''],
  },
  {
    name: 'consecutive commas produce empty middle field',
    input: 'a,,b',
    expected: ['a', '', 'b'],
  },
  {
    name: 'mixed quoted/unquoted fields with escaped quotes',
    input: '"a","b""c",d',
    expected: ['a', 'b"c', 'd'],
  },
  {
    name: 'nested escaped-quote triples',
    input: '"""a"""',
    expected: ['"a"'],
  },
  {
    name: 'whitespace is preserved literally in unquoted fields',
    input: '   a  , b ',
    expected: ['   a  ', ' b '],
  },
  {
    name: 'quoted field with comma and escaped quotes, multi-field',
    input: '"quoted with, comma","and ""quotes"" inside"',
    expected: ['quoted with, comma', 'and "quotes" inside'],
  },
  {
    name: 'unquoted field with quotes only in the middle stays literal',
    input: 'ab"cd"ef',
    expected: ['ab"cd"ef'],
  },
  {
    name: 'quoted field whose entire content is a comma',
    input: '","',
    expected: [','],
  },
];

let passed = 0;
let failed = 0;

for (const { name, input, expected } of cases) {
  let actual: string[];
  try {
    actual = csvParseLine(input);
  } catch (err) {
    failed++;
    console.error(`FAIL [${name}]: csvParseLine(${JSON.stringify(input)}) threw: ${String(err)}`);
    continue;
  }

  const ok =
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((v, idx) => v === expected[idx]);

  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL [${name}]: csvParseLine(${JSON.stringify(input)})\n` +
        `  expected: ${JSON.stringify(expected)}\n` +
        `  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

console.log(`\n${passed}/${cases.length} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
