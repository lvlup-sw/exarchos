import { csvParseLine } from './impl.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function arrEq(a: readonly string[], b: readonly string[]): boolean {
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
    failures.push(
      `${name}: threw ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (arrEq(actual, expected)) {
    passed++;
  } else {
    failed++;
    failures.push(
      `${name}: input=${JSON.stringify(input)} ` +
        `expected=${JSON.stringify(expected)} ` +
        `actual=${JSON.stringify(actual)}`,
    );
  }
}

// --- Spec examples ---------------------------------------------------------
check('simple triple', 'a,b,c', ['a', 'b', 'c']);
check('quoted with comma', '"a,b",c', ['a,b', 'c']);
check('escaped quote inside quoted', '"a""b"', ['a"b']);
check('unquoted with interior quote', 'a"b', ['a"b']);

// --- Empty / boundary fields ----------------------------------------------
check('empty line -> single empty field', '', ['']);
check('single field', 'abc', ['abc']);
check('trailing empty field', 'a,', ['a', '']);
check('leading empty field', ',a', ['', 'a']);
check('two empty fields', ',', ['', '']);
check('three empty fields', ',,', ['', '', '']);
check('empty quoted field', '""', ['']);
check('quoted then empty', '"a",', ['a', '']);

// --- Quoting / escaping edge cases ----------------------------------------
check('only escaped quote', '""""', ['"']);
check('escaped quotes around text', '"""x"""', ['"x"']);
check('quoted comma-only', '","', [',']);
check('quoted with multiple commas', '"a,b,c"', ['a,b,c']);
check('mixed quoted and unquoted', '"a,b",c,"d""e"', ['a,b', 'c', 'd"e']);
check('two quoted fields', '"x","y"', ['x', 'y']);

// --- Whitespace handling ---------------------------------------------------
check('unquoted preserves spaces', ' a , b ', [' a ', ' b ']);
check('quoted preserves interior spaces', '" a "', [' a ']);
check('quoted leading space (quote is first char)', '"  "', ['  ']);

// --- Non-leading quotes in unquoted fields --------------------------------
check('quote at end of unquoted', 'ab"', ['ab"']);
check('multiple interior quotes', 'a"b"c', ['a"b"c']);

// --- Documented extension behavior (RFC-undefined territory) --------------
// Characters after the closing quote and before a comma are appended.
check('trailing text after closing quote', '"a"b', ['ab']);
check('trailing text after closing quote, then field', '"a"b,c', ['ab', 'c']);
// Unterminated quote consumes the rest of the line as the value.
check('unterminated quote', '"abc', ['abc']);

// --- Summary ---------------------------------------------------------------
const total = passed + failed;
if (failed > 0) {
  console.error(`\ncsvParseLine: ${passed}/${total} passed, ${failed} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log(`csvParseLine: ${passed}/${total} passed — all green ✓`);
}
