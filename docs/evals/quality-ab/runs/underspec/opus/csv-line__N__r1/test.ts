import { csvParseLine } from './impl.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(name: string, input: string, expected: string[]): void {
  let actual: string[];
  try {
    actual = csvParseLine(input);
  } catch (err) {
    failed++;
    failures.push(
      `FAIL: ${name}\n  input:    ${JSON.stringify(input)}\n  threw:    ${String(err)}`,
    );
    return;
  }

  if (deepEqual(actual, expected)) {
    passed++;
  } else {
    failed++;
    failures.push(
      `FAIL: ${name}\n` +
        `  input:    ${JSON.stringify(input)}\n` +
        `  expected: ${JSON.stringify(expected)}\n` +
        `  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

// --- Spec examples --------------------------------------------------------
check('simple unquoted fields', 'a,b,c', ['a', 'b', 'c']);
check('quoted field with comma', '"a,b",c', ['a,b', 'c']);
check('escaped quotes inside quoted field', '"a""b"', ['a"b']);
check('unquoted field with interior quote', 'a"b', ['a"b']);

// --- Empty / boundary fields ---------------------------------------------
check('empty input -> single empty field', '', ['']);
check('single field', 'abc', ['abc']);
check('trailing comma -> trailing empty field', 'a,', ['a', '']);
check('leading comma -> leading empty field', ',a', ['', 'a']);
check('lone comma -> two empty fields', ',', ['', '']);
check('all empty fields', ',,', ['', '', '']);

// --- Quoting / escaping edge cases ---------------------------------------
check('empty quoted field', '""', ['']);
check('quoted field of a single escaped quote', '""""', ['"']);
check('empty quoted then value', '"",x', ['', 'x']);
check('two quoted fields', '"a","b"', ['a', 'b']);
check('quoted preserves whitespace', '" a "', [' a ']);
check('quoted field containing quotes and commas', '"he said ""hi"", bye"', [
  'he said "hi", bye',
]);
check('quoted field is only a comma', '","', [',']);
check('quoted then unquoted', '"a",b', ['a', 'b']);
check('unquoted then quoted', 'a,"b"', ['a', 'b']);

// --- Unquoted literalness ------------------------------------------------
check('unquoted preserves surrounding whitespace', ' a , b ', [' a ', ' b ']);
check('interior quotes stay literal when unquoted', 'a"b"c', ['a"b"c']);
check('unquoted mixed with quoted comma field', 'x,"y,z",w', ['x', 'y,z', 'w']);

// --- Tolerant handling of trailing text after a closing quote ------------
check('text after closing quote is appended literally', '"a"b', ['ab']);
check('quoted then trailing before comma', '"a"b,c', ['ab', 'c']);

// --- Unterminated quote (best-effort) ------------------------------------
check('unterminated quoted field consumes rest', '"abc', ['abc']);
check('unterminated quoted field with comma', '"a,b', ['a,b']);

// --- Summary --------------------------------------------------------------
const total = passed + failed;
if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  console.error('');
}
console.log(`csvParseLine: ${passed}/${total} checks passed.`);

if (failed > 0) {
  console.error(`csvParseLine: ${failed} check(s) FAILED.`);
  process.exit(1);
}
