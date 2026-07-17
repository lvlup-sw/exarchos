#!/usr/bin/env node
/**
 * stryker-adapter — the DR-7 mutation-runner seam
 * (docs/specs/2026-07-17-wave-s-enforcement-substrate.md §DR-7, task 012).
 *
 * This is the command the `.exarchos.yml` `mutation:` entry resolves to
 * (`node servers/exarchos-mcp/scripts/stryker-adapter.mjs`, runnable from
 * repo-root cwd — never `npx`). It exists because the in-tree handler's
 * default runner (`defaultRunMutation`, mutation-adequacy.ts) has a contract
 * that a bare `npx stryker run` cannot satisfy on its own, for three
 * independent reasons this one adapter absorbs:
 *
 *   1. `defaultRunMutation` captures the **stdout** of one whitespace-
 *      tokenized, no-shell command as the Stryker-schema JSON report — but
 *      StrykerJS logs progress to stdout and writes its actual report to a
 *      **file** (`reports/mutation/mutation.json`). This adapter runs
 *      Stryker with only the `json` reporter (see `stryker.conf.mjs`),
 *      captures its OWN stdout separately (never forwarded), then reads the
 *      report file after Stryker exits and echoes its content to *this*
 *      process's stdout — that is what `defaultRunMutation` actually parses.
 *   2. The handler appends `--since=<base>` for the node toolchain
 *      (`toolchains.ts` `MUTATION_DIFF_SCOPE.node`) — a Stryker.NET flag
 *      StrykerJS does not support. This adapter is the thing that consumes
 *      `--since=<base>` and translates it into StrykerJS's own scoping
 *      mechanism: it computes `git diff --name-only <base>...HEAD`, filters
 *      to changed, still-existing, mutatable `servers/exarchos-mcp/src/**`
 *      source files (deletions and test files excluded), and passes them as
 *      a `--mutate` glob list.
 *   3. `npx` resolved from a repo-root cwd cannot see a binary installed
 *      only under `servers/exarchos-mcp/node_modules` (that directory is
 *      not on the repo-root `npx` resolution path). This adapter instead
 *      executes the **local pinned binary**
 *      (`servers/exarchos-mcp/node_modules/.bin/stryker`) directly, with
 *      `cwd` set to `servers/exarchos-mcp` — no `npx` anywhere on this path.
 *
 * Contract summary:
 *   - `--since=<base>` present  → diff-scope to `servers/exarchos-mcp/src/**`
 *     files changed since `<base>`. An EMPTY mutatable surface prints the
 *     empty-valid report `{schemaVersion, files:{}}` to stdout and exits 0
 *     (parseable, never a degrade — Stryker is never even invoked).
 *   - `--since=<base>` absent   → full-tree run: Stryker's own configured
 *     `mutate` default applies (the long-running offline/nightly lane,
 *     DR-6 `scope:'full'`; out of scope for the inline/CI-blocking lane).
 *   - A missing local pinned binary, a Stryker run that throws, or a
 *     completed run with no report file on disk are all FAIL-CLOSED: stderr
 *     names the artifact and the reason, nothing is written to stdout, and
 *     the process exits 1. `defaultRunMutation` folds a non-zero exit with
 *     empty stdout into a degrade (never a false pass) — this is the
 *     "devDep absent" direction the composed-path smoke test exercises.
 *   - `git diff` failing (bad `--since` ref, not a git repo, …) is also
 *     fail-closed — distinct from a genuinely empty diff, which is a
 *     logged, exit-0, valid-empty-report outcome, not an error.
 *
 * Pure helpers below (`parseSinceArg`, `isMutatableServerSource`,
 * `computeMutateGlobs`) are exported for direct unit testing; the CLI
 * wiring (`main`/`runStryker`/`gitDiffNames`) only runs when this file is
 * invoked directly (not when imported by a test).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

/** Repo-root-relative prefix this adapter's diff-scoping is hardwired to. */
export const SERVER_PREFIX = 'servers/exarchos-mcp/';
const SERVER_SRC_PREFIX = `${SERVER_PREFIX}src/`;

/** Extensions StrykerJS can mutate that this project actually uses. */
const MUTATABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Suffixes that mark a file as non-production (never mutated, even if the extension matches). */
const NON_MUTATABLE_SUFFIXES = [
  '.d.ts',
  '.test.ts',
  '.test.tsx',
  '.spec.ts',
  '.bench.ts',
  '.type-test.ts',
];

/**
 * Mutant-count bound (DR-7 acceptance criteria): StrykerJS has no native
 * "max mutants" flag, so the bound is enforced upstream, on the input file
 * set, before Stryker ever runs — a diff touching more than this many
 * qualifying files is capped (alphabetically, for determinism), keeping a
 * single run's worst-case wall-clock bounded regardless of PR size.
 */
export const MAX_MUTATE_FILES = 40;

/** The empty-valid report this adapter prints for a diff with no mutatable surface. */
export const EMPTY_REPORT = Object.freeze({ schemaVersion: '1.0', files: {} });

/** Extract the `<base>` value from a handler-appended `--since=<base>` flag. */
export function parseSinceArg(argv) {
  for (const arg of argv) {
    if (arg.startsWith('--since=')) return arg.slice('--since='.length);
  }
  return undefined;
}

/**
 * Whether a repo-root-relative, POSIX-normalized path is a mutatable
 * `servers/exarchos-mcp/src/**` production source file (not a test/bench/
 * declaration file, and carries a mutatable extension).
 */
export function isMutatableServerSource(posixPath) {
  if (!posixPath.startsWith(SERVER_SRC_PREFIX)) return false;
  if (NON_MUTATABLE_SUFFIXES.some((suffix) => posixPath.endsWith(suffix))) return false;
  return MUTATABLE_EXTENSIONS.includes(path.extname(posixPath));
}

