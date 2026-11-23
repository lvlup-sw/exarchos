/**
 * `exarchos run-tests` resolves and runs the test command of the project in the consumer's cwd.
 * Shipped agent definitions point their post-test PostToolUse hook at this verb, not at a command fixed at build time.
 * Thus the same hook works for every toolchain.
 *
 * Exit contract:
 *   - Command resolved: the local approved-check executor runs it, and the verb returns the exit code of the child.
 *   - No command resolved: print the remediation to stderr and exit 0.
 *   - Malformed or unreadable `.exarchos.yml`: print the error to stderr and exit 1.
 *   - A refused run exits 77: a dirty tree, a working directory that is not a checkout root, or a program inside the checkout.
 *   - A run with no verdict exits 75: a time cap, an output cap, a signal, or a program that does not start.
 *
 * `--dry-run` prints the resolved command and does not run it.
 */

import { resolveTestRuntime, type ResolvedRuntime } from '../config/test-runtime-resolver.js';
import {
  runResolvedCommand,
  defaultStdout,
  defaultStderr,
} from './run-verification-command.js';

/**
 * Exit code when no test command resolves. A repo with no test setup must not fail every post-Bash hook.
 * The skip prints to stderr, so it is visible.
 */
const UNRESOLVED_EXIT_CODE = 0;

/** Exit code of a run that the executor refused. */
export const REFUSED_EXIT_CODE = 77;

/** Exit code of a run with no verdict. */
export const UNAVAILABLE_EXIT_CODE = 75;

/** The outcome of one local test run. Only an exited run carries the child exit code. */
export type LocalTestRun =
  | { readonly kind: 'exited'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

/** The local host of the verb. The verbs layer supplies it, and it runs the command in the local approved-check executor. */
export interface RunTestsHost {
  run(cwd: string, argv: readonly string[]): Promise<LocalTestRun>;
}

/** The inputs of one run. The host is required, so every resolved command runs through it. */
export interface RunTestsDeps {
  /** Project root to resolve and run in. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Test-runtime resolver. Defaults to the canonical `resolveTestRuntime`. */
  resolve?: (repoRoot: string) => ResolvedRuntime;
  /** The local host that runs the resolved command. */
  host: RunTestsHost;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/**
 * Resolves the project test command, runs it through the local host, and returns the exit code for `process.exitCode`.
 * A resolver error is a hard failure (exit 1). The handler does not fall back to a Node command.
 */
export async function handleRunTests(argv: readonly string[], deps: RunTestsDeps): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const resolve = deps.resolve ?? resolveTestRuntime;
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

  const host = deps.host;
  return runResolvedCommand({
    verb: 'run-tests',
    command: resolved.test,
    remediation: resolved.remediation,
    dryRun,
    cwd,
    unresolvedExitCode: UNRESOLVED_EXIT_CODE,
    io: {
      run: (cmd, args) => runLocalTests(host, cwd, [cmd, ...args], stdout, stderr),
      stdout,
      stderr,
    },
  });
}

/** Wait for the local run and map each cause to its own exit code and message. */
async function runLocalTests(
  host: RunTestsHost, cwd: string, argv: readonly string[], stdout: (s: string) => void, stderr: (s: string) => void,
): Promise<number> {
  const run = await host.run(cwd, argv);
  switch (run.kind) {
    case 'refused':
      stderr(`exarchos run-tests: the executor refused the test run: ${run.message}`);
      return REFUSED_EXIT_CODE;
    case 'unavailable':
      stderr(`exarchos run-tests: the test run gave no result: ${run.message}`);
      return UNAVAILABLE_EXIT_CODE;
    case 'exited':
      if (run.stdout.length > 0) stdout(run.stdout);
      if (run.stderr.length > 0) stderr(run.stderr);
      return run.exitCode;
  }
}
