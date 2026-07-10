import { csvParseLine } from './impl.ts';

type TestCase = {
  name: string;
  input: string;
  expected: string[];
};

const cases: TestCase[] = [
  { name: 'simple unquoted fields', input: 'a,b,c', expected: ['a', 'b', 'c'] },
  { name: 'quoted field containing a comma', input: '"a,b",c', expected: ['a,b', 'c'] },
  { name: 'escaped double quote inside quoted field', input: '"a""b"', expected: ['a"b'] },
  { name: 'unquoted field with embedded quote (not at start)', input: 'a"b', expected: ['a"b'] },
  { name: 'empty line yields a single empty field', input: '', expected: [''] },
  { name: 'trailing comma yields trailing empty field', input: 'a,', expected: ['a', ''] },
  { name: 'leading comma yields leading empty field', input: ',a', expected: ['', 'a'] },
  { name: 'empty quoted field', input: '""', expected: [''] },
  { name: 'two empty quoted fields', input: '"",""', expected: ['', ''] },
  { name: 'quoted field with multiple commas', input: '"a,b,c"', expected: ['a,b,c'] },
  {
    name: 'multiple escaped quotes with surrounding text',
    input: '"say ""hi"" now"',
    expected: ['say "hi" now'],
  },
  { name: 'mixed quoted and unquoted fields', input: 'a,"b,c",d', expected: ['a', 'b,c', 'd'] },
  { name: 'single quoted field, no special chars', input: '"a"', expected: ['a'] },
  {
    name: 'quoted field with two escaped quotes back-to-back',
    input: 'a,b,"c""d""e"',
    expected: ['a', 'b', 'c"d"e'],
  },
  {
    name: 'field starting with quote but only that char',
    input: '"',
    expected: [''],
  },
  {
    name: 'whitespace preserved in unquoted field',
    input: '  a  ,b',
    expected: ['  a  ', 'b'],
  },
];

let failures = 0;

for (const { name, input, expected } of cases) {
  let actual: string[];
  try {
    actual = csvParseLine(input);
  } catch (err) {
    console.error(`FAIL [${name}]: csvParseLine(${JSON.stringify(input)}) threw: ${String(err)}`);
    failures++;
    continue;
  }

  const pass =
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((v, idx) => v === expected[idx]);

  if (pass) {
    console.log(`PASS [${name}]: csvParseLine(${JSON.stringify(input)}) -> ${JSON.stringify(actual)}`);
  } else {
    console.error(
      `FAIL [${name}]: csvParseLine(${JSON.stringify(input)}) -> ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
    );
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${cases.length} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${cases.length} tests passed.`);
}
