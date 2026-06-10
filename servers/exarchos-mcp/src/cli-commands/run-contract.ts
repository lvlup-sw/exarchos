/**
 * `exarchos run-contract` — resolve and run the project's contract-verification
 * commands at the consumer's runtime (verification-ladder slice 1, task 019).
 *
 * Operates over the structured `contract.{codegen, diff}` field of the
 * verification runtime: `codegen` regenerates bindings from the schema
 * artifact, `diff` runs the breaking-change check. Both legs are optional —
 * a project may wire only a diff tool. Resolution is toolchain-neutral, in the
 * consumer's cwd, via `resolveVerificationRuntime`.
 *
 * Exit contract (shares the run-command core with run-tests/run-mutation):
 *   - dry-run → print each resolved leg, exit 0, do NOT execute.
 *   - unresolved (no codegen AND no diff) → remediation to stderr, exit NON-ZERO
 *     (explicitly-invoked verb).
 *   - executed → run codegen then diff in order; propagate the FIRST non-zero
 *     exit code (a failed regen short-circuits the diff).
 *   - malformed/unreadable `.exarchos.yml` → resolver throws; print + exit 1.
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
  type RunCommandIo,
} from './run-verification-command.js';

/** Non-zero exit code for the unresolved leg (explicitly-invoked verb). */
const UNRESOLVED_EXIT_CODE = 1;

/** Injectable seams so unit tests never spawn a real process (DIM-4). */
export interface RunContractDeps {
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
 * Resolve and run the project contract commands. Returns the process exit code
 * so the caller can set `process.exitCode`.
 */
export function handleRunContract(argv: readonly string[], deps: RunContractDeps = {}): number {
  const cwd = deps.cwd ?? process.cwd();
  const resolve = deps.resolve ?? resolveVerificationRuntime;
  const run = deps.run ?? defaultRun;
  const stdout = deps.stdout ?? defaultStdout;
  const stderr = deps.stderr ?? defaultStderr;
  const io: RunCommandIo = { run, stdout, stderr };
  const dryRun = argv.includes('--dry-run');

  let resolved: ResolvedVerificationRuntime;
  try {
    resolved = resolve(cwd);
  } catch (err) {
    stderr(`exarchos run-contract: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const codegen = resolved.contract?.codegen ?? null;
  const diff = resolved.contract?.diff ?? null;

  // Unresolved when BOTH legs are absent — neither codegen nor diff to run.
  if (
    (codegen === null || codegen.trim().length === 0) &&
    (diff === null || diff.trim().length === 0)
  ) {
    stderr(
      `exarchos run-contract: no contract command resolved — ${resolved.remediation ?? 'no contract codegen/diff command found in .exarchos.yml or detection'}`,
    );
    return UNRESOLVED_EXIT_CODE;
  }

  // Run (or print) each present leg in order: codegen first (regen bindings),
  // then diff (breaking-change check). The shared run-command core handles
  // dry-run printing and split/exec; an absent leg is skipped (exit 0).
  for (const leg of [codegen, diff]) {
    if (leg === null || leg.trim().length === 0) continue;
    const code = runResolvedCommand({
      verb: 'run-contract',
      command: leg,
      remediation: resolved.remediation,
      dryRun,
      cwd,
      unresolvedExitCode: UNRESOLVED_EXIT_CODE,
      io,
    });
    // A failed leg short-circuits (failed regen → skip diff). Dry-run always
    // returns 0 per leg, so the loop prints both legs before returning.
    if (code !== 0) return code;
  }

  return 0;
}
