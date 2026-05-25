/**
 * `exarchos run-tests` — resolve and run the project's test command at the
 * consumer's runtime (#1470/#1483 F1).
 *
 * Shipped agent definitions wire their post-test PostToolUse hook to
 * `exarchos run-tests` rather than a baked command. The same invocation is
 * toolchain-neutral across every consumer: resolution happens here, in the
 * consumer's cwd, via the canonical `resolveTestRuntime` — not at exarchos
 * build time. This replaces the gen-time `{{testCommand}}` placeholder, which
 * resolved against THIS repo and shipped `npm run test:run` baked into the
 * artifacts (INV-4 platform-agnosticity).
 *
 * Exit contract (DIM-2 — no silent swallow):
 *   - test command resolved → exec it, propagate its exit code.
 *   - unresolved (no markers / no config) → print the remediation to stderr
 *     and exit 0. A repo with no detectable test setup must not fail every
 *     post-Bash hook, but the skip is visible, never silent.
 *   - malformed/unreadable `.exarchos.yml` → `resolveTestRuntime` throws a
 *     hard failure; print it to stderr and exit 1. A bad config surfaces.
 *
 * `--dry-run` (INV-5c aspire-verbs) prints the resolved command without
 * executing — the query affordance. The default is to run, because the hook
 * needs execution.
 */

import { execFileSync } from 'node:child_process';
import { resolveTestRuntime, type ResolvedRuntime } from '../config/test-runtime-resolver.js';
import { splitCommand } from '../config/tokenize-command.js';

/** Injectable seams so unit tests never spawn a real test process (DIM-4). */
export interface RunTestsDeps {
  /** Project root to resolve and run in. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Test-runtime resolver. Defaults to the canonical `resolveTestRuntime`. */
  resolve?: (repoRoot: string) => ResolvedRuntime;
  /** Command runner. Returns the child exit code. Defaults to `execFileSync` with inherited stdio. */
  run?: (cmd: string, args: readonly string[], cwd: string) => number;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/** Default runner: stream the child's stdio through and propagate its exit code. */
function defaultRun(cmd: string, args: readonly string[], cwd: string): number {
  try {
    execFileSync(cmd, args as string[], { cwd, stdio: 'inherit' });
    return 0;
  } catch (err) {
    // execFileSync throws on non-zero exit; `status` carries the child's code.
    const status = (err as { status?: number }).status;
    return typeof status === 'number' ? status : 1;
  }
}

/**
 * Resolve and run the project test command. Returns the process exit code so
 * the caller can set `process.exitCode` — no `process.exit` here, keeping the
 * handler pure and testable.
 */
export function handleRunTests(argv: readonly string[], deps: RunTestsDeps = {}): number {
  const cwd = deps.cwd ?? process.cwd();
  const resolve = deps.resolve ?? resolveTestRuntime;
  const run = deps.run ?? defaultRun;
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`));
  const dryRun = argv.includes('--dry-run');

  let resolved: ResolvedRuntime;
  try {
    resolved = resolve(cwd);
  } catch (err) {
    // DIM-2: a malformed/unreadable .exarchos.yml is a hard failure — surface
    // it, never default silently to a Node command.
    stderr(`exarchos run-tests: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (resolved.test === null || resolved.test.trim().length === 0) {
    stderr(
      `exarchos run-tests: no test command resolved — ${resolved.remediation ?? 'no project markers or .exarchos.yml test command found'}`,
    );
    return 0;
  }

  if (dryRun) {
    stdout(resolved.test);
    return 0;
  }

  let cmd: string;
  let args: readonly string[];
  try {
    ({ cmd, args } = splitCommand(resolved.test));
  } catch (err) {
    stderr(`exarchos run-tests: unparseable test command "${resolved.test}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (cmd === '') {
    stderr(`exarchos run-tests: empty test command resolved from "${resolved.test}"`);
    return 0;
  }

  return run(cmd, args, cwd);
}
