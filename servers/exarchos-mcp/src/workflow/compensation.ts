import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'node:crypto';
import { appendEvent } from './events.js';
import { ErrorCode } from './schemas.js';
import { withStateRetry } from './state-retry.js';
import type { Event } from './types.js';
import type { EventStore } from '../event-store/store.js';

// ─── Command Execution Helper ─────────────────────────────────────────────────

const execFileAsync = promisify(execFileCb);
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Node's exec/execFile error shape, narrowed for our use. `killed` is true on
 * timeout-induced termination; `code` is the process exit code. `stderr` /
 * `stdout` carry whatever the process wrote before exit.
 *
 * We narrow this in helpers below to differentiate "the resource is absent"
 * (a benign signal we can map to false/empty) from "the environment is
 * broken" (timeout, not-a-git-repo, auth break — must surface as a real
 * failure rather than be swallowed as "already absent").
 */
interface ExecError extends Error {
  readonly code?: number | string;
  readonly killed?: boolean;
  readonly stderr?: string | Buffer;
  readonly stdout?: string | Buffer;
  readonly signal?: NodeJS.Signals | null;
}

function isExecError(err: unknown): err is ExecError {
  return err instanceof Error && ('code' in err || 'killed' in err || 'stderr' in err);
}

function execErrorStderr(err: ExecError): string {
  if (typeof err.stderr === 'string') return err.stderr;
  if (Buffer.isBuffer(err.stderr)) return err.stderr.toString('utf-8');
  return '';
}

/**
 * True when the exec error indicates the surrounding environment is broken
 * (timeout, killed by signal, not a git repository). These are operationally
 * fatal — they must NOT be silently treated as "resource already absent" by
 * the existence helpers.
 */
function isOperationalFailure(err: ExecError): boolean {
  if (err.killed === true) return true; // timeout / signal
  if (err.signal != null) return true;
  const stderr = execErrorStderr(err).toLowerCase();
  if (stderr.includes('not a git repository')) return true;
  if (stderr.includes('could not read from remote repository')) return true;
  if (stderr.includes('authentication failed')) return true;
  if (stderr.includes('permission denied')) return true;
  return false;
}

async function runCommand(cmd: string, args: readonly string[], options: CompensationOptions): Promise<void> {
  await execFileAsync(cmd, [...args], {
    cwd: options.stateDir ?? process.cwd(),
    timeout: COMMAND_TIMEOUT_MS,
  });
}

/**
 * Run a command and capture its stdout. Returns the stdout string. Does NOT
 * swallow operational failures (timeout, not-a-repo, auth break) — only
 * benign non-zero exits where the command ran cleanly but produced no output.
 *
 * Callers must still verify the returned value (empty string is a valid "no
 * match" signal for the git helpers below). See CodeRabbit #3224631272 for
 * the prior behavior (collapsed all failures into empty output) and rationale.
 */
async function runCommandCaptureStdout(
  cmd: string,
  args: readonly string[],
  options: CompensationOptions,
): Promise<string> {
  try {
    const result = await execFileAsync(cmd, [...args], {
      cwd: options.stateDir ?? process.cwd(),
      timeout: COMMAND_TIMEOUT_MS,
    });
    // promisify(execFile) resolves to { stdout, stderr } when called with
    // { encoding: 'utf-8' } — but without that option it resolves to Buffer.
    // The default encoding for promisified execFile is 'buffer', so we
    // call toString() to get a string regardless.
    const raw = result as unknown as { stdout: string | Buffer } | string;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object' && raw !== null && 'stdout' in raw) {
      const stdout = (raw as { stdout: string | Buffer }).stdout;
      return typeof stdout === 'string' ? stdout : stdout.toString('utf-8');
    }
    return '';
  } catch (err: unknown) {
    if (isExecError(err) && isOperationalFailure(err)) {
      // Re-throw operational failures so the calling helper surfaces them
      // rather than treating the resource as "already absent".
      throw err;
    }
    // Benign non-zero exit — the command ran but produced no useful output.
    // Empty stdout is the expected "no match" signal.
    return '';
  }
}

// ─── Git existence helpers ────────────────────────────────────────────────────

