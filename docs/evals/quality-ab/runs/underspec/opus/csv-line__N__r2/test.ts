import { csvParseLine } from './impl.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, input: string, expected: string[]): void {
  const actual = csvParseLine(input);
  const ok =
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((v, idx) => v === expected[idx]);

  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(
      `FAIL ${name}: csvParseLine(${JSON.stringify(input)}) => ${JSON.stringify(
        actual,
      )}, expected ${JSON.stringify(expected)}`,
    );
  }
}

// --- Spec examples -------------------------------------------------------
check('simple', 'a,b,c', ['a', 'b', 'c']);
check('quoted-with-comma', '"a,b",c', ['a,b', 'c']);
check('escaped-quote', '"a""b"', ['a"b']);
check('bare-quote-in-unquoted', 'a"b', ['a"b']);

// --- Empty / edge fields -------------------------------------------------
check('empty-line', '', ['']);
check('empty-quoted', '""', ['']);
check('single-escaped-quote', '""""', ['"']);
check('lone-comma', ',', ['', '']);
check('trailing-comma', 'a,b,', ['a', 'b', '']);
check('leading-comma', ',a', ['', 'a']);
check('all-empty', ',,', ['', '', '']);

// --- Quoting behavior ----------------------------------------------------
check('quoted-then-plain', 'a,"b,c",d', ['a', 'b,c', 'd']);
check('quoted-only', '"a,b"', ['a,b']);
check('quoted-empty-then-value', '"",x', ['', 'x']);
check('embedded-escaped-quote', '"quoted with "" inside"', ['quoted with " inside']);

// --- Whitespace preserved in unquoted fields -----------------------------
check('whitespace-unquoted', '  a , b ', ['  a ', ' b ']);
check('quote-not-at-start', 'x"y",z', ['x"y"', 'z']);

// --- Documented lenient behavior (implementation choices) ----------------
// Text after a closing quote (before the comma) is appended literally.
check('trailing-after-close', '"a"bc,d', ['abc', 'd']);
// An unterminated quote consumes the rest of the line.
check('unterminated-quote', '"unterminated', ['unterminated']);
check('unterminated-with-escape', '"a""b', ['a"b']);

// --- Report --------------------------------------------------------------
const total = passed + failed;
if (failed > 0) {
  for (const f of failures) {
    console.error(f);
  }
  console.error(`\ncsvParseLine: ${passed}/${total} checks passed, ${failed} FAILED.`);
  process.exit(1);
} else {
  console.log(`csvParseLine: all ${total} checks passed.`);
}
