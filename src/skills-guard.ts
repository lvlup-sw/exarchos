/**
 * CI `skills:guard` check — detects drift between `skills-src/` sources
 * and the committed `skills/` generated tree.
 *
 * Runs `buildAllSkills()` in-process against the project root, then
 * invokes `git diff --exit-code skills/`. A non-empty diff means either:
 *
 *   1. A developer changed `skills-src/` but forgot to run
 *      `npm run build:skills` and commit the regenerated output, or
 *   2. A developer hand-edited a generated file under `skills/`
 *      (which the build has just overwritten).
 *
 * Either way the guard fails with a remediation message pointing at
 * `npm run build:skills`.
 *
 * Exported `runSkillsGuard()` is testable — tests hand it a temp
 * project root. The CLI at the bottom of this file wires it to
 * `process.cwd()` / `process.exit()`.
 *
 * Implements: DR-1 (guard), DR-10 (stale-output path).
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildAllSkills } from './build-skills.js';
import { resolveMainDeps, type MainDeps } from './cli-helpers.js';

/**
 * Outcome of a guard run. `ok === true` means the generated tree was
 * in sync with HEAD; `ok === false` means either the build itself
 * failed or `git diff skills/` produced output.
 *
 * `message` is a human-readable explanation safe to print in CI logs.
 * On success it names what was checked; on failure it includes the
 * remediation command and, where possible, the raw diff body so the
 * drifted file paths are visible.
 */
export interface SkillsGuardResult {
  ok: boolean;
  exitCode: number;
  message: string;
}

/**
 * Injectable collaborators so tests can avoid touching the real
 * filesystem or process state. Production leaves these undefined and
 * the implementation defaults to the obvious real-world behavior.
 */
export interface SkillsGuardOptions {
  cwd: string;
}

/**
 * Fixed remediation string. Exported-shaped via the returned message
 * so tests can assert the command is mentioned verbatim. Kept as a
 * const so a future refactor (e.g. a shared CLI message helper) can
 * reuse it from one place.
 */
const REMEDIATION =
  "Generated skills are stale. Run 'npm run build:skills' and commit the result.";

/**
 * Run the build and verify the generated `skills/` tree matches what
 * is committed in git. Does not modify anything outside `opts.cwd`
 * and does not call `process.exit` — the CLI wrapper at the bottom
 * of this file is responsible for exit handling.
 *
 * ### Determinism contract
 *
 * The guard's correctness relies on `buildAllSkills()` being a pure
 * function of `(skills-src/, runtimes/*.yaml)`: running it twice on
 * identical inputs must produce byte-identical output. Two specific
 * rendering paths need to uphold this:
 *
 *   1. **Placeholder substitution** (`render()`): deterministic by
 *      construction — `PLACEHOLDER_REGEX.replace()` visits tokens in
 *      source order and looks up values from a static map.
 *
 *   2. **CALL macro expansion** (`renderCallMacros()`): emits either
 *      `JSON.stringify(args, null, 2)` (MCP facade) or
 *      `--{kebab-key} {value}` pairs in `Object.entries` order (CLI
 *      facade). Both rely on V8 preserving object-key insertion order,
 *      which is guaranteed by the ECMAScript spec for string keys. The
 *      args object is assembled with a fixed key order (the `action`
 *      discriminator first, then `...ast.args` from `JSON.parse`, which
 *      itself preserves source-text key order).
 *
 * If either invariant is ever broken (e.g. a future refactor switches
 * to `Object.keys().sort()` non-idempotently, or swaps
 * `JSON.stringify` for a reflection-based pretty-printer), this guard
 * will start false-positiving on rebuilds. The
 * `SkillsGuard_AfterCallMacroRender_NoDrift` test in
 * `skills-guard.test.ts` locks the CALL-macro determinism invariant in
 * place.
 *
 * @param opts.cwd - Absolute path to the project root. Must contain
 *   `skills-src/`, `runtimes/`, and a git repo whose HEAD tracks the
 *   current state of `skills/`.
 */
