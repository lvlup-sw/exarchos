import { csvParseLine } from './impl.ts';

let passed = 0;
let failed = 0;

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertThrows(fn: () => void, label: string): void {
  try {
    fn();
    failed++;
    console.error(`FAIL: ${label} (expected throw, none occurred)`);
  } catch (err) {
    if (err instanceof Error) {
      passed++;
      console.log(`PASS: ${label} (threw: ${err.message})`);
    } else {
      failed++;
      console.error(`FAIL: ${label} (threw non-Error)`);
    }
  }
}

// --- Spec examples ---
assertEqual(csvParseLine('a,b,c'), ['a', 'b', 'c'], 'simple unquoted fields');
assertEqual(csvParseLine('a,,c'), ['a', '', 'c'], 'empty field in middle');
assertEqual(csvParseLine('"a,b",c'), ['a,b', 'c'], 'quoted field containing comma');
assertEqual(csvParseLine('"a""b"'), ['a"b'], 'escaped quote inside quoted field');
assertEqual(csvParseLine('a"b'), ['a"b'], 'unquoted field with embedded quote (literal)');
assertEqual(
  csvParseLine('"hi",,"x,y"'),
  ['hi', '', 'x,y'],
  'mix of quoted, empty, and quoted-with-comma fields'
);

// --- Additional rule coverage ---
assertEqual(csvParseLine(''), [''], 'empty string yields single empty field');
assertEqual(csvParseLine('a,'), ['a', ''], 'trailing comma yields trailing empty field');
assertEqual(csvParseLine(','), ['', ''], 'lone comma yields two empty fields');
assertEqual(csvParseLine('"a,,b"'), ['a,,b'], 'quoted field with multiple internal commas');
assertEqual(csvParseLine('""'), [''], 'empty quoted field');
assertEqual(csvParseLine('"",""'), ['', ''], 'two empty quoted fields');
assertEqual(
  csvParseLine('"a""""b"'),
  ['a""b'],
  'consecutive escaped quotes inside a quoted field'
);
assertEqual(
  csvParseLine('""""'),
  ['"'],
  'quoted field that is only an escaped quote'
);
assertEqual(
  csvParseLine('  a  , b '),
  ['  a  ', ' b '],
  'unquoted field preserves surrounding whitespace literally'
);
assertEqual(
  csvParseLine('a,"b,c",d'),
  ['a', 'b,c', 'd'],
  'quoted field mid-record surrounded by unquoted fields'
);
assertEqual(
  csvParseLine('"a"'),
  ['a'],
  'single quoted field, no trailing comma'
);
assertEqual(
  csvParseLine('a,b,'),
  ['a', 'b', ''],
  'trailing comma after multiple fields'
);
assertEqual(
  csvParseLine('"only","quoted","fields"'),
  ['only', 'quoted', 'fields'],
  'all-quoted record'
);

// --- Error cases ---
assertThrows(() => csvParseLine('"abc'), 'unterminated quoted field throws');
assertThrows(() => csvParseLine('"a"b'), 'junk after closing quote before end throws');
assertThrows(() => csvParseLine('"a","b"c,d'), 'junk after closing quote before comma throws');
assertThrows(() => csvParseLine('"'), 'lone opening quote throws');
assertThrows(() => csvParseLine('a,"b'), 'unterminated quote in later field throws');

// --- Kill-probe style checks: verify the two hallmark quoting behaviors independently ---
// A naive "split on comma" implementation would break this: comma inside quotes must NOT split.
assertEqual(csvParseLine('"a,b"').length, 1, 'quoted comma does not create extra field (length check)');
// A naive implementation with no unescape would keep the doubled quote.
assertEqual(csvParseLine('"""a"""'), ['"a"'], 'quote-wrapped field with escaped quotes at both ends');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