/**
 * Returns true when the branch exists in the local repository.
 * Uses `git rev-parse --verify` — exits non-zero when absent.
 *
 * Operational failures (not-a-repo, timeout) propagate. The previous
 * implementation swallowed ALL errors, causing compensation to report
 * `deletedLocally: false` and `executed` for branches in broken environments
 * even though no cleanup ran. (CodeRabbit #3224631272.)
 */
async function localBranchExists(branch: string, options: CompensationOptions): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--verify', branch], options);
    return true;
  } catch (err: unknown) {
    if (isExecError(err) && isOperationalFailure(err)) {
      throw err;
    }
    // Benign: rev-parse exits non-zero with "not a valid ref" stderr when
    // the branch is absent. That is the signal we want.
    return false;
  }
}

/**
 * Returns true when the branch exists on the named remote.
 * Uses `git ls-remote --heads <remote> <branch>` — empty stdout means absent.
 *
 * runCommandCaptureStdout above propagates operational failures (timeout,
 * auth break, not-a-repo) so this helper does not need a redundant catch.
 */
async function remoteBranchExists(
  branch: string,
  remote: string,
  options: CompensationOptions,
): Promise<boolean> {
  const stdout = await runCommandCaptureStdout(
    'git',
    ['ls-remote', '--heads', remote, branch],
    options,
  );
  return stdout.trim().length > 0;
}

/**
 * Returns true when the worktree at `worktreePath` is registered in
 * `git worktree list` output. Propagates operational failures via
 * runCommandCaptureStdout.
 */
async function worktreeIsRegistered(
  worktreePath: string,
  options: CompensationOptions,
): Promise<boolean> {
  const stdout = await runCommandCaptureStdout('git', ['worktree', 'list'], options);
  // Each line starts with the absolute path of the worktree, followed by
  // whitespace and the SHA/branch info. Match the path as a complete
  // token: a bare startsWith check would treat "/tmp/wt-old" as a match
  // for "/tmp/wt", routing an absent worktree down the "registered" path
  // and producing a false remove attempt. (CodeRabbit review #4278133032.)
  return stdout.split('\n').some((line) => {
    if (!line.startsWith(worktreePath)) return false;
    const next = line.charAt(worktreePath.length);
    // Empty (line === worktreePath, exact equality) or a delimiter
    // (whitespace before the SHA/branch fields). Anything else means
    // the prefix matched a longer, unrelated path.
    return next === '' || next === ' ' || next === '\t';
  });
}

// ─── Recovery operationId discovery (Sentry #14059864/1) ──────────────────
//
// When compensation crashes after emitting `*.requested` but before
// `*.executed`, the next retry would otherwise mint a fresh UUID and emit a
// duplicate `*.requested`, orphaning the prior one and violating the 1:1
// pairing contract of the audit trail. Before generating a new operationId,
// scan the feature stream for a previously-emitted `*.requested` matching
// the same target identifier (worktreePath / branch) that has no paired
// `*.executed`, and reuse its operationId. Mirrors the recovery pattern in
// `orchestrate/vcs/create-issue.ts:112-133`.

interface WorktreeRemoveRequestedData {
  readonly operationId: string;
  readonly worktreePath: string;
}

interface WorktreeRemoveExecutedData {
  readonly operationId: string;
}

interface BranchDeleteRequestedData {
  readonly operationId: string;
  readonly branch: string;
}

interface BranchDeleteExecutedData {
  readonly operationId: string;
}

async function recoverWorktreeRemoveOperationId(
  eventStore: EventStore,
  featureId: string,
  worktreePath: string,
): Promise<string | undefined> {
  const requested = await eventStore.query(featureId, {
    type: 'worktree.remove.requested',
  });
  const executed = await eventStore.query(featureId, {
    type: 'worktree.remove.executed',
  });
  const executedOps = new Set(
    executed.map((e) => (e.data as unknown as WorktreeRemoveExecutedData).operationId),
  );
  for (let i = requested.length - 1; i >= 0; i -= 1) {
    const data = requested[i].data as unknown as WorktreeRemoveRequestedData;
    if (executedOps.has(data.operationId)) continue;
    if (data.worktreePath === worktreePath) return data.operationId;
  }
  return undefined;
}