export function runSkillsGuard(opts: SkillsGuardOptions): SkillsGuardResult {
  const { cwd } = opts;

  // Step 1: run the build. A build failure is a guard failure because
  // CI must not pass if the source tree can't even render.
  try {
    buildAllSkills({
      srcDir: join(cwd, 'skills-src'),
      outDir: join(cwd, 'skills'),
      runtimesDir: join(cwd, 'runtimes'),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      exitCode: 1,
      message: `[skills:guard] build failed: ${detail}\n${REMEDIATION}`,
    };
  }

  // Step 2: ask git whether `skills/` is dirty vs HEAD. We use
  // `git diff --exit-code` so a clean tree returns exit 0 with no
  // output and a dirty tree returns exit 1 with the diff body on
  // stdout. Any other exit (e.g. 128 for "not a git repo") is an
  // error state we surface as-is.
  let diffOutput: string;
  try {
    const buf = execFileSync('git', ['diff', '--exit-code', '--', 'skills/'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    diffOutput = buf.toString('utf8');
  } catch (err) {
    // `git diff --exit-code` with a non-empty diff exits 1. Node's
    // `execFileSync` treats any non-zero exit as a throw, attaching
    // the captured stdout/stderr to the error. The type of that
    // error is loose, so we narrow with a structured guard rather
    // than a cast to `any`.
    const status = getExecErrorStatus(err);
    const stdout = getExecErrorStdout(err);
    const stderr = getExecErrorStderr(err);

    if (status === 1) {
      // Exit 1 = diff exists. This is the stale-output path.
      return {
        ok: false,
        exitCode: 1,
        message: [
          '[skills:guard] generated skills tree is stale (drift detected).',
          REMEDIATION,
          '',
          'Diff:',
          stdout.length > 0 ? stdout : '(no diff output captured)',
        ].join('\n'),
      };
    }

    // Any other exit (typically 128 = not a git repo, bad path, etc.)
    // is an unrecoverable environment problem. Surface everything we
    // have so the CI operator can debug.
    return {
      ok: false,
      exitCode: status ?? 1,
      message: [
        `[skills:guard] git diff failed (exit ${status ?? 'unknown'})`,
        stderr || stdout || String(err),
        REMEDIATION,
      ].join('\n'),
    };
  }

  // `git diff --exit-code` returned 0 → no drift.
  return {
    ok: true,
    exitCode: 0,
    message: `[skills:guard] skills/ is in sync with sources${
      diffOutput.length > 0 ? ' (with trailing output: ignored)' : ''
    }`,
  };
}

/**
 * Narrow `unknown` to extract the exit status of a failed
 * `execFileSync` call without reaching for `any`. Node's child_process
 * errors carry a numeric `status` property when the process exited
 * normally with a non-zero code.
 */
function getExecErrorStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/** Same narrowing pattern for `stdout`. */
function getExecErrorStdout(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'stdout' in err) {
    const out = (err as { stdout: unknown }).stdout;
    if (Buffer.isBuffer(out)) return out.toString('utf8');
    if (typeof out === 'string') return out;
  }
  return '';
}

/** Same narrowing pattern for `stderr`. */
function getExecErrorStderr(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'stderr' in err) {
    const out = (err as { stderr: unknown }).stderr;
    if (Buffer.isBuffer(out)) return out.toString('utf8');
    if (typeof out === 'string') return out;
  }
  return '';
}

// -----------------------------------------------------------------------------
// CLI entry (`npm run skills:guard`)
// -----------------------------------------------------------------------------

/**
 * Re-export of the shared `MainDeps` shape so a future refactor of
 * this file's callers does not need to chase a second import line.
 * Canonical definition lives in `cli-helpers.ts`.
 */
export type { MainDeps } from './cli-helpers.js';

/**
 * `npm run skills:guard` entry point. Invokes `runSkillsGuard` against
 * `deps.cwd()` and exits with the returned code after printing the
 * result message. Success prints to stdout; failure to stderr.
 */
export function main(_argv: string[], deps: MainDeps = {}): void {
  const { cwd, exit, log, errLog } = resolveMainDeps(deps);

  const result = runSkillsGuard({ cwd: cwd() });

  if (result.ok) {
    log(result.message);
  } else {
    errLog(result.message);
  }
  exit(result.exitCode);
}

// Self-invocation guard: only run `main()` when this file is executed
// directly (e.g. `node dist/skills-guard.js`). Importing it from a
// test must NOT trigger a guard run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
