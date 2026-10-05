#!/usr/bin/env node
/**
 * check-protected.mjs: the inventory of keep-class protected files, and a pre-flight guard.
 *
 * Test-suite consolidation must never touch a keep-class suite (parity, race, property,
 * characterization or acceptance) or the shared `parity-harness.ts`. The path decides
 * keep-class status. A file that only imports `fast-check` is not keep-class.
 *
 *   --regenerate   Walks the live tree under every protected root and rewrites the
 *                  committed `protected-suites.json` snapshot.
 *   (default)      Guard mode. Exits 1 when the change-set touches a keep-class file.
 *                  It checks the snapshot and classifies each changed path again, so a
 *                  new keep-class file fails even when the snapshot is stale.
 *
 * Exit 2 when the snapshot cannot be read or has the wrong shape.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-relative root the inventory is generated from — the tier holding the core suites. */
export const PRIMARY_ROOT = 'tests/unit';

/**
 * Every root walked for keep-class suites. A keep-class suite stays protected wherever it
 * lives, so each root that holds one must be in this list. The walk skips a root that does
 * not exist. The self-test `PROTECTED_ROOTS_ALL_EXIST` fails when a listed root does not exist
 * or holds no keep-class suite.
 */
export const PROTECTED_ROOTS = Object.freeze([PRIMARY_ROOT, 'tools/conformance/src']);

/** The keep-class suite suffixes. A file with one of these suffixes is keep-class. */
export const KEEP_CLASS_SUFFIXES = Object.freeze([
  '.parity.test.ts',
  '.race.test.ts',
  '.property.test.ts',
  '.characterization.test.ts',
  '.acceptance.test.ts',
]);

/**
 * Areas whose parity suite is named `parity.test.ts`, which `*.parity.test.ts` does not match.
 * An entry also matches any file under a directory of the same name. Paths are POSIX and
 * relative to their protected root.
 */
export const KEEP_CLASS_AREAS = Object.freeze(['projections/views/parity', 'events/parity']);

/**
 * Files named one by one. The suffix rules also cover the three suites. Only this list
 * protects `parity-harness.ts`, which has no `.test.ts` suffix and sits at the root of
 * {@link PRIMARY_ROOT}.
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
 * True when `relPath`, relative to its protected root, is a keep-class file. The generator
 * and the guard both use this classifier. It reads the path, never the file content.
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
 * Walks the live tree at the absolute path `srcRootAbs`. Returns the sorted keep-class
 * files as POSIX paths with the `srcRootRel` prefix. This is the `--regenerate` engine.
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
 * Returns `files[]` from a parsed `protected-suites.json`. Throws on any other shape,
 * so the guard fails closed on a corrupt snapshot.
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
 * Returns the keep-class paths of `changedFiles`, normalized and without duplicates.
 * A path counts when `inventoryFiles` lists it, or when its part under a protected root
 * passes {@link isKeepClassRelPath}. The second check catches a new keep-class file
 * before anyone regenerates the snapshot.
 */
export function findProtectedViolations(changedFiles, inventoryFiles) {
  const inventorySet = new Set(inventoryFiles.map(normalizeChangedPath));
  const violations = [];
  const seen = new Set();
  for (const raw of changedFiles) {
    const p = normalizeChangedPath(raw);
    let isViolation = inventorySet.has(p);
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
/** The change-set touches at least one keep-class protected file. */
export const EXIT_PROTECTED = 1;

/**
 * Injectable guard body with no process or file-system access. `deps.changedFiles` is the
 * change-set, and `deps.inventoryFiles` is the `files[]` array of the snapshot.
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
 * Resolves the change-set. CLI positional arguments come first, then piped stdin with one
 * path on each line, then `gitFallback()`, which runs `git diff --name-only HEAD`.
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
