#!/usr/bin/env node
/**
 * manifest-gate-ci.mjs — the DR-2 textual-identity CI gate (Task 004).
 *
 * The primary, ci-gate-wired guarantee of the de-divergence campaign: on each
 * consolidation PR, prove that NO pre-image test case was lost. It is
 * bidirectional — every case in EITHER pre-image (the legacy `__tests__` copy
 * AND the co-located canonical copy at the merge-base) must survive into the
 * PR-HEAD result (the merged file or the relocated `<base>.legacy.test.ts`
 * sibling) verbatim modulo import-path rewrites, or be a textually-proven
 * duplicate. Equivalence is TEXTUAL only (no semantic hash), so a divergent
 * `vi.mock`/`vi.hoisted`/env preamble forces relocate, never a silent drop.
 *
 * Flow (mirrors the spec's "merge-base reconstruction, fetch-depth: 0"):
 *   1. merge-base = `git merge-base <base> <head>` (base defaults to origin/main).
 *   2. changed = `git diff --name-only <merge-base> <head>` — the PR's own edits.
 *   3. touched pairs = the (area, basename) subjects those changed files belong
 *      to (legacy copy, canonical copy, OR relocated sibling).
 *   4. For each touched pair, reconstruct BOTH pre-images from the merge-base
 *      (`git show <merge-base>:<path>`) and run the tool's verify logic against
 *      the PR-HEAD result files. A pair counts only when BOTH pre-images existed
 *      at the merge-base — i.e. it was a genuine two-directory pair. That guard
 *      is what stops the bidirectional check from false-blocking an ordinary PR
 *      that legitimately edits a lone co-located test with no legacy twin.
 *   5. Any lost/unproven case fails the gate (exit 1).
 *
 * REUSE, not reimplementation: the case extraction + textual-equivalence check
 * is the tool's exported `verifyCases` (the exact function `consolidate-suite
 * --verify` wraps). This gate owns only the git plumbing — with an INJECTABLE
 * git runner + repo root — so the whole gate is unit-testable against a
 * fixture/temp-git repo. (`consolidate-suite --verify` pins its git cwd + paths
 * to the tool's own REPO_ROOT, which cannot be pointed at a fixture repo; the
 * exported function is the same logic without that coupling.)
 *
 * The pure helpers (`deriveTouchedPairIds`, `resolvePairPaths`) and the git
 * primitives (`mergeBase`, `changedPaths`, `showAtRef`) are exported for tests.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { verifyCases, EXIT_OK, EXIT_FINDING, EXIT_USAGE } from './consolidate-suite.mjs';

export { EXIT_OK, EXIT_FINDING, EXIT_USAGE };

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The tool's repo root (scripts/audit/ → repo). Overridable for fixture tests. */
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
/** The governed source root, repo-RELATIVE (POSIX) — the pair-path prefix. */
export const SRC_ROOT_REL = 'servers/exarchos-mcp/src';

/** @param {string} p */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Thrown when a git command fails UNEXPECTEDLY (not a benign absent path/ref).
 * The gate must fail CLOSED on these rather than treat the failure as "nothing
 * to verify" — a silently-passing gate is the exact failure mode it exists to
 * prevent.
 */
export class GitGateError extends Error {}

/** git's stderr for a path that is absent at an (otherwise valid) ref. */
function isAbsentAtRef(stderr) {
  return /does not exist in |exists on disk, but not in /.test(stderr);
}

/**
 * The default git runner: `git <args>` in `cwd`, capturing stdout/status.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function defaultGit(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * @typedef {(args: string[], cwd: string) => { status: number, stdout: string, stderr: string }} GitRunner
 */

/**
 * The merge-base of `base` and `head`, or undefined when git cannot resolve one.
 * @param {string} base @param {string} head
 * @param {{ repoRoot: string, git: GitRunner }} ctx
 * @returns {string | undefined}
 */
export function mergeBase(base, head, ctx) {
  const res = ctx.git(['merge-base', base, head], ctx.repoRoot);
  if (res.status !== 0) return undefined;
  const sha = res.stdout.trim();
  return sha.length > 0 ? sha : undefined;
}

/**
 * Repo-relative POSIX paths changed between `fromRef` and `toRef`.
 * @param {string} fromRef @param {string} toRef
 * @param {{ repoRoot: string, git: GitRunner }} ctx
 * @returns {string[]}
 */