async function recoverBranchDeleteOperationId(
  eventStore: EventStore,
  featureId: string,
  branch: string,
): Promise<string | undefined> {
  const requested = await eventStore.query(featureId, {
    type: 'branch.delete.requested',
  });
  const executed = await eventStore.query(featureId, {
    type: 'branch.delete.executed',
  });
  const executedOps = new Set(
    executed.map((e) => (e.data as unknown as BranchDeleteExecutedData).operationId),
  );
  for (let i = requested.length - 1; i >= 0; i -= 1) {
    const data = requested[i].data as unknown as BranchDeleteRequestedData;
    if (executedOps.has(data.operationId)) continue;
    if (data.branch === branch) return data.operationId;
  }
  return undefined;
}

// ─── Compensation Interfaces ─────────────────────────────────────────────────

export interface CompensationAction {
  readonly id: string;
  readonly phase: string;
  readonly description: string;
  execute: (
    state: Record<string, unknown>,
    options: CompensationOptions,
  ) => Promise<CompensationActionResult>;
}

export interface CompensationCheckpoint {
  readonly completedActions: readonly string[];
}

export interface CompensationOptions {
  readonly dryRun: boolean;
  readonly stateDir?: string;
  readonly checkpoint?: CompensationCheckpoint;
  /** External event store for emitting two-event-split audit events (B4/B5). */
  readonly eventStore?: EventStore;
  /** Feature ID (stream ID) for event store appends. Required when eventStore is set. */
  readonly featureId?: string;
}

export interface CompensationActionResult {
  readonly actionId: string;
  readonly status: 'executed' | 'skipped' | 'failed' | 'dry-run';
  readonly message: string;
}

export interface CompensationResult {
  readonly actions: readonly CompensationActionResult[];
  readonly events: readonly Event[];
  readonly success: boolean;
  readonly errorCode?: string;
  readonly checkpoint: CompensationCheckpoint | null;
}

// ─── Phase Order (reverse compensation order) ───────────────────────────────

const PHASE_ORDER: readonly string[] = [
  'plan',
  'delegate',
  'review',
  'synthesize',
];

// ─── Compensation Action Registry ───────────────────────────────────────────

function createClosePrAction(): CompensationAction {
  return {
    id: 'synthesize:close-pr',
    phase: 'synthesize',
    description: 'Close the pull request if it exists',
    async execute(state, options) {
      const synthesis = state.synthesis as Record<string, unknown> | undefined;
      const prUrl = synthesis?.prUrl as string | null | undefined;

      if (!prUrl) {
        return { actionId: 'synthesize:close-pr', status: 'skipped', message: 'No PR to close' };
      }

      if (options.dryRun) {
        return {
          actionId: 'synthesize:close-pr',
          status: 'dry-run',
          message: `Would close PR: ${prUrl}`,
        };
      }

      try {
        await runCommand('gh', ['pr', 'close', prUrl, '--comment', 'Cancelled via compensation'], options);
        return { actionId: 'synthesize:close-pr', status: 'executed', message: `Closed PR: ${prUrl}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { actionId: 'synthesize:close-pr', status: 'failed', message: `Failed to close PR: ${msg}` };
      }
    },
  };
}

function createDeleteIntegrationBranchAction(): CompensationAction {
  return {
    id: 'delegate:delete-integration-branch',
    phase: 'delegate',
    description: 'Delete the integration branch if it exists',
    async execute(state, options) {
      const synthesis = state.synthesis as Record<string, unknown> | undefined;
      const branch = synthesis?.integrationBranch as string | null | undefined;

      if (!branch) {
        return {
          actionId: 'delegate:delete-integration-branch',
          status: 'skipped',
          message: 'No integration branch to delete',
        };
      }

      if (options.dryRun) {
        return {
          actionId: 'delegate:delete-integration-branch',
          status: 'dry-run',
          message: `Would delete branch: ${branch}`,
        };
      }

      try {
        // Delete local branch (ignore failure if doesn't exist)
        try {
          await runCommand('git', ['branch', '-D', branch], options);
        } catch {
          // Ignore local branch delete failure
        }
        // Delete remote branch (ignore failure if doesn't exist)
        try {
          await runCommand('git', ['push', 'origin', '--delete', branch], options);
        } catch {
          // Ignore remote delete failure
        }
        return {
          actionId: 'delegate:delete-integration-branch',
          status: 'executed',
          message: `Deleted integration branch: ${branch}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          actionId: 'delegate:delete-integration-branch',
          status: 'failed',
          message: `Failed to delete integration branch: ${msg}`,
        };
      }
    },
  };
}

