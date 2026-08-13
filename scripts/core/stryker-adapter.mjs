#!/usr/bin/env node
/**
 * stryker-adapter — the DR-7 mutation-runner seam
 * (docs/specs/2026-07-17-wave-s-enforcement-substrate.md §DR-7, task 012).
 *
 * This is the command the `.exarchos.yml` `mutation:` entry resolves to
 * (`node scripts/core/stryker-adapter.mjs`, runnable from
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
 *      to changed, still-existing, mutatable `src/**`
 *      source files (deletions and test files excluded), and passes them as
 *      a `--mutate` glob list.
 *   3. `npx` can resolve a DIFFERENT Stryker than the pinned one, or fetch
 *      one from the network. This adapter instead executes the **local pinned
 *      binary** (`node_modules/.bin/stryker`) directly — no `npx` anywhere on
 *      this path, so the version under test is always the pinned version.
 *
 * Contract summary:
 *   - `--since=<base>` present  → diff-scope to `src/**`
 *     files changed since `<base>`. An EMPTY mutatable surface prints the
 *     empty-valid report `{schemaVersion, files:{}}` to stdout and exits 0
 *     (parseable, never a degrade — Stryker is never even invoked).
 *   - `--since=<base>` absent   → full-tree run: Stryker's own configured
 *     `mutate` default applies (the long-running offline/nightly lane,
 *     DR-6 `scope:'full'`; out of scope for the inline/CI-blocking lane).
 *   - A missing local pinned binary, a Stryker run that throws, a completed
 *     run with no report file on disk, or a diff whose qualifying mutatable
 *     surface EXCEEDS `MAX_MUTATE_FILES` are all FAIL-CLOSED: stderr names the
 *     artifact and the reason, nothing is written to stdout, and the process
 *     exits 1. `defaultRunMutation` folds a non-zero exit with empty stdout
 *     into a degrade (never a false pass) — this is the "devDep absent"
 *     direction the composed-path smoke test exercises. An oversized diff fails
 *     closed rather than silently mutating only a bounded subset (#1720).
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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * Repo-root-relative prefix this adapter's diff-scoping is hardwired to.
 * Empty since task 019 folded the server into the repo root: the mutated tree
 * IS the root tree. Kept as a named constant rather than inlined, because the
 * prefix is still the seam a future nesting would move.
 */