export function changedPaths(fromRef, toRef, ctx) {
  const res = ctx.git(['diff', '--name-only', fromRef, toRef], ctx.repoRoot);
  if (res.status !== 0) {
    // Both refs are already resolved (fromRef is the merge-base SHA, toRef the
    // validated head), so a non-zero diff is an unexpected/transient git failure,
    // NOT "no changes" — fail CLOSED rather than mistake it for an empty diff.
    throw new GitGateError(
      `git diff --name-only ${fromRef} ${toRef} failed (status ${res.status}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * The blob at `ref:relPath`, or undefined when it did not exist at that ref.
 * @param {string} ref @param {string} relPath
 * @param {{ repoRoot: string, git: GitRunner }} ctx
 * @returns {string | undefined}
 */
export function showAtRef(ref, relPath, ctx) {
  const res = ctx.git(['show', `${ref}:${relPath}`], ctx.repoRoot);
  if (res.status === 0) return res.stdout;
  // Distinguish a genuinely-absent path at an (otherwise valid) ref — the file
  // simply did not exist there, a benign "not a two-directory pair" signal —
  // from an unexpected git failure, which must fail CLOSED.
  if (isAbsentAtRef(res.stderr)) return undefined;
  throw new GitGateError(
    `git show ${ref}:${relPath} failed (status ${res.status}): ${res.stderr.trim()}`,
  );
}

/**
 * Map the PR's changed files to the set of `(area, basename)` pair ids they
 * belong to. A file participates in pair `<area>/<base>` when it is:
 *   - the legacy copy   `<srcRootRel>/__tests__/<area>/<base>.test.ts`,
 *   - the canonical copy `<srcRootRel>/<area>/<base>.test.ts`, or
 *   - the relocated sibling `<srcRootRel>/<area>/<base>.legacy.test.ts`.
 * A bare `<srcRootRel>/<base>.test.ts` (no area subdir) has no legacy mirror and
 * is skipped. Keyed strictly on `(area, basename)`. Pure.
 * @param {string[]} paths          Repo-relative POSIX changed paths.
 * @param {string} srcRootRel       e.g. `servers/exarchos-mcp/src`.
 * @returns {string[]}              Sorted, de-duplicated pair ids.
 */
export function deriveTouchedPairIds(paths, srcRootRel) {
  const legacyPrefix = `${srcRootRel}/__tests__/`;
  const srcPrefix = `${srcRootRel}/`;
  /** @type {Set<string>} */
  const ids = new Set();
  for (const raw of paths) {
    const p = toPosix(raw);
    if (!p.endsWith('.test.ts')) continue;

    if (p.startsWith(legacyPrefix)) {
      const rel = p.slice(legacyPrefix.length); // <area>/<base>.test.ts
      const area = path.posix.dirname(rel);
      if (area === '.') continue; // bare __tests__/<base>.test.ts — no co-located mirror
      const base = path.posix.basename(rel, '.test.ts');
      ids.add(`${area}/${base}`);
      continue;
    }

    if (p.startsWith(srcPrefix)) {
      const rel = p.slice(srcPrefix.length);
      const area = path.posix.dirname(rel);
      if (area === '.') continue; // bare co-located test at the src root — no pair
      let base = path.posix.basename(rel, '.test.ts');
      // A relocated sibling `<base>.legacy.test.ts` belongs to pair `<area>/<base>`.
      if (base.endsWith('.legacy')) base = base.slice(0, -'.legacy'.length);
      ids.add(`${area}/${base}`);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * @typedef {Object} PairPaths
 * @property {string} id
 * @property {string} area
 * @property {string} basename
 * @property {string} legacyRel        Repo-relative legacy `__tests__` copy.
 * @property {string} canonicalRel     Repo-relative co-located copy.
 * @property {string} relocatedRel     Repo-relative relocated `<base>.legacy.test.ts` sibling.
 * @property {string} legacyAbsDir     Absolute legacy dir (for import normalization).
 * @property {string} canonicalAbsDir  Absolute co-located dir.
 */

/**
 * Resolve a pair id to every path the gate needs (relative for git, absolute
 * dir for import normalization). Pure.
 * @param {string} id @param {string} srcRootRel @param {string} repoRoot
 * @returns {PairPaths}
 */
export function resolvePairPaths(id, srcRootRel, repoRoot) {
  const area = path.posix.dirname(id);
  const basename = path.posix.basename(id);
  const legacyRel = `${srcRootRel}/__tests__/${id}.test.ts`;
  const canonicalRel = `${srcRootRel}/${id}.test.ts`;
  const relocatedRel = `${srcRootRel}/${area}/${basename}.legacy.test.ts`;
  return {
    id,
    area,
    basename,
    legacyRel,
    canonicalRel,
    relocatedRel,
    legacyAbsDir: path.join(repoRoot, srcRootRel, '__tests__', area),
    canonicalAbsDir: path.join(repoRoot, srcRootRel, area),
  };
}

/**
 * @typedef {Object} PairResult
 * @property {string} id
 * @property {'ok'|'lost'|'skipped'} status
 * @property {{ side: 'legacy'|'canonical', text: string }[]} lost
 * @property {number} preimageCases
 * @property {number} resultCases
 */

/**
 * Verify a single touched pair: reconstruct both pre-images from `base`, gather
 * the PR-HEAD result files from disk, and run the tool's `verifyCases`. Returns
 * `skipped` when the pair was not a genuine two-directory pair at the base
 * (either pre-image missing) — nothing to prove.
 * @param {PairPaths} pp @param {string} base
 * @param {{ repoRoot: string, git: GitRunner }} ctx
 * @returns {PairResult}
 */
function verifyPair(pp, base, ctx) {
  const legacyPre = showAtRef(base, pp.legacyRel, ctx);
  const canonicalPre = showAtRef(base, pp.canonicalRel, ctx);
  // A genuine pair existed in BOTH directories at the base. If either is
  // missing this is an ordinary edit to a lone test, not a consolidation —
  // running the bidirectional check would false-block a legitimate case
  // deletion, so skip it.
  if (legacyPre === undefined || canonicalPre === undefined) {
    return { id: pp.id, status: 'skipped', lost: [], preimageCases: 0, resultCases: 0 };
  }

  /** @type {{ text: string, absDir: string }[]} */
  const resultFiles = [];
  const canonicalAbs = path.join(ctx.repoRoot, pp.canonicalRel);
  if (existsSync(canonicalAbs)) {
    resultFiles.push({ text: readFileSync(canonicalAbs, 'utf8'), absDir: pp.canonicalAbsDir });
  }
  const relocatedAbs = path.join(ctx.repoRoot, pp.relocatedRel);
  if (existsSync(relocatedAbs)) {
    resultFiles.push({ text: readFileSync(relocatedAbs, 'utf8'), absDir: pp.canonicalAbsDir });
  }

  const report = verifyCases(
    { text: legacyPre, absDir: pp.legacyAbsDir },
    { text: canonicalPre, absDir: pp.canonicalAbsDir },
    resultFiles,
  );
  return {
    id: pp.id,
    status: report.ok ? 'ok' : 'lost',
    lost: report.lost,
    preimageCases: report.preimageCases,
    resultCases: report.resultCases,
  };
}

/**
 * Run the gate. Returns an exit code; never calls `process.exit`. All I/O goes
 * through the injected `log`/`errlog`, and all git through the injected runner,
 * so the whole gate is unit-testable against a fixture repo.
 * @param {{
 *   base?: string,
 *   head?: string,
 *   repoRoot?: string,
 *   srcRootRel?: string,
 *   git?: GitRunner,
 *   log?: (m: string) => void,
 *   errlog?: (m: string) => void,
 * }} [opts]
 * @returns {number}
 */
export function run(opts = {}) {
  const log = opts.log ?? ((m) => process.stdout.write(`${m}\n`));
  const errlog = opts.errlog ?? ((m) => process.stderr.write(`${m}\n`));
  const base = opts.base ?? 'origin/main';
  const head = opts.head ?? 'HEAD';
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const srcRootRel = opts.srcRootRel ?? SRC_ROOT_REL;
  const git = opts.git ?? defaultGit;
  const ctx = { repoRoot, git };

  try {
    const mb = mergeBase(base, head, ctx);
    if (!mb) {
      errlog(`[manifest-gate] could not compute merge-base of ${base}..${head} — cannot run the gate.`);
      return EXIT_USAGE;
    }

    const changed = changedPaths(mb, head, ctx);
    const touched = deriveTouchedPairIds(changed, srcRootRel);
    if (touched.length === 0) {
      log(`[manifest-gate] OK — no consolidation pair touched in ${base}..${head} (merge-base ${mb.slice(0, 12)}).`);
      return EXIT_OK;
    }

    /** @type {PairResult[]} */
    const failed = [];
    let verified = 0;
    for (const id of touched) {
      const result = verifyPair(resolvePairPaths(id, srcRootRel, repoRoot), mb, ctx);
      if (result.status === 'skipped') continue;
      verified++;
      if (result.status === 'lost') failed.push(result);
      else log(`[manifest-gate] ${id}: OK — ${result.preimageCases} pre-image case(s) preserved.`);
    }

    if (failed.length === 0) {
      log(`[manifest-gate] OK — ${verified} touched consolidation pair(s) preserved every pre-image case.`);
      return EXIT_OK;
    }

    errlog(`[manifest-gate] FAIL — ${failed.length} pair(s) dropped a pre-image case (merge-base ${mb.slice(0, 12)}):`);
    for (const f of failed) {
      errlog(`  ${f.id}: ${f.lost.length} lost/unproven case(s)`);
      for (const c of f.lost) errlog(`    (${c.side}) ${c.text.split('\n')[0].slice(0, 120)}`);
    }
    return EXIT_FINDING;
  } catch (e) {
    // A git command failed unexpectedly — fail CLOSED. Never let a transient git
    // error read as "no pairs touched" / "case absent" and pass the gate silently.
    if (e instanceof GitGateError) {
      errlog(`[manifest-gate] FAIL (fail-closed) — ${e.message}`);
      return EXIT_USAGE;
    }
    throw e;
  }
}

/**
 * Parse `--base <ref>` / `--head <ref>` / `--src <repo-rel-dir>` from argv.
 * @param {string[]} argv
 * @returns {{ base?: string, head?: string, srcRootRel?: string }}
 */
function parseArgs(argv) {
  /** @type {{ base?: string, head?: string, srcRootRel?: string }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--head') out.head = argv[++i];
    else if (argv[i] === '--src') out.srcRootRel = argv[++i];
  }
  return out;
}

/** True when this module is the process entry point (not an import). */
function invokedAsCli() {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsCli()) {
  process.exit(run(parseArgs(process.argv.slice(2))));
}
