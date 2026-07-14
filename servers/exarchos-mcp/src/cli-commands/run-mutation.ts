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
import { logger } from '../logger.js';

const mutationLogger = logger.child({ subsystem: 'run-mutation' });

/** Non-zero exit code for the unresolved leg (explicitly-invoked verb). */
const UNRESOLVED_EXIT_CODE = 1;

/**
 * Minimal event-store seam the run-mutation verb needs for INV-10 liveness
 * emission. Structural so the CLI can pass either a real `EventStore` or a thin
 * adapter; the verb only ever appends two events. When absent (invoked outside
 * a workspace) emission is skipped — never a crash.
 */
export interface RunMutationEventStore {
  append: (
    stream: string,
    event: { type: string; data: unknown },
  ) => void | Promise<void>;
}

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
  /**
   * Event store for INV-10 liveness emission. When provided WITH `stream`, the
   * verb emits `mutation.executing_started` at the start of the execution path
   * and `mutation.executed` (paired terminal) at the end. Omit either to skip
   * emission (the CLI passes none when run outside a workspace).
   */
  eventStore?: RunMutationEventStore;
  /** Stream to emit liveness events on (typically the active featureId). */
  stream?: string;
  /**
   * DR-2 — canonical INV-10 liveness instance key for the mutation surface. When
   * provided it is stamped (additive) as `instanceId` on BOTH liveness events so
   * a uniform liveness view can correlate the mutation start↔terminal without
   * per-surface field knowledge. Omitted (no `instanceId` field) when absent, so
   * a pre-retrofit / operation-less invocation still validates.
   */
  operationId?: string;
}

/** Fire-and-forget emit that never throws into the run path (degrade per INV-4). */
function emitLiveness(
  store: RunMutationEventStore,
  stream: string,
  type: 'mutation.executing_started' | 'mutation.executed',
  data: Record<string, unknown>,
): void {
  try {
    const maybe = store.append(stream, { type, data });
    if (maybe && typeof (maybe as Promise<void>).then === 'function') {
      (maybe as Promise<void>).catch((err: unknown) => {
        mutationLogger.warn(
          { err: (err as Error)?.message ?? String(err), type },
          'mutation liveness emission failed',
        );
      });
    }
  } catch (err) {
    mutationLogger.warn(
      { err: (err as Error)?.message ?? String(err), type },
      'mutation liveness emission failed',
    );
  }
}

/**
 * Resolve and run the project mutation command. Returns the process exit code
 * so the caller can set `process.exitCode`.
 *
 * INV-10 liveness: on the EXECUTION path (not dry-run, resolved + parseable),
 * `mutation.executing_started` is emitted before the child runs and a paired
 * `mutation.executed` (verdict + exit code) after. Emission is wrapped around
 * the `run` seam so it fires exactly when the real command executes — never on
 * dry-run, unresolved, or unparseable paths.
 */
export function handleRunMutation(argv: readonly string[], deps: RunMutationDeps = {}): number {
  const cwd = deps.cwd ?? process.cwd();
  const resolve = deps.resolve ?? resolveVerificationRuntime;
  const baseRun = deps.run ?? defaultRun;
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

  // Liveness is only meaningful around the actual child execution. Wrap the
  // `run` seam: `runResolvedCommand` invokes it ONLY on the execution path
  // (resolved + parseable + not dry-run), so the pair brackets exactly the
  // real run. When no event store/stream is wired, the wrapper is a no-op
  // passthrough — the run still happens.
  const canEmit = deps.eventStore !== undefined && deps.stream !== undefined && deps.stream !== '';
  const run: (cmd: string, args: readonly string[], runCwd: string) => number = canEmit
    ? (cmd, args, runCwd) => {
        const command = resolved.mutation ?? cmd;
        // DR-2 — stamp the canonical liveness instance key (additive) only when
        // an operationId is supplied; omit the field otherwise so operation-less
        // invocations stay valid against the additive-optional schema.
        const instanceIdField =
          deps.operationId !== undefined ? { instanceId: deps.operationId } : {};
        emitLiveness(deps.eventStore!, deps.stream!, 'mutation.executing_started', {
          command,
          repoRoot: runCwd,
          ...instanceIdField,
        });
        const exitCode = baseRun(cmd, args, runCwd);
        emitLiveness(deps.eventStore!, deps.stream!, 'mutation.executed', {
          command,
          repoRoot: runCwd,
          passed: exitCode === 0,
          exitCode,
          ...instanceIdField,
        });
        return exitCode;
      }
    : baseRun;

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