/**
 * Filter+bound a raw `git diff --name-only` file list down to the
 * `--mutate` glob list Stryker receives, given an injectable existence
 * check (production: `existsSync`; tests: a fixed in-memory set) so the
 * filtering logic is unit-testable without touching a real filesystem.
 *
 * Returns server-dir-relative paths (the `servers/exarchos-mcp/` prefix
 * stripped) — Stryker runs with `cwd: servers/exarchos-mcp`, so its
 * `mutate` glob patterns are relative to that directory, not the repo root.
 */
export function computeMutateGlobs(changedFiles, fileExists) {
  const posixFiles = (changedFiles ?? [])
    .map((file) => file.replace(/\\/g, '/').trim())
    .filter((file) => file.length > 0);

  const qualifying = posixFiles
    .filter(isMutatableServerSource)
    // "still-existing": a file deleted by the diff cannot be mutated.
    .filter((file) => fileExists(file))
    .sort();

  const truncated = qualifying.length > MAX_MUTATE_FILES;
  const bounded = truncated ? qualifying.slice(0, MAX_MUTATE_FILES) : qualifying;
  const files = bounded.map((file) => file.slice(SERVER_PREFIX.length));

  return { files, truncated, totalQualifying: qualifying.length };
}

/**
 * `git diff --name-only <base>...HEAD`, run with `cwd: repoRoot` (the same
 * merge-base three-dot form `defaultRunDiff` uses elsewhere in this
 * codebase, mutation-adequacy.ts). Never throws — a git failure is a
 * tagged `{ ok: false }` so the caller can fail closed rather than silently
 * treating "git broke" the same as "genuinely empty diff".
 */
function gitDiffNames(base, repoRoot) {
  try {
    const stdout = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: true,
      files: stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run the local pinned Stryker binary (never `npx`) with `cwd: serverDir`,
 * then read+print its JSON report file. Fail-closed on a missing binary, a
 * throwing run, or a completed run with no report on disk: stderr names the
 * artifact and the reason, stdout stays empty, exit code is 1.
 */
function runStryker(serverDir, mutateFiles) {
  const binName = process.platform === 'win32' ? 'stryker.cmd' : 'stryker';
  const binPath = path.join(serverDir, 'node_modules', '.bin', binName);

  if (!existsSync(binPath)) {
    process.stderr.write(
      `stryker-adapter: local pinned binary not found at ${binPath} — run ` +
        `\`npm install\` in servers/exarchos-mcp (the @stryker-mutator/core ` +
        `devDependency is missing)\n`,
    );
    return 1;
  }

  const args = ['run'];
  if (mutateFiles.length > 0) {
    args.push('--mutate', mutateFiles.join(','));
  }

  try {
    execFileSync(binPath, args, {
      cwd: serverDir,
      encoding: 'utf-8',
      // Stryker's own console output (progress, warnings) is captured but
      // never forwarded to THIS process's stdout — the only thing this
      // adapter ever writes to stdout is the report file's content, so the
      // handler's stdout-is-the-report contract stays a single writer.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`stryker-adapter: stryker run failed: ${detail}\n`);
    return 1;
  }

  const reportPath = path.join(serverDir, 'reports', 'mutation', 'mutation.json');
  let reportContent;
  try {
    reportContent = readFileSync(reportPath, 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `stryker-adapter: stryker exited cleanly but no report was found at ` +
        `${reportPath}: ${detail}\n`,
    );
    return 1;
  }

  process.stdout.write(reportContent);
  return 0;
}

/**
 * Adapter entry point. `repoRoot` is `process.cwd()` — the `.exarchos.yml`
 * `mutation:` command is a repo-root-relative path, so the handler always
 * invokes it with cwd set to the repo/worktree root; `serverDir` is always
 * `<repoRoot>/servers/exarchos-mcp`.
 */
export function main(argv) {
  const repoRoot = process.cwd();
  const serverDir = path.join(repoRoot, 'servers', 'exarchos-mcp');
  const since = parseSinceArg(argv);

  // No `--since`: the full-tree lane (DR-6 `scope:'full'`, offline-only).
  // No diff computation, no `--mutate` override — Stryker's own configured
  // default applies.
  if (since === undefined) {
    return runStryker(serverDir, []);
  }

  const diff = gitDiffNames(since, repoRoot);
  if (!diff.ok) {
    process.stderr.write(
      `stryker-adapter: git diff failed for --since=${since}: ${diff.reason}\n`,
    );
    return 1;
  }

  const { files, truncated, totalQualifying } = computeMutateGlobs(diff.files, (file) =>
    existsSync(path.join(repoRoot, file)),
  );

  if (truncated) {
    process.stderr.write(
      `stryker-adapter: diff touched ${totalQualifying} mutatable server files; ` +
        `capping to the first ${MAX_MUTATE_FILES} (mutant-count bound, see ` +
        `stryker.conf.mjs's documented runtime budget)\n`,
    );
  }

  // Empty mutatable surface: never a degrade. Print the empty-valid report
  // and exit 0 WITHOUT ever invoking Stryker — a diff that touches no
  // server source is vacuously adequate, not a tool failure.
  if (files.length === 0) {
    process.stdout.write(JSON.stringify(EMPTY_REPORT));
    return 0;
  }

  return runStryker(serverDir, files);
}

// ─── CLI main ────────────────────────────────────────────────────────────
// Only runs when invoked directly (not when imported by the test file).

const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const self = new URL(import.meta.url).pathname;
    return argv1 === self || argv1.endsWith('/stryker-adapter.mjs');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
