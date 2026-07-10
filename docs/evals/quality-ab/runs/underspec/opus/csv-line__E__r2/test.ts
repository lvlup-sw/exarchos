import { csvParseLine } from './impl.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function check(name: string, input: string, expected: string[]): void {
  let actual: string[];
  try {
    actual = csvParseLine(input);
  } catch (err) {
    failed++;
    failures.push(`${name}: unexpectedly threw ${String(err)}`);
    return;
  }
  if (arraysEqual(actual, expected)) {
    passed++;
  } else {
    failed++;
    failures.push(
      `${name}: csvParseLine(${JSON.stringify(input)})\n` +
        `    expected ${JSON.stringify(expected)}\n` +
        `    actual   ${JSON.stringify(actual)}`,
    );
  }
}

// --- Spec examples (these pin the primary contract) ---
check('example: simple unquoted', 'a,b,c', ['a', 'b', 'c']);
check('example: quoted field with comma', '"a,b",c', ['a,b', 'c']);
check('example: escaped quote inside quotes', '"a""b"', ['a"b']);
check('example: quote in middle of unquoted field', 'a"b', ['a"b']);

// --- Quoting / escaping edge cases ---
check('quoted: entirely quoted with commas', '"a,b,c"', ['a,b,c']);
check('quoted: empty quoted field', '"",a', ['', 'a']);
check('quoted: two adjacent escaped quotes', '"a""""b"', ['a""b']);
check('quoted: escaped quote at start', '"""x"', ['"x']);
check('quoted: escaped quote at end', '"x"""', ['x"']);
check('quoted: only an escaped quote', '""""', ['"']);
check('quoted: surrounding quotes are stripped', '"hello"', ['hello']);
check('quoted: field with leading/trailing spaces kept', '" x "', [' x ']);
check('quoted: multiple quoted fields', '"a","b","c"', ['a', 'b', 'c']);
check('quoted: mix quoted and unquoted', 'a,"b,c",d', ['a', 'b,c', 'd']);

// --- Unquoted literal semantics ---
check('unquoted: quote not at start is literal', 'a"b,c', ['a"b', 'c']);
check('unquoted: whitespace preserved', '  a , b  ', ['  a ', ' b  ']);
check('unquoted: quote-heavy literal', 'a""b', ['a""b']);

// --- Empty / boundary fields ---
check('boundary: empty line is one empty field', '', ['']);
check('boundary: single comma -> two empty fields', ',', ['', '']);
check('boundary: leading empty field', ',a', ['', 'a']);
check('boundary: trailing empty field', 'a,', ['a', '']);
check('boundary: trailing empty after quoted', '"a",', ['a', '']);
check('boundary: multiple empties', ',,', ['', '', '']);

// --- Lenient malformed-input handling (well-defined by this impl) ---
check('malformed: unterminated quote keeps content', '"abc', ['abc']);
check('malformed: trailing chars after close quote', '"a"b', ['ab']);

// --- Guard: make sure the harness itself can fail (self-check) ---
{
  const control = arraysEqual(csvParseLine('a,b'), ['a', 'b']);
  const negativeControl = arraysEqual(csvParseLine('a,b'), ['a', 'b', 'c']);
  if (!control || negativeControl) {
    failed++;
    failures.push('self-check: equality helper is broken');
  } else {
    passed++;
  }
}

const total = passed + failed;
console.log(`\ncsvParseLine tests: ${passed}/${total} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('All checks passed.');
