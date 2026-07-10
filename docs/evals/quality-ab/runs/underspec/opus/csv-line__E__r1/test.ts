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
    failures.push(`${name}: threw ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (deepEqual(actual, expected)) {
    passed++;
  } else {
    failed++;
    failures.push(
      `${name}: input=${JSON.stringify(input)} expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`,
    );
  }
}

// --- Spec examples -------------------------------------------------------
check('plain three fields', 'a,b,c', ['a', 'b', 'c']);
check('quoted field with comma', '"a,b",c', ['a,b', 'c']);
check('escaped quote inside quoted', '"a""b"', ['a"b']);
check('non-leading quote is literal', 'a"b', ['a"b']);

// --- Empty / boundary records -------------------------------------------
check('empty line -> single empty field', '', ['']);
check('single comma -> two empty fields', ',', ['', '']);
check('trailing comma', 'a,', ['a', '']);
check('leading comma', ',a', ['', 'a']);
check('all empty', ',,', ['', '', '']);

// --- Quoting / escaping edge cases --------------------------------------
check('empty quoted field', '""', ['']);
check('two empty quoted fields', '"",""', ['', '']);
check('quoted spaces preserved', '"  x  "', ['  x  ']);
check('quoted comma-heavy value', '"x,y","z,w"', ['x,y', 'z,w']);
check('quoted then plain', '"hello, world",42', ['hello, world', '42']);
check('multiple escaped quotes', '"a"" b"" c"', ['a" b" c']);
check('trailing escaped quote', '"a"""', ['a"']);
check('unquoted mid quote then comma', 'a"b,c', ['a"b', 'c']);
check('empty quoted then plain', '"",abc', ['', 'abc']);

// --- "quoted iff first char is a quote" rule ----------------------------
check('leading space defeats quoting', ' "a"', [' "a"']);
check('unquoted whitespace preserved', ' a , b ', [' a ', ' b ']);
check('lone double quote in unquoted', 'ab"', ['ab"']);

// --- Newlines/tabs are just data on a single line -----------------------
check('tab preserved in unquoted', 'a\tb,c', ['a\tb', 'c']);
check('quoted field keeps inner quote pair only once', '"a""""b"', ['a""b']);

// --- Summary -------------------------------------------------------------
const total = passed + failed;
console.log(`csvParseLine tests: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
console.log('All checks passed.');
