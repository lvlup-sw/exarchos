/**
 * `exarchos run-tests` resolves and runs the test command of the project in the consumer's cwd.
 * Shipped agent definitions point their post-test PostToolUse hook at this verb, not at a command fixed at build time.
 * Thus the same hook works for every toolchain.
 *
 * Exit contract:
 *   - Command resolved: the verifier runs it, and the verb returns the exit code of the child.
 *   - No command resolved: print the remediation to stderr and exit 0.
 *   - Malformed or unreadable `.exarchos.yml`: print the error to stderr and exit 1.
 *   - No provisioned verifier: an actual run runs nothing and exits 78, with a message that tells the user to provision the verifier.
 *   - Provisioned verifier: a host refusal, a key conflict or a dirty tree exits 77. An unavailable or pending verifier exits 75.
 *
 * `--dry-run` prints the resolved command and does not run it. The verb never runs the command locally.
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

/** Exit code of a host refusal, a key conflict or a dirty tree on a provisioned machine. */
export const HOST_REFUSED_EXIT_CODE = 77;

/** Exit code of an unavailable, busy, incomplete or pending verifier, and of a hosted run with no verdict. */
export const HOST_UNAVAILABLE_EXIT_CODE = 75;

/** Exit code of an actual run on a machine with no provisioned verifier. */
export const NOT_PROVISIONED_EXIT_CODE = 78;

/** The outcome of one hosted test run. Only an exited run carries the child exit code. */
export type HostedTestRun =
  | { readonly kind: 'exited'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

/** The verifier host of a provisioned machine. The verbs layer supplies it, and it waits for the authenticated result. */
export interface RunTestsHost {
  run(cwd: string, argv: readonly string[]): Promise<HostedTestRun>;
}

/** The inputs of one run. No input selects a local run, so a run with no host has one outcome. */
export interface RunTestsDeps {
  /** Project root to resolve and run in. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Test-runtime resolver. Defaults to the canonical `resolveTestRuntime`. */
  resolve?: (repoRoot: string) => ResolvedRuntime;
  /** The verifier host of a provisioned machine. Without it, an actual run exits 78. */
  host?: RunTestsHost;
  /** The platform that the exit 78 message names when it is not Linux. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/**
 * Resolves the project test command, runs it in the verifier, and returns the exit code for `process.exitCode`.
 * A resolver error is a hard failure (exit 1). The handler does not fall back to a Node command.
 * With a host, the handler waits for the authenticated hosted result. Without a host, an actual run exits 78 and runs nothing.
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
  const platform = deps.platform ?? process.platform;
  return runResolvedCommand({
    verb: 'run-tests',
    command: resolved.test,
    remediation: resolved.remediation,
    dryRun,
    cwd,
    unresolvedExitCode: UNRESOLVED_EXIT_CODE,
    io: {
      run: host === undefined ? () => notProvisioned(platform, stderr) : (cmd, args) => runHostedTests(host, cwd, [cmd, ...args], stdout, stderr),
      stdout,
      stderr,
    },
  });
}

/** Report an actual run on a machine with no verifier. On a platform other than Linux, the message names that platform. */
function notProvisioned(platform: NodeJS.Platform, stderr: (s: string) => void): number {
  stderr(platform === 'linux'
    ? 'exarchos run-tests: no verifier is provisioned on this machine, so the test command did not run. '
      + 'Provision the verifier client at ~/.exarchos/verifier/client.json, then run the tests again.'
    : `exarchos run-tests: the hosted verifier does not support the ${platform} platform, so the test command did not run. `
      + 'Provision the verifier on a supported Linux machine, then run the tests there.');
  return NOT_PROVISIONED_EXIT_CODE;
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
