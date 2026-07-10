import { csvParseLine } from './impl.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function eq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function fmt(v: readonly string[]): string {
  return JSON.stringify(v);
}

function check(name: string, input: string, expected: string[]): void {
  try {
    const actual = csvParseLine(input);
    if (eq(actual, expected)) {
      passed++;
    } else {
      failed++;
      failures.push(
        `  \u2717 ${name}\n      input:    ${JSON.stringify(input)}\n      expected: ${fmt(expected)}\n      actual:   ${fmt(actual)}`,
      );
    }
  } catch (err) {
    failed++;
    failures.push(`  \u2717 ${name} \u2014 threw ${String(err)} (input: ${JSON.stringify(input)})`);
  }
}

// --- Spec examples (the contract) ---------------------------------------
check('simple comma-separated', 'a,b,c', ['a', 'b', 'c']);
check('quoted field with embedded comma', '"a,b",c', ['a,b', 'c']);
check('escaped quote inside quoted field', '"a""b"', ['a"b']);
check('unquoted literal quote is kept', 'a"b', ['a"b']);

// --- Empty / edge structural cases --------------------------------------
check('empty line -> single empty field', '', ['']);
check('single unquoted field', 'abc', ['abc']);
check('trailing comma', 'a,', ['a', '']);
check('leading comma', ',a', ['', 'a']);
check('interior empty field', 'a,,b', ['a', '', 'b']);
check('all empty fields', ',,', ['', '', '']);

// --- Quoting edge cases --------------------------------------------------
check('quoted empty field', '""', ['']);
check('quoted empty then field', '"",a', ['', 'a']);
check('only an escaped quote', '""""', ['"']);
check('two quoted fields', '"a","b"', ['a', 'b']);
check('quoted preserves interior whitespace', '" a "', [' a ']);
check('unquoted preserves whitespace', ' a , b ', [' a ', ' b ']);
check(
  'quoted with escaped quotes and comma',
  '"he said ""hi"", ok",next',
  ['he said "hi", ok', 'next'],
);
check('newline inside quoted field is literal', '"a\nb"', ['a\nb']);

// --- Lenient / undocumented-but-must-not-crash cases --------------------
check('chars after closing quote appended', '"a"b', ['ab']);
check('unterminated quote consumes rest', '"abc', ['abc']);
check('quoted then quoted after junk', '"a"b,c', ['ab', 'c']);

// --- Summary ------------------------------------------------------------
console.log(`csvParseLine: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
