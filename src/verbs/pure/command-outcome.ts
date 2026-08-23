// ─── Command Failure Classification ─────────────────────────────────────────
//
// What a thrown `runCommandSync` / `execFileSync` error establishes about the
// command that produced it. Three outcomes, because three are genuinely
// different pieces of evidence and flattening them is what lets a gate report
// a missing binary as a failing test:
//
//   • `exit`    — the process ran and returned a non-zero status. That IS a
//                 verdict, and it is the only one of the three that is.
//   • `spawn`   — the process was never created (ENOENT/EACCES/…). Nothing ran,
//                 so nothing failed; the gate measured nothing.
//   • `timeout` — the process was killed at its wall clock. Whatever it printed
//                 is a truncated prefix and the status belongs to the kill, not
//                 to the work.
//
// The discriminant is a NUMERIC EXIT STATUS first: a process that exited
// produced a verdict whatever the code. Only a throw carrying no numeric
// `status` can be one of the other two, and then a recognized errno decides
// which. Set membership, not "any string code", so an output-ceiling kill
// (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) — which happens AFTER the process ran —
// is not mistaken for a process that never started.
// ────────────────────────────────────────────────────────────────────────────

/** What the failed command established. Only `exit` is a verdict. */
export type CommandFailureKind = 'exit' | 'spawn' | 'timeout';

export interface CommandFailure {
  readonly kind: CommandFailureKind;
  /**
   * Not authoritative unless `kind` is `'exit'`. On the other two arms it is a
   * placeholder in the command-not-found / timeout-kill tradition, present so
   * callers with an exit-code-shaped carrier have something to put there.
   */
  readonly exitCode: number;
  /** One line naming the cause, suitable for a gate's "could not run" reason. */
  readonly detail: string;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * OS-level errno codes that mean the child was NEVER created. Restricting the
 * classification to this set keeps a process that DID run from being mislabeled.
 */
const SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOENT', // command / file does not exist
  'EACCES', // not permitted to execute the file
  'EPERM', // operation not permitted
  'ENOTDIR', // a path component is not a directory
  'ENOMEM', // could not allocate to fork the child
]);

/** The errno a runner killed for exceeding its time limit reports. */
const TIMEOUT_ERROR_CODE = 'ETIMEDOUT';

/** Placeholder exit code for a command that never started. */
const NOT_SPAWNED_EXIT_CODE = 127;

/** Placeholder exit code for a command killed at its wall clock. */
const TIMED_OUT_EXIT_CODE = 124;

/** The fields a Node child-process failure carries that this reads. */
interface ChildFailureShape {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf-8');
  return '';
}

/**
 * One line naming the cause. Node puts the useful part in `code` (`ENOENT`,
 * `ETIMEDOUT`, …) and repeats the command plus, sometimes, an entire captured
 * transcript in `message`; only the first line of the message is kept, because
 * this string is a reason rather than a report of findings.
 */
function describe(code: string, message: string): string {
  const firstLine = message.split('\n')[0]?.trim() ?? '';
  if (code && firstLine) return `${code}: ${firstLine}`;
  return code || firstLine || 'the command did not run to completion';
}

/**
 * Classify a value thrown by a synchronous child-process call.
 *
 * Total over `unknown`: a non-object throw (a string, a rejected primitive)
 * lands on the `exit` arm with the generic detail, which is the conservative
 * reading — it is the arm that produces a finding rather than the arm that
 * withdraws one.
 */
export function classifyCommandFailure(err: unknown): CommandFailure {
  const shape: ChildFailureShape =
    typeof err === 'object' && err !== null ? (err as ChildFailureShape) : {};
  const stdout = asText(shape.stdout);
  const stderr = asText(shape.stderr);
  const code = typeof shape.code === 'string' ? shape.code : '';
  const detail = describe(code, asText(shape.message));

  if (typeof shape.status === 'number') {
    return { kind: 'exit', exitCode: shape.status, detail, stdout, stderr };
  }
  if (code === TIMEOUT_ERROR_CODE) {
    return { kind: 'timeout', exitCode: TIMED_OUT_EXIT_CODE, detail, stdout, stderr };
  }
  if (SPAWN_ERROR_CODES.has(code)) {
    return { kind: 'spawn', exitCode: NOT_SPAWNED_EXIT_CODE, detail, stdout, stderr };
  }
  // Ended without a numeric status and without a recognized spawn/timeout
  // errno — an output-ceiling kill or an unexpected signal. The process DID
  // run, so this stays a verdict rather than becoming an unmeasured leg.
  return { kind: 'exit', exitCode: 1, detail, stdout, stderr };
}

/**
 * The reason text for an inconclusive command, phrased for a gate report.
 * Returns `null` when the failure was an ordinary non-zero exit, which is a
 * verdict and needs no explanation.
 */
export function inconclusiveReason(
  command: string,
  failure: CommandFailure,
): string | null {
  switch (failure.kind) {
    case 'spawn':
      return `\`${command}\` could not be started (${failure.detail}), so it decided nothing`;
    case 'timeout':
      return `\`${command}\` was killed for exceeding its time limit before it finished`;
    case 'exit':
      return null;
  }
}
