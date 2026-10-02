#!/usr/bin/env node
/**
 * The mutation-runner seam that the `.exarchos.yml` `mutation:` entry resolves
 * to, as `node tools/audit/core/stryker-adapter.mjs` from the repo root.
 *
 * `defaultRunMutation` parses the stdout of one command as a Stryker JSON
 * report. StrykerJS writes its report to a file, so this adapter runs Stryker,
 * keeps its console output off stdout, and prints the report file. It turns the
 * `--since=<base>` flag, which StrykerJS does not support, into a `--mutate`
 * list of the changed `src/` source files. It runs the pinned local binary,
 * never `npx`.
 *
 * Without `--since`, Stryker uses its configured `mutate` default. An empty
 * mutatable diff prints an empty valid report and exits 0. A missing binary, a
 * failed run, a missing report, a failed `git diff`, or more than
 * `MAX_MUTATE_FILES` files exits 1 with an empty stdout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * The repo-relative prefix of the mutated tree. It is empty, because the mutated
 * tree is the repo root. The named constant keeps the seam for a future nesting.
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
 * The bound on the mutated file set. StrykerJS has no native limit on mutants,
 * so the adapter bounds its input files before Stryker runs. A diff with more
 * qualifying files fails closed, because a mutant in an omitted file can survive
 * unseen. `computeMutateGlobs` reports `totalQualifying`, so `main` names the
 * exact overflow.
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
 * Filters a `git diff --name-only` list to the `--mutate` list for Stryker. It
 * keeps the mutatable `src/` files that still exist, and bounds the count. The
 * `fileExists` check is injectable, so tests need no real filesystem. Paths are
 * relative to the repo root, where Stryker runs.
 */
export function computeMutateGlobs(changedFiles, fileExists) {
  const posixFiles = (changedFiles ?? [])
    .map((file) => file.replace(/\\/g, '/').trim())
    .filter((file) => file.length > 0);

  const qualifying = posixFiles
    .filter(isMutatableServerSource)
    .filter((file) => fileExists(file))
    .sort();

  const truncated = qualifying.length > MAX_MUTATE_FILES;
  const bounded = truncated ? qualifying.slice(0, MAX_MUTATE_FILES) : qualifying;
  const files = bounded.map((file) => file.slice(SERVER_PREFIX.length));

  return { files, truncated, totalQualifying: qualifying.length };
}

/**
 * Runs `git diff --name-only <base>...HEAD` in `repoRoot`, the merge-base form
 * that `defaultRunDiff` also uses. It never throws. A git failure returns
 * `{ ok: false }`, so the caller can tell it from an empty diff.
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
 * Keeps the last `maxChars` characters of captured output, with a truncation
 * marker when it clips. The failure of a runner is usually at the tail, and the
 * bound keeps a full Stryker transcript out of the CI log.
 */
function boundedTail(text, maxChars = 1500) {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= maxChars) return trimmed;
  return `…(truncated)…${trimmed.slice(-maxChars)}`;
}

/**
 * Runs the pinned local Stryker binary in `serverDir` and prints its JSON
 * report file. A missing binary, a failed run, or a missing report writes the
 * reason to stderr and returns 1. It deletes an old report first, so a missing
 * report means that this run made none. Stryker console output never reaches
 * stdout. On a failure, stderr gets a bounded tail of that output, because the
 * `execFileSync` error message holds only a generic wrapper.
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

  const reportPath = path.join(serverDir, 'reports', 'mutation', 'mutation.json');
  rmSync(reportPath, { force: true });

  let strykerStdout = '';
  try {
    strykerStdout = execFileSync(binPath, args, {
      cwd: serverDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = /** @type {{ message?: string, stdout?: string | Buffer, stderr?: string | Buffer }} */ (
      err
    );
    const detail = e?.message ?? (err instanceof Error ? err.message : String(err));
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
 * The adapter entry point. The handler runs the `mutation:` command from the
 * repo or worktree root, so `process.cwd()` is the root where Stryker runs.
 * Without `--since`, Stryker mutates with its configured default. A diff over
 * `MAX_MUTATE_FILES` fails closed. An empty mutatable diff prints
 * `EMPTY_REPORT` without a Stryker run.
 */
export function main(argv) {
  const repoRoot = process.cwd();
  const serverDir = repoRoot;
  const since = parseSinceArg(argv);

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
      `stryker-adapter: diff touched ${totalQualifying} mutatable server files, exceeding the maximum ` +
        `supported scope of ${MAX_MUTATE_FILES}; refusing to evaluate only a bounded subset (a mutant in ` +
        `an omitted file could survive unseen) — fail closed rather than silently truncate (#1720)\n`,
    );
    return 1;
  }

  if (files.length === 0) {
    process.stdout.write(JSON.stringify(EMPTY_REPORT));
    return 0;
  }

  return runStryker(serverDir, files);
}

/** True when Node runs this file directly, not when a test imports it. */
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
