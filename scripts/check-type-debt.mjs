#!/usr/bin/env node
/**
 * check-type-debt — per-file `as unknown as` count-budget register (DR-9, DR-10).
 *
 * The register's identity function is a PER-FILE COUNT BUDGET, not an entry
 * keyed on `{symbol,file}` / `{file,line,col}` / content-hash (DR-9's Rejected
 * Identities note: a symbol/file key can't distinguish multiple casts in one
 * file; `{file,line,col}` churns on unrelated edits — the 532-fix tsconfig
 * wave in PR #1714 would have invalidated such a register wholesale).
 *
 * CENSUS (pinned — the exclusion list below IS the census definition; the
 * baseline is regenerable from it, never hand-edited):
 *   - roots: `src/**`, `servers/exarchos-mcp/src/**`
 *   - only `*.ts` files
 *   - excluding (at any depth) `*.test.ts`, `*.bench.ts`, `*.d.ts`,
 *     `__tests__/`, `__shims__/`, `__mocks__/`, `__shared__/`, `evals/`
 *     (eval-harness fixture code is not production debt; see EXCLUSION_GLOBS
 *     below for the exact globs), and
 *     `src/runtimes/embedded.ts` (generated output locked by `runtimes:guard`
 *     — its casts are codegen's, not hand debt).
 *
 * RATCHET SEMANTICS (mirrors the wave-1 ratchet idiom — `scripts/audit/`
 * cycle-gate.ts / knip-diff.ts):
 *   - a file whose actual count EXCEEDS its baselined budget FAILS
 *     (over-budget: new debt introduced, or a shrunk budget not honored).
 *   - a file absent from the baseline with actual count > 0 FAILS
 *     (unbaselined debt: nothing authorizes casts in this file at all).
 *   - a "stale-high" budget (baseline ABOVE actual — the file improved but the
 *     budget was never ratcheted down) is a non-failing WARNING, not a FAIL.
 *     This deliberately follows knip-diff's `stale` precedent (a hygiene
 *     warning), not cycle-gate's `phantom` precedent (a hard FAIL), because:
 *       (a) DR-9's own acceptance criteria enumerate exactly four required
 *           self-test directions (over-budget FAILS, fresh-baseline PASSES,
 *           missing-baseline FAILS CLOSED, hash-mismatch FAILS CLOSED) — a
 *           stale-high FAIL is conspicuously absent from that list;
 *       (b) cycle-gate's phantom entries are RARE, discrete, named edges —
 *           failing forces prompt cleanup of a short exception ledger. Cast
 *           counts move on nearly every unrelated diff; treating every
 *           per-file improvement as a hard CI failure would make routine
 *           incremental cleanup adversarial instead of the deliberate,
 *           batched `--update` action the design calls for ("future fix
 *           waves ratchet it down mechanically").
 *     A stale-high budget is reported to stdout so it stays visible, but it
 *     never fails the gate.
 *
 * PROVENANCE (DR-10): the baseline records the generating script's
 * CENSUS-DEFINITION HASH (a stable digest of the roots/extension/exclusion-
 * glob list below) plus how it was produced (`--update`). The gate REJECTS a
 * baseline whose hash does not match its own, or that carries no hash at all
 * (provenance-less) — a baseline generated under a different census cannot
 * silently govern this one (FAIL CLOSED).
 *
 * FAIL-CLOSED (DR-8/DR-10): missing baseline, unparseable/malformed baseline
 * JSON, and census-hash mismatch all FAIL CLOSED (exit 2) with a message
 * naming the artifact and the reason — never a silent pass.
 *
 *   Exit 0 — clean (no over-budget / unbaselined file; stale-high budgets, if
 *            any, are logged as non-failing warnings).
 *   Exit 1 — one or more files are over budget or carry unbaselined debt.
 *   Exit 2 — fail-closed: missing/unparseable/provenance-less/mismatched
 *            baseline, or a usage error.
 *
 * Flags:
 *   --update             Regenerate the baseline from the current tree and
 *                         write it to --baseline (default: this repo's
 *                         checked-in `scripts/type-debt-baseline.json`).
 *   --baseline <path>    Baseline file to read/write. Default: the checked-in
 *                         `scripts/type-debt-baseline.json`.
 *   --repo-root <path>   Root the census roots (`src`, `servers/exarchos-mcp/
 *                         src`) resolve against. Default: this repo's root.
 *                         (Testability seam — production always uses the
 *                         real repo root.)
 *   --help               Show usage.
 *
 * Zero runtime dependencies: only Node built-ins (fs, path, crypto, url).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_BASELINE_PATH = path.join(SCRIPT_DIR, 'type-debt-baseline.json');

export const EXIT_OK = 0;
export const EXIT_VIOLATIONS = 1;
export const EXIT_GATE_ERROR = 2;

// ─── census definition (the exclusion list IS the census — DR-9) ───────────

/** Repo-relative roots the census walks. */
export const CENSUS_ROOTS = ['src', 'servers/exarchos-mcp/src'];
/** Only files matching this glob are in the typed surface the register governs. */
export const CENSUS_EXTENSION_GLOB = '**/*.ts';
/** Exclusion globs — see the module header for the rationale of each. */
export const EXCLUSION_GLOBS = [
  '**/*.test.ts',
  '**/*.bench.ts',
  '**/*.d.ts',
  '**/__tests__/**',
  '**/__shims__/**',
  '**/__mocks__/**',
  '**/__shared__/**',
  '**/evals/**',
  'src/runtimes/embedded.ts',
];