export const SERVER_PREFIX = '';
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
 * set, before Stryker ever runs. A diff touching more than this many
 * qualifying files FAILS CLOSED (`main` returns 1) rather than silently
 * evaluating only a bounded subset — a mutant in an omitted file could survive
 * unseen, so a partial run is not an adequate one (#1720). `computeMutateGlobs`
 * still reports the `truncated`/`totalQualifying` count so `main` can name the
 * exact overflow in its fail-closed message.
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
 * `src/**` production source file (not a test/bench/
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
 * Returns paths relative to the directory Stryker runs in, which since task
 * 019 is the repo root itself.
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
 * Bound a captured-output tail to a fixed character budget (DR-10
 * attributability, #1719) — keeps the LAST `maxChars` (a runner's actual
 * failure is almost always at the tail, not the head, of its output),
 * prefixed with a truncation marker when it clips, so a stderr line never
 * floods CI output with a full Stryker transcript.
 */
function boundedTail(text, maxChars = 1500) {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= maxChars) return trimmed;
  return `…(truncated)…${trimmed.slice(-maxChars)}`;
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
        `\`npm install\` at the repo root (the @stryker-mutator/core ` +
        `devDependency is missing)\n`,
    );
    return 1;
  }

  const args = ['run'];
  if (mutateFiles.length > 0) {
    args.push('--mutate', mutateFiles.join(','));
  }

  // Delete any pre-existing report BEFORE launching Stryker (correctness,
  // #1720): the "no report on disk" branch below is the fail-closed signal for
  // a run that produced nothing this invocation. A stale `mutation.json` left
  // by a previous run would otherwise be read as THIS run's output if Stryker
  // exits 0 without rewriting it, silently passing the current diff on old
  // results. Absence-after-execution must mean "this run produced no report".
  const reportPath = path.join(serverDir, 'reports', 'mutation', 'mutation.json');
  rmSync(reportPath, { force: true });

  // Captured on the SUCCESS path too (DR-10): `execFileSync` only returns
  // stdout when the child exits 0 — stderr on success is not exposed at all
  // — so this is the one chance to tail Stryker's own console output if the
  // "exited cleanly but no report" branch below is reached.
  let strykerStdout = '';
  try {
    strykerStdout = execFileSync(binPath, args, {
      cwd: serverDir,
      encoding: 'utf-8',
      // Stryker's own console output (progress, warnings) is captured but
      // never forwarded to THIS process's stdout — the only thing this
      // adapter ever writes to stdout is the report file's content, so the
      // handler's stdout-is-the-report contract stays a single writer.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = /** @type {{ message?: string, stdout?: string | Buffer, stderr?: string | Buffer }} */ (
      err
    );
    const detail = e?.message ?? (err instanceof Error ? err.message : String(err));
    // `execFileSync`'s thrown error carries the child's actual captured
    // output on `.stderr`/`.stdout` — `.message` for a failed exec is just
    // the generic "Command failed: …" wrapper, dropping Stryker's real
    // diagnostic entirely. Surface a bounded tail of it (#1719).
    const stderrText = typeof e?.stderr === 'string' ? e.stderr : e?.stderr?.toString('utf-8') ?? '';
    const stdoutText = typeof e?.stdout === 'string' ? e.stdout : e?.stdout?.toString('utf-8') ?? '';
    const tail = boundedTail(stderrText.length > 0 ? stderrText : stdoutText);
    process.stderr.write(
      `stryker-adapter: stryker run failed: ${detail}` +
        (tail.length > 0 ? `; captured output (tail): ${tail}` : '') +
        '\n',
    );
    return 1;
  }

  let reportContent;
  try {
    reportContent = readFileSync(reportPath, 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const tail = boundedTail(strykerStdout);
    process.stderr.write(
      `stryker-adapter: stryker exited cleanly but no report was found at ` +
        `${reportPath}: ${detail}` +
        (tail.length > 0 ? `; stryker output (tail): ${tail}` : '') +
        '\n',
    );
    return 1;
  }

  process.stdout.write(reportContent);
  return 0;
}

/**
 * Adapter entry point. `repoRoot` is `process.cwd()` — the `.exarchos.yml`
 * `mutation:` command is a repo-root-relative path, so the handler always
 * invokes it with cwd set to the repo/worktree root, which since task 019 is
 * also the directory Stryker runs in.
 */
export function main(argv) {
  const repoRoot = process.cwd();
  const serverDir = repoRoot;
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

  // FAIL CLOSED on an oversized scope (DR-10: no silent truncation, #1720).
  // Evaluating only the first MAX_MUTATE_FILES would let a surviving/uncovered
  // mutant in an OMITTED file pass unseen — a partial result is not an adequate
  // one. Reject the whole diff instead of silently mutating a bounded subset;
  // the mutant-count wall-clock bound is preserved by refusing, not by
  // dropping files. (Handling an oversized diff — e.g. sharding — is #1720.)
  if (truncated) {
    process.stderr.write(
      `stryker-adapter: diff touched ${totalQualifying} mutatable server files, exceeding the maximum ` +
        `supported scope of ${MAX_MUTATE_FILES}; refusing to evaluate only a bounded subset (a mutant in ` +
        `an omitted file could survive unseen) — fail closed rather than silently truncate (#1720)\n`,
    );
    return 1;
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
    const self = fileURLToPath(import.meta.url);
    return argv1 === self || argv1.endsWith('/stryker-adapter.mjs');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
