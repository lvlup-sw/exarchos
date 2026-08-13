#!/usr/bin/env node
/**
 * check-protected.mjs — DR-5 keep-class protected-file inventory + pre-flight guard (task 002).
 *
 * The test-mass-consolidation campaign (docs/specs/2026-07-18-test-mass-consolidation.md)
 * must never touch a dedicated **keep-class** suite: parity, race, property,
 * characterization, acceptance — plus the shared `parity-harness.ts` they lean on.
 * Keep-class status is by **dedicated-suite SUFFIX**, never by a file merely
 * importing `fast-check` or another test utility (e.g.
 * `events/tools.test.ts` imports fast-check but is a mixed consolidation
 * TARGET, not protected — its property cases relocate/merge verbatim).
 *
 * Two modes:
 *
 *   --regenerate   Walk the LIVE tree under every protected root and
 *                  rewrite the committed `protected-suites.json` snapshot.
 *                  The inventory is GENERATED, never hand-listed, so it can't
 *                  silently drift from the tree it describes.
 *   (default)      Guard mode: read a change-set (CLI args, else piped stdin
 *                  — one path per line —, else `git diff --name-only HEAD` as
 *                  a convenience fallback) and FAIL (exit 1) if it intersects
 *                  any keep-class protected file. Checks BOTH the committed
 *                  snapshot AND a live suffix/area re-derivation of each
 *                  changed path, so a brand-new file matching a keep-class
 *                  glob is still caught even if the snapshot is stale —
 *                  closing the drift gap the snapshot alone can't.
 *
 * The pure functions below (`isKeepClassRelPath`, `discoverProtectedFiles`,
 * `findProtectedViolations`, `runCheckProtected`, …) take no process/FS access
 * of their own, so every branch is unit-testable without spawning `git`.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-relative root the inventory is generated from — the tier holding the core suites. */
export const PRIMARY_ROOT = 'tests/unit';

/**
 * Every root walked for keep-class suites. A keep-class suite is protected by
 * WHAT IT IS, so it must stay protected wherever it lives: task 018a moved the
 * `parity/` tree into `tools/conformance`, and a single-root walk quietly
 * stopped covering it — the suites did not lose their class, only their
 * address. Task 030 did the same thing at scale, lifting every co-located suite
 * out of `src/` — which is why `src` is no longer listed: it now holds none.
 * `PROTECTED_ROOTS_ALL_EXIST` in the co-located test keeps every entry pointing
 * at a real directory AND carrying at least one suite, so a root that goes empty
 * fails loudly instead of quietly protecting nothing.
 */
export const PROTECTED_ROOTS = Object.freeze([PRIMARY_ROOT, 'tools/conformance/src']);

/**
 * The five dedicated keep-class suite suffixes (DR-5). A file is keep-class
 * iff its name ENDS WITH one of these — never by import content.
 */
export const KEEP_CLASS_SUFFIXES = Object.freeze([
  '.parity.test.ts',
  '.race.test.ts',
  '.property.test.ts',
  '.characterization.test.ts',
  '.acceptance.test.ts',
]);

/**
 * Areas whose parity suite is literally named `parity.test.ts` (no character
 * before "parity", so `*.parity.test.ts` does not match it) — `projections/views/parity`
 * and `events/parity`. Matches the file itself and, defensively, any
 * future file nested under a same-named subdirectory. Paths are POSIX,
 * relative to whichever protected root the file was found under.
 */
export const KEEP_CLASS_AREAS = Object.freeze(['projections/views/parity', 'events/parity']);

/**
 * Named adjacent files the suffix/area rules above already cover (kept here,
 * explicitly, per the design note) plus the one file the suffix rule alone
 * CANNOT cover: the shared non-test harness `parity-harness.ts` (no `.test.ts`
 * suffix at all, so no suite-suffix glob would ever match it). Task 030 lifted
 * it out of `src/__tests__/`, so it now sits at the root of {@link PRIMARY_ROOT}.
 */
export const KEEP_CLASS_EXPLICIT = Object.freeze([
  'workflow/state-machine.property.test.ts',
  'workflow/tools.update.race.test.ts',
  'projections/views/materializer.property.test.ts',
  'parity-harness.ts',
]);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Is `relPath` (relative to its protected root, any path separator) a keep-class
 * protected file? The ONE classifier both the generator and the guard use —
 * suffix/area/explicit-name based, never content-based.
 */
export function isKeepClassRelPath(relPath) {
  const p = toPosix(relPath).replace(/^\.\//, '');
  if (KEEP_CLASS_EXPLICIT.includes(p)) return true;
  if (KEEP_CLASS_SUFFIXES.some((suffix) => p.endsWith(suffix))) return true;
  return KEEP_CLASS_AREAS.some((area) => p === `${area}.test.ts` || p.startsWith(`${area}/`));
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Walk the LIVE tree rooted at `srcRootAbs` (an absolute filesystem path) and
 * return the sorted, repo-relative (POSIX, `srcRootRel`-prefixed) list of
 * keep-class protected files. This is the `--regenerate` engine — the
 * inventory is always derived from what is on disk right now, never
 * hand-listed.
 */
export function discoverProtectedFiles(srcRootAbs, srcRootRel = PRIMARY_ROOT) {
  const files = walk(srcRootAbs, []);
  const out = [];
  for (const abs of files) {
    const relToSrc = toPosix(path.relative(srcRootAbs, abs));
    if (isKeepClassRelPath(relToSrc)) out.push(`${srcRootRel}/${relToSrc}`);
  }
  return out.sort();
}

/** Build the committed `protected-suites.json` document from a file list. */
export function buildInventory(files) {
  return {
    version: 1,
    generatedFrom: PRIMARY_ROOT,
    globs: KEEP_CLASS_SUFFIXES.map((suffix) => `**/*${suffix}`),
    areas: [...KEEP_CLASS_AREAS],
    explicit: [...KEEP_CLASS_EXPLICIT],
    files: [...files].sort(),
  };
}

/**
 * Validate + extract the `files[]` list from a parsed `protected-suites.json`
 * document. Throws on anything that is not the expected shape so the guard
 * fails closed on a corrupt snapshot instead of silently checking nothing.
 */
export function loadInventory(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.files)) {
    throw new Error('protected-suites.json is missing the expected top-level `files[]` array');
  }
  for (const file of raw.files) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('protected-suites.json `files[]` must be an array of non-empty strings');
    }
  }
  return raw.files;
}