/**
 * Translate a `**`/`*` glob into an anchored RegExp. Supports only the two
 * wildcard forms the census definition actually uses:
 *   - `**\/` — zero or more path segments (optional leading prefix)
 *   - `**` (not followed by `/`) — anything, including `/`
 *   - `*` — anything except `/`
 * Everything else is treated as a literal (regex-escaped).
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
 * Stable digest of the census DEFINITION (roots + extension + exclusion
 * globs) — NOT of the tree it is applied to. A baseline records this hash;
 * the gate rejects a baseline whose hash differs (DR-9 provenance).
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
 * A configured census root is unavailable in a way that is NOT "legitimately
 * absent" (ENOENT) — it exists but can't be read, or isn't a directory. Failing
 * closed here (exit 2) keeps an I/O failure or path drift from silently dropping
 * an entire source tree from enforcement (DR-9/DR-10).
 */
export class CensusError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CensusError';
  }
}

function collectCensusFiles(dir, repoRoot, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // A subdirectory that vanished mid-walk (ENOENT — a race) is benign. Any
    // other read failure on a directory we already confirmed exists is a real
    // I/O fault — fail closed rather than under-count (DR-10). Configured
    // ROOTS are validated up-front in `enumerateCensus`.
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

/** Enumerate every census file (repo-relative posix path + absolute path). */
export function enumerateCensus(repoRoot) {
  const out = [];
  for (const root of CENSUS_ROOTS) {
    const rootPath = path.join(repoRoot, ...root.split('/'));
    let stat;
    try {
      stat = statSync(rootPath);
    } catch (err) {
      // ENOENT — a configured root that simply does not exist in THIS tree is
      // legitimately absent (empty), not a gate error: partial trees (a
      // repo-root check with no `servers/exarchos-mcp/src`, or a fixture with
      // only `src/`) depend on this. Any OTHER stat failure (EACCES, EIO, …)
      // means the root IS present but unreadable — fail closed rather than
      // silently drop an entire source tree from enforcement (DR-10).
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

// ─── counting ────────────────────────────────────────────────────────────────

const AS_UNKNOWN_AS_RE = /\bas\s+unknown\s+as\b/g;

/** Count `as unknown as` occurrences in a source string. */
export function countTypeDebt(source) {
  const matches = source.match(AS_UNKNOWN_AS_RE);
  return matches ? matches.length : 0;
}

/** Build `{ rel -> count }` for every census file with count > 0. */
export function measureTree(repoRoot) {
  const counts = new Map();
  for (const { rel, full } of enumerateCensus(repoRoot)) {
    const count = countTypeDebt(readFileSync(full, 'utf8'));
    if (count > 0) counts.set(rel, count);
  }
  return counts;
}

// ─── baseline load/validate ──────────────────────────────────────────────────

export class BaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineError';
  }
}

/**
 * Validate a parsed baseline document. Throws {@link BaselineError} naming the
 * artifact + reason on any fail-closed condition: not an object, missing/
 * malformed `files`, or a missing/mismatched `censusHash` (DR-9 provenance).
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

/** Read + JSON.parse a baseline file, throwing {@link BaselineError} on any I/O or parse failure. */
export function readBaselineFile(baselinePath) {
  let raw;
  try {
    raw = readFileSync(baselinePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new BaselineError(
        `${baselinePath}: missing baseline — no type-debt baseline is checked in. ` +
          'Generate one with `node scripts/check-type-debt.mjs --update`.',
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

// ─── diff ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ rel: string, budget: number, actual: number }} OverBudget
 * @typedef {{ rel: string, actual: number }} Unbaselined
 * @typedef {{ rel: string, budget: number, actual: number }} StaleHigh
 */

/**
 * Diff the measured tree against a validated baseline.
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
  // Baseline entries with zero actual casts left (file fixed entirely, or
  // deleted/excluded since baselining) are the actual===0 case of stale-high.
  for (const [rel, budget] of baselineFiles) {
    if (!actualCounts.has(rel) && budget > 0) {
      staleHigh.push({ rel, budget, actual: 0 });
    }
  }
  staleHigh.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  return { overBudget, unbaselined, staleHigh, compliant };
}

// ─── baseline (de)serialization ──────────────────────────────────────────────

export function buildBaselineDocument(actualCounts, now = new Date()) {
  const files = {};
  for (const rel of [...actualCounts.keys()].sort()) {
    files[rel] = actualCounts.get(rel);
  }
  return {
    version: 1,
    instrument: 'scripts/check-type-debt.mjs',
    censusHash: CENSUS_HASH,
    generatedAt: now.toISOString(),
    generatedVia: 'node scripts/check-type-debt.mjs --update',
    files,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

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
      '\nFix the casts (preferred) or run `node scripts/check-type-debt.mjs --update` to record a ' +
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
