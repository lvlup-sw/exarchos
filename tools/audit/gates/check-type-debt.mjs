#!/usr/bin/env node
/**
 * CI gate: a per-file budget for `as unknown as` casts in `src/`.
 *
 * Each file has one count budget, not one entry per cast. A symbol key cannot tell
 * casts in one file apart, and a line key changes on unrelated edits.
 *
 * A file over its budget fails. A file with casts and no budget fails. A budget above
 * the actual count prints a warning and does not fail, because cleanup lowers budgets
 * in batches with `--update`.
 *
 * The baseline records the census hash. A missing, malformed, or mismatched baseline
 * fails closed. Exit 0 when clean, 1 on violations, and 2 on a fail-closed or usage
 * error. `--update` writes a new baseline from the tree. `--baseline <path>` and
 * `--repo-root <path>` set the inputs.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_BASELINE_PATH = path.join(SCRIPT_DIR, 'type-debt-baseline.json');

export const EXIT_OK = 0;
export const EXIT_VIOLATIONS = 1;
export const EXIT_GATE_ERROR = 2;

/** Repo-relative roots the census walks. */
export const CENSUS_ROOTS = ['src'];
/** Only files matching this glob are in the typed surface the register governs. */
export const CENSUS_EXTENSION_GLOB = '**/*.ts';
/**
 * Exclusion globs. Tests, benches, declarations, and the helper and fixture directories
 * are not production debt. `embedded.ts` is generated output that `runtimes:guard` locks.
 */
export const EXCLUSION_GLOBS = [
  '**/*.test.ts',
  '**/*.bench.ts',
  '**/*.d.ts',
  '**/__tests__/**',
  '**/__shims__/**',
  '**/__mocks__/**',
  '**/__shared__/**',
  '**/evals/**',
  'src/install/runtimes/embedded.ts',
];

/**
 * Converts a glob to an anchored RegExp. `**` and a slash match zero or more segments,
 * `**` alone matches anything, and `*` matches anything except `/`. Other characters are literal.
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const CENSUS_EXTENSION_RE = globToRegExp(CENSUS_EXTENSION_GLOB);
const EXCLUSION_RES = EXCLUSION_GLOBS.map((glob) => globToRegExp(glob));

/**
 * Returns a SHA-256 digest of the census definition (roots, extension, and exclusion
 * globs), not of the tree. The gate rejects a baseline with a different hash.
 */
export function computeCensusHash() {
  const payload = JSON.stringify({
    roots: CENSUS_ROOTS,
    extension: CENSUS_EXTENSION_GLOB,
    excludes: EXCLUSION_GLOBS,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export const CENSUS_HASH = computeCensusHash();

function toPosixRel(repoRoot, full) {
  return path.relative(repoRoot, full).split(path.sep).join('/');
}

function isExcluded(rel) {
  return EXCLUSION_RES.some((re) => re.test(rel));
}

/**
 * A census path that exists but cannot be read, or a root that is not a directory. The
 * gate exits 2, so an I/O fault does not silently drop a source tree from the count.
 */
export class CensusError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CensusError';
  }
}

/**
 * Adds the census files under `dir` to `out`. A directory that disappears during the
 * walk is skipped. Any other read fault throws {@link CensusError}.
 */
function collectCensusFiles(dir, repoRoot, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw new CensusError(`census directory ${dir} is unreadable (${err && err.message ? err.message : String(err)})`);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectCensusFiles(full, repoRoot, out);
      continue;
    }
    if (!stat.isFile()) continue;
    const rel = toPosixRel(repoRoot, full);
    if (!CENSUS_EXTENSION_RE.test(rel)) continue;
    if (isExcluded(rel)) continue;
    out.push({ rel, full });
  }
}

/**
 * Lists each census file as a repo-relative POSIX path and an absolute path. A root that
 * does not exist counts as empty, so a partial tree works. An unreadable root, or a root
 * that is not a directory, throws {@link CensusError}.
 */
