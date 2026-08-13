import assert from 'node:assert/strict';
import { csvParseLine } from './impl.ts';

let passed = 0;
function check(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed++;
}

function checkThrows(fn: () => void, label: string): void {
  assert.throws(fn, Error, label);
  passed++;
}

// --- Examples straight from SPEC.md ---
check(csvParseLine('a,b,c'), ['a', 'b', 'c'], 'simple unquoted fields');
check(csvParseLine('a,,c'), ['a', '', 'c'], 'empty middle field');
check(csvParseLine('"a,b",c'), ['a,b', 'c'], 'quoted field containing a comma');
check(csvParseLine('"a""b"'), ['a"b'], 'escaped quote inside quoted field');
check(csvParseLine('a"b'), ['a"b'], 'unquoted field with embedded quote (not at start)');
check(csvParseLine('"hi",,"x,y"'), ['hi', '', 'x,y'], 'mixed quoted/empty/quoted-with-comma');

// --- Empty-field rules ---
check(csvParseLine(''), [''], 'empty line yields single empty field');
check(csvParseLine('a,'), ['a', ''], 'trailing comma yields trailing empty field');
check(csvParseLine(','), ['', ''], 'lone comma yields two empty fields');
check(csvParseLine('"a",,"b"'), ['a', '', 'b'], 'empty field flanked by quoted fields');

// --- Quoting / escaping edge cases ---
check(csvParseLine('""'), [''], 'empty quoted field');
check(csvParseLine('"a"'), ['a'], 'single quoted field, no trailing comma/other fields');
check(csvParseLine('""""'), ['"'], 'quoted field containing a single escaped quote only');
check(csvParseLine('"a""""b"'), ['a""b'], 'two consecutive escaped quotes inside a field');
check(csvParseLine('" "'), [' '], 'quoted field preserves interior whitespace');
check(csvParseLine(' "a"'), [' "a"'], 'leading space makes the field unquoted (literal)');
check(csvParseLine('a,"b,c",d'), ['a', 'b,c', 'd'], 'quoted comma field sandwiched by unquoted fields');
check(
  csvParseLine('"a""b","c""""d"'),
  ['a"b', 'c""d'],
  'multiple quoted fields each with internal escaped quotes',
);
check(csvParseLine('a,b,'), ['a', 'b', ''], 'trailing comma after multiple unquoted fields');
check(csvParseLine('"a,b,c"'), ['a,b,c'], 'single quoted field containing multiple commas');
check(csvParseLine('a b,c d'), ['a b', 'c d'], 'unquoted fields preserve internal whitespace');

// --- Malformed input: must throw ---
checkThrows(() => csvParseLine('"abc'), 'unterminated quoted field throws');
checkThrows(() => csvParseLine('"a"b'), 'junk between closing quote and comma throws');
checkThrows(() => csvParseLine('"a"b,c'), 'junk after closing quote before later comma throws');
checkThrows(() => csvParseLine('a,"bc'), 'unterminated quote in second field throws');
checkThrows(() => csvParseLine('"a""'), 'trailing lone quote after escape leaves field unterminated');
checkThrows(() => csvParseLine('"a" extra text'), 'trailing junk with spaces after closing quote throws');

// --- Kill-probe style checks: verify the function actually distinguishes cases ---
// A field starting with a quote must strip the quotes (not return them verbatim).
assert.notDeepEqual(csvParseLine('"a"'), ['"a"'], 'quotes must be stripped, not left literal');
passed++;
// A field NOT starting with a quote must NOT strip a quote appearing later.
assert.notDeepEqual(csvParseLine('a"'), ['a'], 'quote must remain literal in unquoted field');
passed++;
// Escaped quote must collapse to one quote, not remain as two.
assert.notDeepEqual(csvParseLine('"a""b"'), ['a""b'], 'escaped "" must collapse to a single quote');
passed++;

console.log(`All ${passed} checks passed.`);
