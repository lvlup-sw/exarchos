/**
 * `exarchos run-tests` resolves and runs the test command of the project in the consumer's cwd.
 * Shipped agent definitions point their post-test PostToolUse hook at this verb, not at a command fixed at build time.
 * Thus the same hook works for every toolchain.
 *
 * Exit contract:
 *   - Command resolved: run it and return its exit code.
 *   - No command resolved: print the remediation to stderr and exit 0.
 *   - Malformed or unreadable `.exarchos.yml`: print the error to stderr and exit 1.
 *   - Provisioned verifier: a host refusal, a key conflict or a dirty tree exits 77. An unavailable or pending verifier exits 75.
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

/** Exit code of a host refusal, a key conflict or a dirty tree on a provisioned machine. */
export const HOST_REFUSED_EXIT_CODE = 77;

/** Exit code of an unavailable, busy, incomplete or pending verifier, and of a hosted run with no verdict. */
export const HOST_UNAVAILABLE_EXIT_CODE = 75;

/** The outcome of one hosted test run. Only an exited run carries the child exit code. */
export type HostedTestRun =
  | { readonly kind: 'exited'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

/** The verifier host of a provisioned machine. The verbs layer supplies it, and it waits for the authenticated result. */
export interface RunTestsHost {
  run(cwd: string, argv: readonly string[]): Promise<HostedTestRun>;
}

/** Injectable seams, so that unit tests do not spawn a real test process. */
export interface RunTestsDeps {
  /** Project root to resolve and run in. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Test-runtime resolver. Defaults to the canonical `resolveTestRuntime`. */
  resolve?: (repoRoot: string) => ResolvedRuntime;
  /** Command runner. Returns the child exit code. Defaults to `execFileSync` with inherited stdio. */
  run?: (cmd: string, args: readonly string[], cwd: string) => number;
  /** The verifier host of a provisioned machine. Without it, the verb keeps its local route. */
  host?: RunTestsHost;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/**
 * Resolves and runs the project test command, and returns the exit code for `process.exitCode`.
 * A resolver error is a hard failure (exit 1). The handler does not fall back to a Node command.
 * With a host, the handler waits for the authenticated hosted result and never runs the command locally.
 */
export async function handleRunTests(argv: readonly string[], deps: RunTestsDeps = {}): Promise<number> {
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
      run: host === undefined ? deps.run ?? defaultRun : (cmd, args) => runHostedTests(host, cwd, [cmd, ...args], stdout, stderr),
      stdout,
      stderr,
    },
  });
}

/** Wait for the hosted run and map each cause to its own exit code and message. */
async function runHostedTests(
  host: RunTestsHost, cwd: string, argv: readonly string[], stdout: (s: string) => void, stderr: (s: string) => void,
): Promise<number> {
  const run = await host.run(cwd, argv);
  switch (run.kind) {
    case 'refused':
      stderr(`exarchos run-tests: the verifier refused the test run: ${run.message}`);
      return HOST_REFUSED_EXIT_CODE;
    case 'unavailable':
      stderr(`exarchos run-tests: the verifier gave no result: ${run.message}`);
      return HOST_UNAVAILABLE_EXIT_CODE;
    case 'exited':
      if (run.stdout.length > 0) stdout(run.stdout);
      if (run.stderr.length > 0) stderr(run.stderr);
      return run.exitCode;
  }
}