export function enumerateCensus(repoRoot) {
  const out = [];
  for (const root of CENSUS_ROOTS) {
    const rootPath = path.join(repoRoot, ...root.split('/'));
    let stat;
    try {
      stat = statSync(rootPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw new CensusError(
        `census root "${root}" is unreadable at ${rootPath} ` +
          `(${err && err.message ? err.message : String(err)}) — refusing to under-count type debt`,
      );
    }
    if (!stat.isDirectory()) {
      throw new CensusError(
        `census root "${root}" at ${rootPath} is not a directory — a configured census root must resolve ` +
          'to a directory; refusing to under-count type debt from a drifted/misconfigured root',
      );
    }
    collectCensusFiles(rootPath, repoRoot, out);
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

const AS_UNKNOWN_AS_RE = /\bas\s+unknown\s+as\b/g;

/** Count `as unknown as` occurrences in a source string. */
export function countTypeDebt(source) {
  const matches = source.match(AS_UNKNOWN_AS_RE);
  return matches ? matches.length : 0;
}

/**
 * Returns `{ rel -> count }` for each census file with a count above 0. A file read
 * fault throws {@link CensusError}, so it exits 2 and does not count as a violation.
 */
export function measureTree(repoRoot) {
  const counts = new Map();
  for (const { rel, full } of enumerateCensus(repoRoot)) {
    let source;
    try {
      source = readFileSync(full, 'utf8');
    } catch (err) {
      throw new CensusError(
        `census file ${rel} is unreadable (${err && err.message ? err.message : String(err)}) — refusing to under-count type debt`,
      );
    }
    const count = countTypeDebt(source);
    if (count > 0) counts.set(rel, count);
  }
  return counts;
}

export class BaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineError';
  }
}

/**
 * Validates a parsed baseline and returns `{ censusHash, files }`. It throws {@link BaselineError}
 * for a non-object, a missing or different `censusHash`, or a malformed `files` map.
 */
export function validateBaseline(raw, expectedHash, artifactLabel) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BaselineError(`${artifactLabel}: malformed baseline — expected a JSON object at the top level`);
  }
  if (typeof raw.censusHash !== 'string' || raw.censusHash.length === 0) {
    throw new BaselineError(
      `${artifactLabel}: provenance-less baseline — missing \`censusHash\`. A baseline with no ` +
        'recorded census definition cannot be trusted to govern this census. Regenerate with `--update`.',
    );
  }
  if (raw.censusHash !== expectedHash) {
    throw new BaselineError(
      `${artifactLabel}: census-hash mismatch — baseline was generated under a different census ` +
        `definition (baseline=${raw.censusHash}, current=${expectedHash}). A baseline generated under ` +
        'a different census cannot silently govern this one. Regenerate with `--update`.',
    );
  }
  if (raw.files === null || typeof raw.files !== 'object' || Array.isArray(raw.files)) {
    throw new BaselineError(`${artifactLabel}: malformed baseline — missing or non-object \`files\``);
  }
  const files = new Map();
  for (const [rel, budget] of Object.entries(raw.files)) {
    if (!Number.isInteger(budget) || budget < 0) {
      throw new BaselineError(
        `${artifactLabel}: malformed baseline — files["${rel}"] budget must be a non-negative integer ` +
          `(got ${JSON.stringify(budget)})`,
      );
    }
    files.set(rel, budget);
  }
  return { censusHash: raw.censusHash, files };
}

