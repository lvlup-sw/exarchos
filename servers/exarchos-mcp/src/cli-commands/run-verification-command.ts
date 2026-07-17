/**
 * Shared execution core for the `exarchos run-*` verification verbs. `run-tests`
 * is the only such verb shipping today (the `run-mutation` / `run-contract`
 * shims were removed in the wave-1 debloat); the core stays verb-generic so any
 * future explicitly-invoked verification verb can reuse it without drift.
 *
 * Each verb resolves a command from the verification runtime (in the consumer's
 * cwd) and then runs it with an identical exit-code contract:
 *   - resolved  → exec it, propagate the child's exit code.
 *   - dry-run   → print the resolved command, exit 0, do NOT execute.
 *   - unparseable command → print to stderr, exit 1.
 *
 * The ONE policy that differs between verbs is what an UNRESOLVED command means:
 *   - `run-tests` treats it as a benign skip (exit 0) — a repo with no test
 *     setup must not fail every post-Bash hook, but the skip is visible.
 *   - an explicitly-invoked verb passes a non-zero code, so an unresolved
 *     runner is a failure with remediation.
 * That single axis is the `unresolvedExitCode` parameter; everything else is
 * shared here so the verbs cannot drift apart. This module is extracted from
 * the original run-tests handler WITHOUT changing its behavior.
 */

import { runCommandSync } from '../utils/process.js';
import { splitCommand } from '../config/tokenize-command.js';

/** Injectable seams so unit tests never spawn a real process (DIM-4). */
export interface RunCommandIo {
  /** Command runner. Returns the child exit code. */
  run: (cmd: string, args: readonly string[], cwd: string) => number;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface RunResolvedCommandArgs {
  /** Verb label for diagnostics, e.g. `run-tests`. */
  readonly verb: string;
  /** The resolved command string, or null/empty when unresolved. */
  readonly command: string | null;
  /** Remediation text surfaced on the unresolved path. */
  readonly remediation?: string;
  /** Whether `--dry-run` was passed (print, do not execute). */
  readonly dryRun: boolean;
  /** Working directory to run in. */
  readonly cwd: string;
  /**
   * Exit code to return when the command is unresolved. `run-tests` passes 0
   * (benign skip); the explicitly-invoked verbs pass a non-zero code.
   */
  readonly unresolvedExitCode: number;
  readonly io: RunCommandIo;
}

/** Default runner: stream the child's stdio through and propagate its exit code. */
export function defaultRun(cmd: string, args: readonly string[], cwd: string): number {
  try {
    runCommandSync(cmd, args as string[], { cwd, stdio: 'inherit' });
    return 0;
  } catch (err) {
    // execFileSync throws on non-zero exit; `status` carries the child's code.
    const status = (err as { status?: number }).status;
    return typeof status === 'number' ? status : 1;
  }
}

/** Default stdout writer that ensures a trailing newline. */
export function defaultStdout(s: string): void {
  process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
}

/** Default stderr writer that ensures a trailing newline. */
export function defaultStderr(s: string): void {
  process.stderr.write(s.endsWith('\n') ? s : `${s}\n`);
}

/**
 * Run an already-resolved command per the shared exit-code contract. Returns
 * the exit code; the caller sets `process.exitCode` so there is no
 * `process.exit` here (keeping the handler pure and testable).
 */
export function runResolvedCommand(args: RunResolvedCommandArgs): number {
  const { verb, command, remediation, dryRun, cwd, unresolvedExitCode, io } = args;

  if (command === null || command.trim().length === 0) {
    io.stderr(
      `exarchos ${verb}: no command resolved — ${remediation ?? 'no project markers or .exarchos.yml command found'}`,
    );
    return unresolvedExitCode;
  }

  if (dryRun) {
    io.stdout(command);
    return 0;
  }

  let cmd: string;
  let cmdArgs: readonly string[];
  try {
    ({ cmd, args: cmdArgs } = splitCommand(command));
  } catch (err) {
    io.stderr(
      `exarchos ${verb}: unparseable command "${command}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (cmd === '') {
    io.stderr(`exarchos ${verb}: empty command resolved from "${command}"`);
    return unresolvedExitCode;
  }

  return io.run(cmd, cmdArgs, cwd);
}
