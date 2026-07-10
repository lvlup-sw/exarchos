import { csvParseLine } from './impl.ts';

type Check = { name: string; pass: boolean; details?: string };

const checks: Check[] = [];

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  checks.push({
    name,
    pass,
    details: pass ? undefined : `expected ${e}, got ${a}`,
  });
}

// --- Basic unquoted fields ---
assertEqual('simple unquoted', csvParseLine('a,b,c'), ['a', 'b', 'c']);
assertEqual('single field', csvParseLine('a'), ['a']);
assertEqual('empty line -> one empty field', csvParseLine(''), ['']);
assertEqual(
  'whitespace preserved in unquoted field',
  csvParseLine(' a , b '),
  [' a ', ' b '],
);

// --- Empty fields via commas ---
assertEqual('trailing comma yields empty field', csvParseLine('a,'), ['a', '']);
assertEqual('leading comma yields empty field', csvParseLine(',a'), ['', 'a']);
assertEqual('only a comma', csvParseLine(','), ['', '']);
assertEqual('multiple empty fields', csvParseLine(',,'), ['', '', '']);

// --- Quoted fields ---
assertEqual('quoted field with comma', csvParseLine('"a,b",c'), ['a,b', 'c']);
assertEqual('quoted field with escaped quote', csvParseLine('"a""b"'), ['a"b']);
assertEqual(
  'quoted field with only escaped quotes',
  csvParseLine('"""quoted"""'),
  ['"quoted"'],
);
assertEqual('empty quoted field', csvParseLine('""'), ['']);
assertEqual('two empty quoted fields', csvParseLine('"",""'), ['', '']);
assertEqual(
  'quoted field then unquoted field',
  csvParseLine('"quoted with, comma","another"'),
  ['quoted with, comma', 'another'],
);
assertEqual(
  'quoted field followed by unquoted plain field',
  csvParseLine('"a",b'),
  ['a', 'b'],
);
assertEqual(
  'multiple quoted fields with escapes',
  csvParseLine('"a""b","c""""d"'),
  ['a"b', 'c""d'],
);

// --- Unquoted fields containing quotes NOT at the start ---
assertEqual('quote not at start is literal', csvParseLine('a"b'), ['a"b']);
assertEqual(
  'quote in middle across fields',
  csvParseLine('a"b,c"d'),
  ['a"b', 'c"d'],
);

// --- Mixed quoted/unquoted with surrounding empties ---
assertEqual(
  'quoted field at start, empty after',
  csvParseLine('"a",'),
  ['a', ''],
);
assertEqual(
  'empty first, quoted second',
  csvParseLine(',"b"'),
  ['', 'b'],
);

// --- Adjacency: quote immediately followed by comma, no content ---
assertEqual(
  'three quoted fields including comma-embedded',
  csvParseLine('"1","2,2","3"'),
  ['1', '2,2', '3'],
);

// --- Report ---
const failed = checks.filter((c) => !c.pass);
for (const c of checks) {
  const status = c.pass ? 'PASS' : 'FAIL';
  const suffix = c.pass ? '' : ` — ${c.details}`;
  console.log(`[${status}] ${c.name}${suffix}`);
}

console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed.`,
);

if (failed.length > 0) {
  console.error(`${failed.length} check(s) FAILED.`);
  process.exit(1);
}