function createCleanupWorktreesAction(): CompensationAction {
  return {
    id: 'delegate:cleanup-worktrees',
    phase: 'delegate',
    description: 'Remove worktrees created during delegation',
    async execute(state, options) {
      const worktrees = state.worktrees as Record<string, Record<string, unknown>> | undefined;

      if (!worktrees || Object.keys(worktrees).length === 0) {
        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'skipped',
          message: 'No worktrees to clean up',
        };
      }

      if (options.dryRun) {
        const branches = Object.values(worktrees).map((w) => w.branch as string);
        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'dry-run',
          message: `Would remove worktrees for branches: ${branches.join(', ')}`,
        };
      }

      try {
        for (const worktree of Object.values(worktrees)) {
          const worktreePath = worktree.path as string | undefined;
          if (!worktreePath) continue;

          if (options.eventStore && options.featureId) {
            // ─── B5 two-event split ──────────────────────────────────────────
            // Phase A: emit worktree.remove.requested BEFORE the git side-effect.
            // Wrapped in withStateRetry so OCC losses on the append are retried
            // WITHOUT re-running the git worktree remove command.
            const featureId = options.featureId;
            const eventStore = options.eventStore;
            // Recover the operationId from a prior orphaned `*.requested`
            // before minting a fresh UUID. Without this, a crash between
            // requested and executed produces a second requested event with
            // a new operationId, orphaning the first and breaking the 1:1
            // pairing contract. (Sentry #14059864/1.)
            const operationId =
              (await recoverWorktreeRemoveOperationId(eventStore, featureId, worktreePath)) ??
              randomUUID();
            await withStateRetry(() =>
              eventStore.append(
                featureId,
                {
                  type: 'worktree.remove.requested',
                  data: { operationId, worktreePath },
                },
                { idempotencyKey: `worktree.remove.requested:${operationId}` },
              ),
            );

            // ─── B5.3 idempotent existence check ────────────────────────────
            // Query git worktree list OUTSIDE the retry boundary so we don't
            // re-fire the remove on a retry. If the worktree is already absent,
            // emit executed { removed: false } and continue.
            const isRegistered = await worktreeIsRegistered(worktreePath, options);
            let removed = false;

            if (isRegistered) {
              try {
                await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], options);
                removed = true;
              } catch (err) {
                // Only downgrade to idempotent miss if the worktree is now
                // actually gone (e.g. another process removed it between
                // precheck and our command). If it is still registered the
                // failure is real (locked, missing repo, permission denied)
                // and must surface — silently emitting `removed: false`
                // would hide a real failure behind an idempotent-success
                // event.
                const stillRegistered = await worktreeIsRegistered(worktreePath, options);
                if (stillRegistered) {
                  throw err;
                }
              }
            }

            // Phase C: emit worktree.remove.executed with the actual outcome.
            // removed=false is an idempotent success — NOT a failure.
            // idempotencyKey scoped to operationId so a transient append
            // failure followed by retry across a process restart cannot
            // double-record the executed event.
            //
            // Wrapped in withStateRetry so a transient OCC / storage-busy
            // signal on the append does not leak as an unhandled exception
            // after the git side effect has already run. The
            // idempotencyKey above guarantees the retry is a no-op once
            // the executed event lands. (Sentry #14059285/0.)
            await withStateRetry(() =>
              eventStore.append(
                featureId,
                {
                  type: 'worktree.remove.executed',
                  data: { operationId, worktreePath, removed },
                },
                { idempotencyKey: `worktree.remove.executed:${operationId}` },
              ),
            );
          } else {
            // Legacy path (no event store wired) — preserve existing behavior
            try {
              await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], options);
            } catch {
              // Worktree may already be removed; continue
            }
          }
        }
        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'executed',
          message: `Cleaned up ${Object.keys(worktrees).length} worktree(s)`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'failed',
          message: `Failed to clean up worktrees: ${msg}`,
        };
      }
    },
  };
}

