import assert from 'node:assert/strict';
import { csvParseLine } from './impl.ts';

type Case = { name: string; input: string; expected: string[] };

const cases: Case[] = [
  { name: 'basic unquoted', input: 'a,b,c', expected: ['a', 'b', 'c'] },
  { name: 'quoted field with comma', input: '"a,b",c', expected: ['a,b', 'c'] },
  { name: 'escaped quote inside quoted field', input: '"a""b"', expected: ['a"b'] },
  { name: 'unquoted field with embedded quote', input: 'a"b', expected: ['a"b'] },
  { name: 'empty line', input: '', expected: [''] },
  { name: 'single comma (two empty fields)', input: ',', expected: ['', ''] },
  { name: 'trailing empty field', input: 'a,', expected: ['a', ''] },
  { name: 'leading empty field', input: ',a', expected: ['', 'a'] },
  { name: 'middle empty field', input: 'a,,b', expected: ['a', '', 'b'] },
  { name: 'empty quoted field', input: '""', expected: [''] },
  { name: 'quoted field followed by unquoted', input: '"x",y', expected: ['x', 'y'] },
  {
    name: 'quote+comma+escaped-quote combo, single field',
    input: '"say ""hi"", ok"',
    expected: ['say "hi", ok'],
  },
  {
    name: 'three fields, middle heavily escaped/quoted',
    input: 'x,"say ""hi""",y',
    expected: ['x', 'say "hi"', 'y'],
  },
  {
    name: 'unquoted field containing quote mid-string, followed by field',
    input: 'ab"cd,ef',
    expected: ['ab"cd', 'ef'],
  },
  {
    name: 'quoted field containing only a comma',
    input: '","',
    expected: [','],
  },
  {
    name: 'multiple quoted fields back to back',
    input: '"a","b","c"',
    expected: ['a', 'b', 'c'],
  },
  {
    name: 'unquoted field with internal whitespace preserved',
    input: '  a  , b ',
    expected: ['  a  ', ' b '],
  },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const c of cases) {
  try {
    const actual = csvParseLine(c.input);
    assert.deepStrictEqual(actual, c.expected);
    passed++;
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    failures.push(
      `FAIL: ${c.name}\n  input:    ${JSON.stringify(c.input)}\n  expected: ${JSON.stringify(
        c.expected
      )}\n  ${message}`
    );
  }
}

console.log(`csvParseLine tests: ${passed} passed, ${failed} failed (of ${cases.length})`);

if (failures.length > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
