/**
 * CI `hooks:guard` check (#1476 T10) — detects drift between the
 * `hooks-src/` source and the committed `hooks/` generated tree.
 *
 * Mirrors `skills-guard.ts`: runs `buildAllHooks()` in-process against the
 * project root, then invokes `git diff --exit-code hooks/`. A non-empty diff
 * means either:
 *
 *   1. A developer changed `hooks-src/` but forgot to run
 *      `npm run build:hooks` and commit the regenerated output, or
 *   2. A developer hand-edited a generated file under `hooks/` (which the
 *      build has just overwritten).
 *
 * Either way the guard fails with a remediation message pointing at
 * `npm run build:hooks`.
 *
 * Exported `runHooksGuard()` is testable — tests hand it a temp project root.
 * The CLI at the bottom wires it to `process.cwd()` / `process.exit()`.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildAllHooks } from './build-hooks.js';
import { resolveMainDeps, type MainDeps } from './cli-helpers.js';

export interface HooksGuardResult {
  ok: boolean;
  exitCode: number;
  message: string;
}

export interface HooksGuardOptions {
  cwd: string;
}

const REMEDIATION =
  "Generated hooks are stale. Run 'npm run build:hooks' and commit the result.";

/**
 * Run the hooks build and verify the generated `hooks/` tree matches what is
 * committed in git. Does not modify anything outside `opts.cwd` and does not
 * call `process.exit` — the CLI wrapper handles exit.
 *
 * @param opts.cwd - Absolute path to the project root. Must contain
 *   `hooks-src/`, `runtimes/`, and a git repo whose HEAD tracks the current
 *   state of `hooks/`.
 */
export function runHooksGuard(opts: HooksGuardOptions): HooksGuardResult {
  const { cwd } = opts;

  // Step 1: regenerate `hooks/`. A build failure is a guard failure because
  // CI must not pass if the source tree can't even render.
  let buildFailed = false;
  let buildDetail = '';
  try {
    buildAllHooks({
      srcDir: join(cwd, 'hooks-src'),
      outDir: join(cwd, 'hooks'),
      runtimesDir: join(cwd, 'runtimes'),
    });
  } catch (err) {
    buildFailed = true;
    buildDetail = err instanceof Error ? err.message : String(err);
  }

  if (buildFailed) {
    return {
      ok: false,
      exitCode: 1,
      message: `[hooks:guard] build failed: ${buildDetail}\n${REMEDIATION}`,
    };
  }

  // Step 2: diff `hooks/` vs HEAD.
  const diff = checkGitDiff(cwd, 'hooks/');
  if (diff !== null) {
    return { ok: false, exitCode: 1, message: diff };
  }

  return {
    ok: true,
    exitCode: 0,
    message: '[hooks:guard] hooks/ is in sync with hooks-src/',
  };
}

/**
 * Run `git diff --exit-code -- <pathspec>` against `cwd`. Returns `null` when
 * the tree is clean (exit 0); otherwise a formatted failure message.
 */
function checkGitDiff(cwd: string, pathspec: string): string | null {
  try {
    execFileSync('git', ['diff', '--exit-code', '--', pathspec], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    const status = getExecErrorStatus(err);
    const stdout = getExecErrorStdout(err);
    const stderr = getExecErrorStderr(err);

    if (status === 1) {
      return [
        `[hooks:guard] generated hooks/ tree is stale (drift detected).`,
        REMEDIATION,
        '',
        'Diff:',
        stdout.length > 0 ? stdout : '(no diff output captured)',
      ].join('\n');
    }

    return [
      `[hooks:guard] git diff failed for hooks/ (exit ${status ?? 'unknown'})`,
      stderr || stdout || String(err),
      REMEDIATION,
    ].join('\n');
  }
}

function getExecErrorStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

function getExecErrorStdout(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'stdout' in err) {
    const out = (err as { stdout: unknown }).stdout;
    if (Buffer.isBuffer(out)) return out.toString('utf8');
    if (typeof out === 'string') return out;
  }
  return '';
}

function getExecErrorStderr(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'stderr' in err) {
    const out = (err as { stderr: unknown }).stderr;
    if (Buffer.isBuffer(out)) return out.toString('utf8');
    if (typeof out === 'string') return out;
  }
  return '';
}

// -----------------------------------------------------------------------------
// CLI entry (`npm run hooks:guard`)
// -----------------------------------------------------------------------------

export type { MainDeps } from './cli-helpers.js';

export function main(_argv: string[], deps: MainDeps = {}): void {
  const { cwd, exit, log, errLog } = resolveMainDeps(deps);
  const result = runHooksGuard({ cwd: cwd() });
  if (result.ok) {
    log(result.message);
  } else {
    errLog(result.message);
  }
  exit(result.exitCode);
}

// Self-invocation guard: only run `main()` when this file is executed
// directly (e.g. `node dist/hooks-guard.js`).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