function createDeleteFeatureBranchesAction(): CompensationAction {
  return {
    id: 'delegate:delete-feature-branches',
    phase: 'delegate',
    description: 'Delete feature branches created during delegation',
    async execute(state, options) {
      const tasks = state.tasks as Array<Record<string, unknown>> | undefined;
      const branches = (tasks ?? [])
        .map((t) => t.branch as string | undefined)
        .filter((b): b is string => !!b);

      if (branches.length === 0) {
        return {
          actionId: 'delegate:delete-feature-branches',
          status: 'skipped',
          message: 'No feature branches to delete',
        };
      }

      if (options.dryRun) {
        return {
          actionId: 'delegate:delete-feature-branches',
          status: 'dry-run',
          message: `Would delete branches: ${branches.join(', ')}`,
        };
      }

      try {
        for (const branch of branches) {
          if (options.eventStore && options.featureId) {
            // ─── B4 two-event split ──────────────────────────────────────────
            // Phase A: emit branch.delete.requested BEFORE the git side-effect.
            // Wrapped in withStateRetry so OCC losses on the append are retried
            // WITHOUT re-running git branch -D (the canonical anti-pattern guard).
            const featureId = options.featureId;
            const eventStore = options.eventStore;
            // Recover the operationId from a prior orphaned `*.requested`
            // before minting a fresh UUID. Same INV-1 audit-trail rationale
            // as worktree.remove above. (Sentry #14059864/1.)
            const operationId =
              (await recoverBranchDeleteOperationId(eventStore, featureId, branch)) ??
              randomUUID();
            await withStateRetry(() =>
              eventStore.append(
                featureId,
                {
                  type: 'branch.delete.requested',
                  data: { operationId, branch },
                },
                { idempotencyKey: `branch.delete.requested:${operationId}` },
              ),
            );

            // ─── B4.3 idempotent existence check ────────────────────────────
            // Query branch existence OUTSIDE the retry boundary so we don't
            // re-fire git branch -D on a retry. If already absent, record
            // executed { deletedLocally: false, deletedRemote: false } — that
            // is an idempotent success, NOT a failure.
            const existsLocally = await localBranchExists(branch, options);
            const existsRemote = await remoteBranchExists(branch, 'origin', options);
            let deletedLocally = false;
            let deletedRemote = false;

            if (existsLocally) {
              try {
                await runCommand('git', ['branch', '-D', branch], options);
                deletedLocally = true;
              } catch (err) {
                // Idempotent miss only if the branch is now absent
                // (raced with another deleter). Otherwise surface — a
                // failed `git branch -D` with the branch still present is
                // a real error (working tree conflict, refs lock, etc.).
                const stillExists = await localBranchExists(branch, options);
                if (stillExists) {
                  throw err;
                }
              }
            }

            if (existsRemote) {
              try {
                await runCommand('git', ['push', 'origin', '--delete', branch], options);
                deletedRemote = true;
              } catch (err) {
                // Same logic: only swallow when the remote ref is gone.
                // Transport/auth failures must propagate so callers do
                // not record a phantom successful deletion.
                const stillExists = await remoteBranchExists(branch, 'origin', options);
                if (stillExists) {
                  throw err;
                }
              }
            }

            // Phase C: emit branch.delete.executed with the actual outcome.
            // idempotencyKey scoped to operationId so a transient append
            // failure followed by retry across a process restart cannot
            // double-record the executed event.
            //
            // Wrapped in withStateRetry so a transient OCC / storage-busy
            // signal on the append does not leak as an unhandled exception
            // after the git side effect has already run. The
            // idempotencyKey above guarantees the retry is a no-op once
            // the executed event lands. (Twin of Sentry #14059285/0.)
            await withStateRetry(() =>
              eventStore.append(
                featureId,
                {
                  type: 'branch.delete.executed',
                  data: { operationId, branch, deletedLocally, deletedRemote },
                },
                { idempotencyKey: `branch.delete.executed:${operationId}` },
              ),
            );
          } else {
            // Legacy path (no event store wired) — preserve existing behavior
            // Delete local branch (ignore failure if doesn't exist)
            try {
              await runCommand('git', ['branch', '-D', branch], options);
            } catch {
              // Ignore local delete failure
            }
            // Delete remote branch (ignore failure if doesn't exist)
            try {
              await runCommand('git', ['push', 'origin', '--delete', branch], options);
            } catch {
              // Ignore remote delete failure
            }
          }
        }
        return {
          actionId: 'delegate:delete-feature-branches',
          status: 'executed',
          message: `Deleted ${branches.length} feature branch(es)`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          actionId: 'delegate:delete-feature-branches',
          status: 'failed',
          message: `Failed to delete feature branches: ${msg}`,
        };
      }
    },
  };
}

