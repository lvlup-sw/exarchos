#!/usr/bin/env node
/**
 * CI gate: a test consolidation PR loses no pre-image test case.
 *
 * Each case in either pre-image, the legacy `__tests__` copy and the co-located
 * copy at the merge-base, must survive into the PR head. It survives in the
 * merged file or in the relocated `<base>.legacy.test.ts` sibling, verbatim up
 * to import-path rewrites, or as a textually proven duplicate. Equivalence is
 * textual only, so a divergent `vi.mock` preamble forces a relocation, never a
 * silent drop.
 *
 * The gate finds the merge-base, maps the changed files to `(area, basename)`
 * pairs, and runs `verifyCases` from `consolidate-suite.mjs` on each pair. A
 * pair counts only when both pre-images exist at the merge-base. This file owns
 * only the git plumbing, through an injectable git runner and repo root.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { verifyCases, EXIT_OK, EXIT_FINDING, EXIT_USAGE } from './consolidate-suite.mjs';

export { EXIT_OK, EXIT_FINDING, EXIT_USAGE };

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The repo root. `run` takes a `repoRoot` override for fixture tests. */
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
/** The governed source root, repo-relative in POSIX form. It prefixes each pair path. */
export const SRC_ROOT_REL = 'src';

/** @param {string} p */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Thrown when a git command fails unexpectedly, not for a path that is absent
 * at a valid ref. The gate fails closed on it, because a silent pass is the
 * failure that the gate exists to prevent.
 */
export class GitGateError extends Error {}

/** True when the git stderr says that a path is absent at a valid ref. */
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
 * Repo-relative POSIX paths changed between `fromRef` and `toRef`. Both refs
 * are resolved, so a non-zero exit is a git failure, not an empty diff. It
 * throws `GitGateError`.
 * @param {string} fromRef @param {string} toRef
 * @param {{ repoRoot: string, git: GitRunner }} ctx
 * @returns {string[]}
 */
export function changedPaths(fromRef, toRef, ctx) {
  const res = ctx.git(['diff', '--name-only', fromRef, toRef], ctx.repoRoot);
  if (res.status !== 0) {
    throw new GitGateError(
      `git diff --name-only ${fromRef} ${toRef} failed (status ${res.status}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * The blob at `ref:relPath`, or undefined when it did not exist at that ref.
 * Any other git failure throws `GitGateError`.
 * @param {string} ref @param {string} relPath
 * @param {{ repoRoot: string, git: GitRunner }} ctx
 * @returns {string | undefined}
 */
export function showAtRef(ref, relPath, ctx) {
  const res = ctx.git(['show', `${ref}:${relPath}`], ctx.repoRoot);
  if (res.status === 0) return res.stdout;
  if (isAbsentAtRef(res.stderr)) return undefined;
  throw new GitGateError(
    `git show ${ref}:${relPath} failed (status ${res.status}): ${res.stderr.trim()}`,
  );
}

/**
 * Maps the changed files of the PR to their `(area, basename)` pair ids. A file
 * belongs to pair `<area>/<base>` when it is:
 *   - the legacy copy   `<srcRootRel>/__tests__/<area>/<base>.test.ts`,
 *   - the canonical copy `<srcRootRel>/<area>/<base>.test.ts`, or
 *   - the relocated sibling `<srcRootRel>/<area>/<base>.legacy.test.ts`.
 * A test with no area subdirectory has no pair and is skipped. Pure.
 * @param {string[]} paths          Repo-relative POSIX changed paths.
 * @param {string} srcRootRel       The source root, for example `src`.
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
      const rel = p.slice(legacyPrefix.length);
      const area = path.posix.dirname(rel);
      if (area === '.') continue;
      const base = path.posix.basename(rel, '.test.ts');
      ids.add(`${area}/${base}`);
      continue;
    }

    if (p.startsWith(srcPrefix)) {
      const rel = p.slice(srcPrefix.length);
      const area = path.posix.dirname(rel);
      if (area === '.') continue;
      let base = path.posix.basename(rel, '.test.ts');
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
 * Verifies one touched pair. It rebuilds both pre-images from `base`, reads the
 * PR-head result files from disk, and runs `verifyCases`. When a pre-image is
 * absent at the base, the edit touches a lone test, and it returns `skipped`.
 * On a lone test, the two-way check can falsely block a legitimate case deletion.
 * @param {PairPaths} pp @param {string} base
 * @param {{ repoRoot: string, git: GitRunner }} ctx
 * @returns {PairResult}
 */
function verifyPair(pp, base, ctx) {
  const legacyPre = showAtRef(base, pp.legacyRel, ctx);
  const canonicalPre = showAtRef(base, pp.canonicalRel, ctx);
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
 * Runs the gate and returns an exit code. It never calls `process.exit`.
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