/** Reads and parses a baseline file. It throws {@link BaselineError} on a read or parse failure. */
export function readBaselineFile(baselinePath) {
  let raw;
  try {
    raw = readFileSync(baselinePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new BaselineError(
        `${baselinePath}: missing baseline — no type-debt baseline is checked in. ` +
          'Generate one with `node tools/audit/gates/check-type-debt.mjs --update`.',
      );
    }
    throw new BaselineError(`${baselinePath}: could not read baseline (${err.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new BaselineError(`${baselinePath}: unparseable baseline — not valid JSON (${err.message})`);
  }
}

/**
 * @typedef {{ rel: string, budget: number, actual: number }} OverBudget
 * @typedef {{ rel: string, actual: number }} Unbaselined
 * @typedef {{ rel: string, budget: number, actual: number }} StaleHigh
 */

/**
 * Compares the measured counts with the baseline budgets. A file with a nonzero budget
 * and no casts left is stale-high with an actual count of 0.
 * @returns {{ overBudget: OverBudget[], unbaselined: Unbaselined[], staleHigh: StaleHigh[], compliant: number }}
 */
export function diffAgainstBaseline(actualCounts, baselineFiles) {
  const overBudget = [];
  const unbaselined = [];
  const staleHigh = [];
  let compliant = 0;

  for (const [rel, actual] of actualCounts) {
    const budget = baselineFiles.has(rel) ? baselineFiles.get(rel) : undefined;
    if (budget === undefined) {
      unbaselined.push({ rel, actual });
    } else if (actual > budget) {
      overBudget.push({ rel, budget, actual });
    } else if (actual < budget) {
      staleHigh.push({ rel, budget, actual });
    } else {
      compliant++;
    }
  }
  for (const [rel, budget] of baselineFiles) {
    if (!actualCounts.has(rel) && budget > 0) {
      staleHigh.push({ rel, budget, actual: 0 });
    }
  }
  staleHigh.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  return { overBudget, unbaselined, staleHigh, compliant };
}

export function buildBaselineDocument(actualCounts, now = new Date()) {
  const files = {};
  for (const rel of [...actualCounts.keys()].sort()) {
    files[rel] = actualCounts.get(rel);
  }
  return {
    version: 1,
    instrument: 'tools/audit/gates/check-type-debt.mjs',
    censusHash: CENSUS_HASH,
    generatedAt: now.toISOString(),
    generatedVia: 'node tools/audit/gates/check-type-debt.mjs --update',
    files,
  };
}

function printUsage() {
  process.stderr.write(
    'Usage: check-type-debt.mjs [--update] [--baseline <path>] [--repo-root <path>]\n',
  );
}

function parseArgs(argv) {
  const args = { update: false, baseline: DEFAULT_BASELINE_PATH, repoRoot: REPO_ROOT };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(EXIT_OK);
    } else if (arg === '--update') {
      args.update = true;
    } else if (arg === '--baseline') {
      const value = argv[++i];
      if (!value) failUsage('--baseline requires a path argument');
      args.baseline = path.resolve(value);
    } else if (arg === '--repo-root') {
      const value = argv[++i];
      if (!value) failUsage('--repo-root requires a path argument');
      args.repoRoot = path.resolve(value);
    } else {
      failUsage(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function failUsage(msg) {
  process.stderr.write(`check-type-debt: ${msg}\n`);
  printUsage();
  process.exit(EXIT_GATE_ERROR);
}

function main() {
  const args = parseArgs(process.argv);
  let actualCounts;
  try {
    actualCounts = measureTree(args.repoRoot);
  } catch (err) {
    if (err instanceof CensusError) {
      process.stderr.write(`check-type-debt: FAIL CLOSED — ${err.message}\n`);
      process.exit(EXIT_GATE_ERROR);
    }
    throw err;
  }
  const total = [...actualCounts.values()].reduce((a, b) => a + b, 0);

  if (args.update) {
    const doc = buildBaselineDocument(actualCounts);
    writeFileSync(args.baseline, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `check-type-debt: baseline written to ${args.baseline} — ${actualCounts.size} file(s), ` +
        `${total} total \`as unknown as\` cast(s). censusHash=${CENSUS_HASH}\n`,
    );
    process.exit(EXIT_OK);
  }

  let baseline;
  try {
    const raw = readBaselineFile(args.baseline);
    baseline = validateBaseline(raw, CENSUS_HASH, args.baseline);
  } catch (err) {
    if (err instanceof BaselineError) {
      process.stderr.write(`check-type-debt: FAIL CLOSED — ${err.message}\n`);
      process.exit(EXIT_GATE_ERROR);
    }
    throw err;
  }

  const { overBudget, unbaselined, staleHigh, compliant } = diffAgainstBaseline(
    actualCounts,
    baseline.files,
  );

  for (const s of staleHigh) {
    process.stdout.write(
      `check-type-debt: WARN (stale-budget): ${s.rel} — budget=${s.budget} actual=${s.actual} ` +
        '(headroom unused; run --update to ratchet the budget down)\n',
    );
  }

  let failed = false;
  if (overBudget.length > 0) {
    failed = true;
    process.stderr.write(
      `check-type-debt: FAIL (over-budget): ${overBudget.length} file(s) exceed their baselined ` +
        '`as unknown as` budget:\n',
    );
    for (const v of overBudget) {
      process.stderr.write(`    ${v.rel}  budget=${v.budget} actual=${v.actual}\n`);
    }
  }
  if (unbaselined.length > 0) {
    failed = true;
    process.stderr.write(
      `check-type-debt: FAIL (unbaselined-debt): ${unbaselined.length} file(s) have \`as unknown as\` ` +
        'casts with no entry in type-debt-baseline.json:\n',
    );
    for (const v of unbaselined) {
      process.stderr.write(`    ${v.rel}  actual=${v.actual}\n`);
    }
  }

  if (failed) {
    process.stderr.write(
      '\nFix the casts (preferred) or run `node tools/audit/gates/check-type-debt.mjs --update` to record a ' +
        'deliberate, reviewed increase.\n',
    );
    process.exit(EXIT_VIOLATIONS);
  }

  process.stdout.write(
    `check-type-debt: OK — ${compliant + overBudget.length} baselined file(s) within budget, ` +
      `${staleHigh.length} stale-high warning(s), ${total} total cast(s) across ${actualCounts.size} ` +
      'file(s) in the current tree.\n',
  );
  process.exit(EXIT_OK);
}

function invokedAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  return (
    path.resolve(entry) === fileURLToPath(import.meta.url) ||
    entry.endsWith('/check-type-debt.mjs') ||
    entry.endsWith('\\check-type-debt.mjs')
  );
}

if (invokedAsCli()) {
  main();
}
