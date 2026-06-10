/**
 * `exarchos run-mutation` — resolve and run the project's mutation-testing
 * command at the consumer's runtime (verification-ladder slice 1, task 018).
 *
 * Mirrors `run-tests` exactly, resolving the `mutation` field of the
 * verification runtime (`resolveVerificationRuntime`) in the consumer's cwd —
 * toolchain-neutral, never baked at exarchos build time.
 *
 * Exit contract (shared with run-tests via run-verification-command, differing
 * only on the unresolved leg):
 *   - mutation command resolved → exec it, propagate its exit code.
 *   - unresolved → print remediation to stderr and exit NON-ZERO. Unlike
 *     run-tests' benign skip, an explicitly-invoked mutation run with no
 *     resolvable runner is a failure the caller asked for.
 *   - malformed/unreadable `.exarchos.yml` → resolver throws; print + exit 1.
 *
 * `--dry-run` prints the resolved command without executing.
 */

import {
  resolveVerificationRuntime,
  type ResolvedVerificationRuntime,
} from '../config/test-runtime-resolver.js';
import {
  runResolvedCommand,
  defaultRun,
  defaultStdout,
  defaultStderr,
} from './run-verification-command.js';

/** Non-zero exit code for the unresolved leg (explicitly-invoked verb). */
const UNRESOLVED_EXIT_CODE = 1;

/** Injectable seams so unit tests never spawn a real process (DIM-4). */
export interface RunMutationDeps {
  /** Project root to resolve and run in. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Verification-runtime resolver. Defaults to `resolveVerificationRuntime`. */
  resolve?: (repoRoot: string) => ResolvedVerificationRuntime;
  /** Command runner. Returns the child exit code. Defaults to `execFileSync` with inherited stdio. */
  run?: (cmd: string, args: readonly string[], cwd: string) => number;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/**
 * Resolve and run the project mutation command. Returns the process exit code
 * so the caller can set `process.exitCode`.
 */
export function handleRunMutation(argv: readonly string[], deps: RunMutationDeps = {}): number {
  const cwd = deps.cwd ?? process.cwd();
  const resolve = deps.resolve ?? resolveVerificationRuntime;
  const run = deps.run ?? defaultRun;
  const stdout = deps.stdout ?? defaultStdout;
  const stderr = deps.stderr ?? defaultStderr;
  const dryRun = argv.includes('--dry-run');

  let resolved: ResolvedVerificationRuntime;
  try {
    resolved = resolve(cwd);
  } catch (err) {
    // A malformed/unreadable .exarchos.yml is a hard failure (DIM-2).
    stderr(`exarchos run-mutation: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  return runResolvedCommand({
    verb: 'run-mutation',
    command: resolved.mutation,
    remediation: resolved.remediation,
    dryRun,
    cwd,
    unresolvedExitCode: UNRESOLVED_EXIT_CODE,
    io: { run, stdout, stderr },
  });
}
