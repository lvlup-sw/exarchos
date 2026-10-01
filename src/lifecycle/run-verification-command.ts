/**
 * Shared execution core for the `exarchos run-*` verification verbs. `run-tests` is the only
 * caller. The core stays verb-generic, so a new verification verb can reuse it.
 *
 * The verb resolves a command in the cwd of the consumer. Then this core applies one exit-code
 * contract:
 *   - A resolved command runs, and the core returns the exit code of the child.
 *   - With `dryRun`, the core prints the command and returns 0.
 *   - An unparseable command prints to stderr and returns 1.
 *   - An unresolved or empty command returns `unresolvedExitCode`. Only this code differs
 *     between verbs.
 */

import { runCommandSync } from '../utils/process.js';
import { splitCommand } from '../config/tokenize-command.js';

/** Injectable seams, so unit tests do not spawn a real process. */
export interface RunCommandIo {
  /** Command runner. Returns the child exit code. */
  run: (cmd: string, args: readonly string[], cwd: string) => number;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface RunResolvedCommandArgs {
  /** Verb label for diagnostics, for example `run-tests`. */
  readonly verb: string;
  /** The resolved command string, or null/empty when unresolved. */
  readonly command: string | null;
  /** Remediation text surfaced on the unresolved path. */
  readonly remediation?: string | undefined;
  /** Whether `--dry-run` was passed (print, do not execute). */
  readonly dryRun: boolean;
  /** Working directory to run in. */
  readonly cwd: string;
  /**
   * Exit code to return when the command is unresolved. `run-tests` passes 0 for a visible,
   * benign skip. An explicitly-invoked verb passes a non-zero code.
   */
  readonly unresolvedExitCode: number;
  readonly io: RunCommandIo;
}

/**
 * Default runner: it streams the child stdio and returns the exit code of the child.
 * `execFileSync` throws on a non-zero exit, and its `status` holds the code.
 */
export function defaultRun(cmd: string, args: readonly string[], cwd: string): number {
  try {
    runCommandSync(cmd, args as string[], { cwd, stdio: 'inherit' });
    return 0;
  } catch (err) {
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
 * Runs a resolved command under the shared exit-code contract and returns the exit code. The
 * caller sets `process.exitCode`, so this function does not call `process.exit`.
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