// ─── Action Registry ─────────────────────────────────────────────────────────

function getCompensationActions(): readonly CompensationAction[] {
  return [
    createClosePrAction(),
    createDeleteIntegrationBranchAction(),
    createCleanupWorktreesAction(),
    createDeleteFeatureBranchesAction(),
  ];
}

// ─── Executor ────────────────────────────────────────────────────────────────

function getPhasesInReverseOrder(currentPhase: string): string[] {
  const idx = PHASE_ORDER.indexOf(currentPhase);
  if (idx === -1) {
    // If phase not in order, include all phases in reverse
    return [...PHASE_ORDER].reverse();
  }
  // Include current phase and all phases before it, in reverse
  return PHASE_ORDER.slice(0, idx + 1).reverse();
}

export async function executeCompensation(
  state: Record<string, unknown>,
  currentPhase: string,
  events: readonly Event[],
  eventSequence: number,
  options: CompensationOptions,
): Promise<CompensationResult> {
  // Fail-fast on partially-wired event-store config. Both destructive
  // actions (delete-feature-branches, cleanup-worktrees) gate the
  // two-event split on `options.eventStore && options.featureId`. If a
  // caller wires `eventStore` but forgets `featureId`, compensation
  // would silently degrade to the legacy path — git side effects still
  // run, but no `*.requested` / `*.executed` audit trail lands. Surface
  // the misconfiguration at the boundary instead of producing a
  // deceptively-successful result. (CodeRabbit review #4278133032 on
  // PR #1344.)
  if (options.eventStore !== undefined && options.featureId === undefined) {
    throw new Error(
      'executeCompensation: options.eventStore was provided without ' +
        'options.featureId — two-event-split audit trail cannot land ' +
        'without a stream ID. Either pass both, or omit both to use the ' +
        'legacy non-event-sourced path.',
    );
  }
  const phasesInOrder = getPhasesInReverseOrder(currentPhase);
  const allActions = getCompensationActions();

  // Order actions by reverse phase order
  const orderedActions: CompensationAction[] = [];
  for (const phase of phasesInOrder) {
    for (const action of allActions) {
      if (action.phase === phase) {
        orderedActions.push(action);
      }
    }
  }

  const results: CompensationActionResult[] = [];
  const compensationEvents: Event[] = [];
  let currentSequence = eventSequence;
  let hasFailure = false;
  const completedSet = new Set(options.checkpoint?.completedActions ?? []);

  for (const action of orderedActions) {
    let result: CompensationActionResult;

    // Skip already-completed actions from a previous checkpoint
    if (completedSet.has(action.id)) {
      result = { actionId: action.id, status: 'skipped', message: 'Already completed (checkpoint)' };
    } else {
      result = await action.execute(state, options);

      if (result.status === 'failed') {
        hasFailure = true;
      }

      // Track successfully completed actions for the checkpoint
      if (result.status === 'executed' || result.status === 'skipped') {
        completedSet.add(action.id);
      }
    }

    results.push(result);

    // Log a compensation event for each action
    const { eventSequence: nextSeq, event } = appendEvent(
      [...events, ...compensationEvents],
      currentSequence,
      'compensation',
      `compensation:${action.id}`,
      {
        metadata: {
          actionId: result.actionId,
          status: result.status,
          message: result.message,
        },
      },
    );

    compensationEvents.push(event);
    currentSequence = nextSeq;
  }

  return {
    actions: results,
    events: compensationEvents,
    success: !hasFailure,
    ...(hasFailure && { errorCode: ErrorCode.COMPENSATION_PARTIAL }),
    checkpoint: hasFailure ? { completedActions: [...completedSet] } : null,
  };
}
