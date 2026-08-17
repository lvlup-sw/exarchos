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
    console.error(`FAIL: ${label} (expected throw, but none occurred)`);
  } catch (e) {
    if (e instanceof Error) {
      passed++;
      console.log(`PASS: ${label} (threw: ${e.message})`);
    } else {
      failed++;
      console.error(`FAIL: ${label} (threw non-Error: ${String(e)})`);
    }
  }
}

// --- Spec examples ---
assertEqual(csvParseLine('a,b,c'), ['a', 'b', 'c'], 'simple fields');
assertEqual(csvParseLine('a,,c'), ['a', '', 'c'], 'empty middle field');
assertEqual(csvParseLine('"a,b",c'), ['a,b', 'c'], 'quoted field with comma');
assertEqual(csvParseLine('"a""b"'), ['a"b'], 'escaped quote inside quoted field');
assertEqual(csvParseLine('a"b'), ['a"b'], 'unquoted literal quote mid-field');
assertEqual(
  csvParseLine('"hi",,"x,y"'),
  ['hi', '', 'x,y'],
  'mixed quoted/empty/quoted-with-comma',
);

// --- Basic structural rules ---
assertEqual(csvParseLine('a,'), ['a', ''], 'trailing comma yields trailing empty field');
assertEqual(csvParseLine(''), [''], 'empty string yields single empty field');
assertEqual(csvParseLine(','), ['', ''], 'lone comma yields two empty fields');
assertEqual(csvParseLine('a,b,'), ['a', 'b', ''], 'trailing comma after multiple fields');
assertEqual(csvParseLine(',a'), ['', 'a'], 'leading comma yields leading empty field');

// --- Quoting/escaping edge cases ---
assertEqual(csvParseLine('""'), [''], 'empty quoted field');
assertEqual(csvParseLine('"a"'), ['a'], 'simple quoted field, no special chars');
assertEqual(csvParseLine('""""'), ['"'], 'quoted field containing a single escaped quote');
assertEqual(
  csvParseLine('"a""""b"'),
  ['a""b'],
  'quoted field with two consecutive escaped quotes',
);
assertEqual(
  csvParseLine('"a","b""c",d'),
  ['a', 'b"c', 'd'],
  'quoted field with escape among plain fields',
);
assertEqual(
  csvParseLine('"","",""'),
  ['', '', ''],
  'three consecutive empty quoted fields',
);
assertEqual(
  csvParseLine('"a\nb",c'),
  ['a\nb', 'c'],
  'quoted field may contain embedded newline literally',
);
assertEqual(
  csvParseLine('"  a  ",b'),
  ['  a  ', 'b'],
  'whitespace inside quotes is preserved',
);
assertEqual(
  csvParseLine('  a  ,b'),
  ['  a  ', 'b'],
  'whitespace in unquoted field is preserved literally',
);
assertEqual(
  csvParseLine('a"b,c"d'),
  ['a"b', 'c"d'],
  'quote not at start of field is literal, per-field',
);
// --- Error cases ---
assertThrows(() => csvParseLine('"abc'), 'unterminated quoted field throws');
assertThrows(() => csvParseLine('""a'), 'junk immediately after empty quoted field throws');
assertThrows(() => csvParseLine('"a"b'), 'junk between closing quote and next comma throws');
assertThrows(() => csvParseLine('"a","b'), 'unterminated quoted field in later position throws');
assertThrows(() => csvParseLine('"a"b,c'), 'junk after closing quote before comma throws');
assertThrows(() => csvParseLine('a,"b'), 'unterminated quote after a valid first field throws');
assertThrows(() => csvParseLine('"'), 'single lone quote character is unterminated');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