function normalizeChangedPath(p) {
  return toPosix(p).replace(/^\.\//, '');
}

/**
 * Which of `changedFiles` are keep-class protected? A path counts as
 * protected if EITHER it appears in the committed `inventoryFiles` snapshot,
 * OR its protected-root-relative portion matches {@link isKeepClassRelPath}
 * directly — the live re-derivation that catches a brand-new keep-class file
 * even before the snapshot has been regenerated (the "can't silently drift"
 * design note). Returns the intersecting paths, normalized, deduplicated.
 */
export function findProtectedViolations(changedFiles, inventoryFiles) {
  const inventorySet = new Set(inventoryFiles.map(normalizeChangedPath));
  const violations = [];
  const seen = new Set();
  for (const raw of changedFiles) {
    const p = normalizeChangedPath(raw);
    let isViolation = inventorySet.has(p);
    // The safety net runs against every protected root, so a keep-class file
    // added under one of them is caught before the snapshot is regenerated.
    for (const root of PROTECTED_ROOTS) {
      if (isViolation || !p.startsWith(`${root}/`)) continue;
      isViolation = isKeepClassRelPath(p.slice(root.length + 1));
    }
    if (isViolation && !seen.has(p)) {
      seen.add(p);
      violations.push(p);
    }
  }
  return violations;
}

export const EXIT_OK = 0;
/** The change-set touches at least one keep-class protected file (DR-5). */
export const EXIT_PROTECTED = 1;

/**
 * Injectable guard body — no process/FS/child_process access of its own.
 * `deps.changedFiles` is the resolved change-set; `deps.inventoryFiles` is the
 * loaded `protected-suites.json` `files[]` array.
 */
export function runCheckProtected(deps) {
  const violations = findProtectedViolations(deps.changedFiles, deps.inventoryFiles);
  if (violations.length > 0) {
    deps.errlog(
      `[check-protected] FAIL: change-set touches ${violations.length} keep-class protected ` +
        'file(s) (DR-5) — dedicated parity/race/property/characterization/acceptance suites ' +
        'and their shared harness are out of scope for consolidation:',
    );
    for (const v of violations) deps.errlog(`    ${v}`);
    return EXIT_PROTECTED;
  }
  deps.log(
    `[check-protected] OK: ${deps.changedFiles.length} changed file(s), none keep-class protected ` +
      `(${deps.inventoryFiles.length} file(s) in protected-suites.json).`,
  );
  return EXIT_OK;
}

/**
 * Resolve the change-set to check: explicit CLI positional args win; else
 * piped stdin (one path per line, blank lines dropped); else `gitFallback()`
 * (`git diff --name-only HEAD`) as a zero-argument convenience default.
 */
export function resolveChangedFiles({ argvFiles, stdinText, gitFallback }) {
  if (argvFiles.length > 0) return argvFiles;
  const fromStdin = (stdinText ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (fromStdin.length > 0) return fromStdin;
  return gitFallback();
}

// ─── production wiring (only runs when invoked as a CLI) ────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const INVENTORY_PATH = path.join(HERE, 'protected-suites.json');

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function defaultGitDiffNames() {
  const res = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (res.error || res.status !== 0) return [];
  return (res.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function regenerate() {
  const files = PROTECTED_ROOTS.flatMap((root) =>
    discoverProtectedFiles(path.join(REPO_ROOT, root), root),
  );
  const inventory = buildInventory(files);
  writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  process.stdout.write(`[check-protected] regenerated ${files.length} protected file(s) -> ${INVENTORY_PATH}\n`);
  return files.length;
}

function invokedAsCli() {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsCli()) {
  const argv = process.argv.slice(2);
  if (argv.includes('--regenerate')) {
    regenerate();
    process.exit(0);
  }

  const argvFiles = argv.filter((a) => !a.startsWith('--'));
  const changedFiles = resolveChangedFiles({
    argvFiles,
    stdinText: readStdinSync(),
    gitFallback: defaultGitDiffNames,
  });

  let inventoryFiles;
  try {
    inventoryFiles = loadInventory(JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')));
  } catch (err) {
    process.stderr.write(`[check-protected] FAIL (bad-inventory): ${err.message}\n`);
    process.exit(2);
  }

  const exitCode = runCheckProtected({
    changedFiles,
    inventoryFiles,
    log: (message) => process.stdout.write(`${message}\n`),
    errlog: (message) => process.stderr.write(`${message}\n`),
  });
  process.exit(exitCode);
}
