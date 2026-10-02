/**
 * The hooks guard: detects drift between the hook sources under `content/harness/` and the committed
 * `hooks/` and `binding/` trees.
 *
 * Like `skills-guard.ts`, it runs `buildAllHooks()` in process and then runs `git diff --exit-code` on the
 * output. A diff means that a source changed with no rebuild, or that someone edited a generated file. The
 * failure message points at `npm run build:hooks`.
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
 * Runs the hooks build and checks that the generated `hooks/` and `binding/` trees match git. A build error
 * is a guard failure, because CI must not pass when the sources do not render. It writes only under
 * `opts.cwd` and does not call `process.exit`.
 *
 * @param opts.cwd - Absolute path to the project root. Must contain
 *   `content/harness/hooks/`, `content/harness/runtimes/`, and a git repo whose HEAD tracks the current
 *   state of `hooks/`.
 */
export function runHooksGuard(opts: HooksGuardOptions): HooksGuardResult {
  const { cwd } = opts;

  let buildFailed = false;
  let buildDetail = '';
  try {
    buildAllHooks({
      srcDir: join(cwd, 'content/harness/hooks'),
      bindingSrcDir: join(cwd, 'content/harness/binding'),
      outDir: join(cwd, 'hooks'),
      bindingOutDir: join(cwd, 'binding'),
      runtimesDir: join(cwd, 'content/harness/runtimes'),
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

  const diff = checkGitDiff(cwd, 'hooks/', 'binding/');
  if (diff !== null) {
    return { ok: false, exitCode: 1, message: diff };
  }

  return {
    ok: true,
    exitCode: 0,
    message: '[hooks:guard] hooks/ + binding/ are in sync with sources',
  };
}

/**
 * Runs `git diff --exit-code -- <pathspec>` in `cwd`. Returns `null` when the tree is clean (exit 0), or a
 * failure message.
 */
function checkGitDiff(cwd: string, ...pathspecs: string[]): string | null {
  try {
    execFileSync('git', ['diff', '--exit-code', '--', ...pathspecs], {
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

export type { MainDeps } from './cli-helpers.js';

/**
 * CLI entry: `node dist/install/hooks-guard.js`. The guard after it calls `main()` only when Node runs this
 * file directly.
 */
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
