/**
 * `exarchos run-tests` resolves and runs the test command of the project in the consumer's cwd.
 * Shipped agent definitions point their post-test PostToolUse hook at this verb, not at a command fixed at build time.
 * Thus the same hook works for every toolchain.
 *
 * Exit contract:
 *   - Command resolved: run it and return its exit code.
 *   - No command resolved: print the remediation to stderr and exit 0.
 *   - Malformed or unreadable `.exarchos.yml`: print the error to stderr and exit 1.
 *
 * `--dry-run` prints the resolved command and does not run it.
 */

import { resolveTestRuntime, type ResolvedRuntime } from '../config/test-runtime-resolver.js';
import {
  runResolvedCommand,
  defaultRun,
  defaultStdout,
  defaultStderr,
} from './run-verification-command.js';

/**
 * Exit code when no test command resolves. A repo with no test setup must not fail every post-Bash hook.
 * The skip prints to stderr, so it is visible.
 */
const UNRESOLVED_EXIT_CODE = 0;

/** Injectable seams, so that unit tests do not spawn a real test process. */
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

/**
 * Resolves and runs the project test command, and returns the exit code for `process.exitCode`.
 * A resolver error is a hard failure (exit 1). The handler does not fall back to a Node command.
 */
export function handleRunTests(argv: readonly string[], deps: RunTestsDeps = {}): number {
  const cwd = deps.cwd ?? process.cwd();
  const resolve = deps.resolve ?? resolveTestRuntime;
  const run = deps.run ?? defaultRun;
  const stdout = deps.stdout ?? defaultStdout;
  const stderr = deps.stderr ?? defaultStderr;
  const dryRun = argv.includes('--dry-run');

  let resolved: ResolvedRuntime;
  try {
    resolved = resolve(cwd);
  } catch (err) {
    stderr(`exarchos run-tests: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  return runResolvedCommand({
    verb: 'run-tests',
    command: resolved.test,
    remediation: resolved.remediation,
    dryRun,
    cwd,
    unresolvedExitCode: UNRESOLVED_EXIT_CODE,
    io: { run, stdout, stderr },
  });
}
