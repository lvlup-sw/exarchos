import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendEvent } from './events.js';
import { ErrorCode } from './schemas.js';
import { withStateRetry } from './state-retry.js';
import type { Event } from './types.js';
import type { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';
import {
  CancelCompensationCompletedData,
  CancelCompensationFailedData,
} from '../events/schemas.js';
import {
  appendFencedCancelEvent,
  decideCompensationAction,
  foldCancelSaga,
  type CancelRetryPolicy,
} from './cancel-process-manager.js';
import {
  WORKTREES_STREAM,
  defaultGitRunner,
  type GitRunner,
} from '../verbs/worktree/manager.js';
import {
  withIndexLockRetry,
  type IndexLockRetryOptions,
} from '../verbs/worktree/git-retry.js';
import {
  canonicalWorktreeId,
  defaultRealpath,
  type RealpathResolver,
} from '../verbs/worktree/pure/path-containment.js';
import {
  createWorktreesReducer,
  type WorktreesProjection,
} from '../verbs/worktree/projections/worktrees.js';

const execFileAsync = promisify(execFileCb);
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * The error shape of Node `execFile`. `killed` is true after a timeout, and `code` is the exit code.
 * The helpers use it to tell an absent resource from a broken environment. A broken environment must fail.
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
 * True when the exec error shows a broken environment: a timeout, a signal, no git repository, or a remote or permission error.
 * The existence helpers never read such an error as "already absent".
 */
function isOperationalFailure(err: ExecError): boolean {
  if (err.killed === true) return true;
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
 * Runs a command and returns its stdout as a string. It accepts a string or a Buffer result.
 * It rethrows an operational failure, such as a timeout, no repository or an auth error.
 * Any other failure returns an empty string, which the git helpers read as "no match".
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
    const raw = result as unknown as { stdout: string | Buffer } | string;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object' && raw !== null && 'stdout' in raw) {
      const stdout = (raw as { stdout: string | Buffer }).stdout;
      return typeof stdout === 'string' ? stdout : stdout.toString('utf-8');
    }
    return '';
  } catch (err: unknown) {
    if (isExecError(err) && isOperationalFailure(err)) {
      throw err;
    }
    return '';
  }
}

/**
 * True when the branch exists in the local repository, by `git rev-parse --verify`.
 * A non-zero exit means absent. An operational failure propagates, so a broken environment does not read as "absent".
 */
async function localBranchExists(branch: string, options: CompensationOptions): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--verify', branch], options);
    return true;
  } catch (err: unknown) {
    if (isExecError(err) && isOperationalFailure(err)) {
      throw err;
    }
    return false;
  }
}

/**
 * True when the branch exists on the remote, by `git ls-remote --heads`. Empty stdout means absent.
 * An operational failure propagates from {@link runCommandCaptureStdout}.
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
 * True when a line of `git worktree list` starts with the worktree path. An operational failure propagates.
 * The path must match a whole token, so `/tmp/wt-old` does not match `/tmp/wt`.
 */
async function worktreeIsRegistered(
  worktreePath: string,
  options: CompensationOptions,
): Promise<boolean> {
  const stdout = await runCommandCaptureStdout('git', ['worktree', 'list'], options);
  return stdout.split('\n').some((line) => {
    if (!line.startsWith(worktreePath)) return false;
    const next = line.charAt(worktreePath.length);
    return next === '' || next === ' ' || next === '\t';
  });
}

/**
 * True when `git status --porcelain --untracked-files=all` shows changes, so untracked-only files count as dirty.
 * It fails closed: a non-zero status counts as dirty, so the teardown never force-removes unverified work.
 * Callers must call it only for a worktree that exists on disk. An absent path is a no-op for the removal.
 */
function worktreeHasUncommittedChanges(
  worktreePath: string,
  gitRunner: GitRunner,
): boolean {
  const { status, stdout } = gitRunner.run(
    ['status', '--porcelain', '--untracked-files=all'],
    worktreePath,
  );
  if (status !== 0) return true;
  return stdout.trim().length > 0;
}

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

/**
 * Returns the operationId of the latest `worktree.remove.requested` for `worktreePath` on one stream with no paired `worktree.remove.executed`.
 * It returns `undefined` when the stream has no such request.
 */
async function findOrphanedWorktreeRemoveOnStream(
  eventStore: EventStore,
  streamId: string,
  worktreePath: string,
): Promise<string | undefined> {
  const requested = await eventStore.query(streamId, {
    type: 'worktree.remove.requested',
  });
  const executed = await eventStore.query(streamId, {
    type: 'worktree.remove.executed',
  });
  const executedOps = new Set(
    executed.map((e) => (e.data as unknown as WorktreeRemoveExecutedData).operationId),
  );
  for (let i = requested.length - 1; i >= 0; i -= 1) {
    const entry = requested[i];
    if (entry === undefined) continue;
    const data = entry.data as unknown as WorktreeRemoveRequestedData;
    if (executedOps.has(data.operationId)) continue;
    if (data.worktreePath === worktreePath) return data.operationId;
  }
  return undefined;
}

/**
 * Recovers the operationId of a crashed worktree removal.
 * A crash between `*.requested` and `*.executed` leaves an orphan request. A retry reuses its operationId, so the audit pair stays one to one.
 * It reads the `worktrees` stream first. If that stream has no orphan, it reads the `featureId` stream, which can hold a request from before the unified stream.
 */
async function recoverWorktreeRemoveOperationId(
  eventStore: EventStore,
  featureId: string,
  worktreePath: string,
): Promise<string | undefined> {
  const onWorktreesStream = await findOrphanedWorktreeRemoveOnStream(
    eventStore,
    WORKTREES_STREAM,
    worktreePath,
  );
  if (onWorktreesStream !== undefined) return onWorktreesStream;
  return findOrphanedWorktreeRemoveOnStream(eventStore, featureId, worktreePath);
}

/**
 * Folds the `worktrees` stream through the `worktrees@v1` reducer into a {@link WorktreesProjection}. It appends nothing.
 * The adopt step uses it to find out if a worktree already has an entry.
 */
async function loadWorktreesProjection(
  eventStore: EventStore,
  realpath: RealpathResolver,
): Promise<WorktreesProjection> {
  const reducer = createWorktreesReducer(realpath);
  const events = (await eventStore.query(WORKTREES_STREAM)) as readonly WorkflowEvent[];
  return events.reduce((acc, event) => reducer.apply(acc, event), reducer.initial);
}

/**
 * Removes one worktree through the `worktrees` stream, in four steps:
 *   1. If the stream has no entry for the worktree, it appends `worktree.adopted`. Else the remove drops nothing and the view keeps a stale entry.
 *   2. It appends `worktree.remove.requested` and reuses the operationId of a crashed removal.
 *   3. If the worktree is registered, it runs `git worktree remove --force` in {@link withIndexLockRetry}, outside the append retry.
 *   4. It appends `worktree.remove.executed` with the outcome, and the reducer drops the entry.
 * A remove that fails while the worktree is still registered propagates. {@link canonicalWorktreeId} gives the `worktreeId`.
 */
async function unifyWorktreeRemove(
  worktreePath: string,
  eventStore: EventStore,
  featureId: string,
  options: CompensationOptions,
): Promise<void> {
  const realpath = options.realpath ?? defaultRealpath;
  const worktreeId = canonicalWorktreeId(worktreePath, realpath);

  const projection = await loadWorktreesProjection(eventStore, realpath);
  if (projection.worktrees[worktreeId] === undefined) {
    await withStateRetry(() =>
      eventStore.append(
        WORKTREES_STREAM,
        {
          type: 'worktree.adopted',
          data: {
            worktreeId,
            path: worktreePath,
            featureId,
            ownerPid: null,
            ownerStartedAt: null,
            operationId: randomUUID(),
          },
        },
        { idempotencyKey: `worktree.adopted:${worktreeId}` },
      ),
    );
  }

  const operationId =
    (await recoverWorktreeRemoveOperationId(eventStore, featureId, worktreePath)) ??
    randomUUID();
  await withStateRetry(() =>
    eventStore.append(
      WORKTREES_STREAM,
      {
        type: 'worktree.remove.requested',
        data: { operationId, worktreePath, worktreeId },
      },
      { idempotencyKey: `worktree.remove.requested:${operationId}` },
    ),
  );

  const isRegistered = await worktreeIsRegistered(worktreePath, options);
  let removed = false;
  if (isRegistered) {
    try {
      await withIndexLockRetry(
        () => runCommand('git', ['worktree', 'remove', worktreePath, '--force'], options),
        options.indexLockRetry,
      );
      removed = true;
    } catch (err) {
      const stillRegistered = await worktreeIsRegistered(worktreePath, options);
      if (stillRegistered) {
        throw err;
      }
    }
  }

  await withStateRetry(() =>
    eventStore.append(
      WORKTREES_STREAM,
      {
        type: 'worktree.remove.executed',
        data: { operationId, worktreePath, worktreeId, removed },
      },
      { idempotencyKey: `worktree.remove.executed:${operationId}` },
    ),
  );
}

/** Recovers the operationId of a crashed branch delete from the `featureId` stream, like {@link recoverWorktreeRemoveOperationId}. */
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
    const entry = requested[i];
    if (entry === undefined) continue;
    const data = entry.data as unknown as BranchDeleteRequestedData;
    if (executedOps.has(data.operationId)) continue;
    if (data.branch === branch) return data.operationId;
  }
  return undefined;
}

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

/**
 * Why the compensation teardown kept a worktree. Consumers branch on the closed token and do not parse prose.
 * `dirty-worktree-preserved` means the worktree had uncommitted work, including untracked-only files.
 * The teardown does not force-remove such a worktree.
 */
export type WorktreeTeardownSkipReason =
  | 'dirty-worktree-preserved';

/** A worktree the compensation teardown deliberately preserved rather than removed. */
export interface SkippedWorktreeTeardown {
  readonly worktreePath: string;
  readonly reason: WorktreeTeardownSkipReason;
}

export interface CompensationOptions {
  readonly dryRun: boolean;
  readonly stateDir?: string;
  readonly checkpoint?: CompensationCheckpoint | undefined;
  /** The event store for the requested and executed audit events. */
  readonly eventStore?: EventStore;
  /** Feature ID (stream ID) for event store appends. Required when eventStore is set. */
  readonly featureId?: string;
  /** The symlink resolver for the canonical `worktreeId`. The default is {@link defaultRealpath}. */
  readonly realpath?: RealpathResolver;
  /** The `index.lock` retry settings for `git worktree remove`. Tests inject a no-op sleep. */
  readonly indexLockRetry?: IndexLockRetryOptions;
  /**
   * The git probe for the teardown dirty check. The default is {@link defaultGitRunner}.
   * It is separate from the `execFile` helpers, so a test can probe a real worktree and stub the removal.
   */
  readonly gitRunner?: GitRunner;
  /**
   * Turns on the event-sourced cancellation process manager. Without it, compensation uses checkpoints.
   * `writerEpoch` and `instanceId` are the fencing token. Each process event append checks the epoch, so a stale instance cannot write.
   * `maxAttempts` limits the attempts of each action before manual intervention.
   */
  readonly cancelProcess?: {
    readonly cancelId: string;
    readonly phaseAttemptId: string;
    readonly writerEpoch: number;
    readonly instanceId: string;
    readonly maxAttempts?: number;
  };
}

/**
 * {@link CompensationOptions} with `eventStore`, `featureId` and `cancelProcess` all present.
 * `executeCompensation` checks the three together once, so the helpers read them without a null check.
 */
export interface ProcessManagedCompensationOptions extends CompensationOptions {
  readonly eventStore: EventStore;
  readonly featureId: string;
  readonly cancelProcess: {
    readonly cancelId: string;
    readonly phaseAttemptId: string;
    readonly writerEpoch: number;
    readonly instanceId: string;
    readonly maxAttempts?: number;
  };
}

export interface CompensationActionResult {
  readonly actionId: string;
  readonly status: 'executed' | 'skipped' | 'failed' | 'dry-run';
  readonly message: string;
  /** The worktrees that the dirty check kept, each with a reason. Absent when the teardown kept none. */
  readonly skippedWorktrees?: readonly SkippedWorktreeTeardown[];
}

export interface CompensationResult {
  readonly actions: readonly CompensationActionResult[];
  readonly events: readonly Event[];
  readonly success: boolean;
  readonly errorCode?: string;
  readonly checkpoint: CompensationCheckpoint | null;
  readonly durableOutcomes?: {
    readonly completedActionIds: readonly string[];
    readonly outcomeSequences: readonly number[];
  };
}

/**
 * The default attempt budget of the cancellation process manager.
 * After this many attempts, the saga escalates the action to `manual-intervention-required`.
 */
export const CANCEL_MAX_ATTEMPTS = 3;

/** The phase order. Compensation runs the phases in reverse. */
const PHASE_ORDER: readonly string[] = [
  'plan',
  'delegate',
  'review',
  'synthesize',
];

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
        const state = (
          await runCommandCaptureStdout(
            'gh',
            ['pr', 'view', prUrl, '--json', 'state', '--jq', '.state'],
            options,
          )
        ).trim().toUpperCase();
        if (state === 'CLOSED' || state === 'MERGED') {
          return {
            actionId: 'synthesize:close-pr',
            status: 'skipped',
            message: `PR already closed: ${prUrl}`,
          };
        }
        try {
          await runCommand(
            'gh',
            ['pr', 'close', prUrl, '--comment', 'Cancelled via compensation'],
            options,
          );
        } catch (error) {
          const after = (
            await runCommandCaptureStdout(
              'gh',
              ['pr', 'view', prUrl, '--json', 'state', '--jq', '.state'],
              options,
            )
          ).trim().toUpperCase();
          if (after !== 'CLOSED' && after !== 'MERGED') throw error;
        }
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
        const existsLocally = await localBranchExists(branch, options);
        const existsRemote = await remoteBranchExists(branch, 'origin', options);
        if (existsLocally) {
          try {
            await runCommand('git', ['branch', '-D', branch], options);
          } catch (error) {
            if (await localBranchExists(branch, options)) throw error;
          }
        }
        if (existsRemote) {
          try {
            await runCommand('git', ['push', 'origin', '--delete', branch], options);
          } catch (error) {
            if (await remoteBranchExists(branch, 'origin', options)) throw error;
          }
        }
        return {
          actionId: 'delegate:delete-integration-branch',
          status: existsLocally || existsRemote ? 'executed' : 'skipped',
          message:
            existsLocally || existsRemote
              ? `Deleted integration branch: ${branch}`
              : `Integration branch already absent: ${branch}`,
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

/**
 * Removes the worktrees in `state.worktrees`.
 * It keeps a worktree that exists on disk and has uncommitted work, and reports it as `dirty-worktree-preserved`.
 * It does not probe an absent path, because the removal treats that path as a no-op.
 * With an event store, it removes through {@link unifyWorktreeRemove}. Without one, it ignores a failed `git worktree remove`.
 * The count excludes a worktree whose removal throws.
 */
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

      const gitRunner = options.gitRunner ?? defaultGitRunner;
      const skippedWorktrees: SkippedWorktreeTeardown[] = [];
      let removed = 0;

      try {
        for (const worktree of Object.values(worktrees)) {
          const worktreePath = worktree.path as string | undefined;
          if (!worktreePath) continue;

          if (
            existsSync(worktreePath) &&
            worktreeHasUncommittedChanges(worktreePath, gitRunner)
          ) {
            skippedWorktrees.push({ worktreePath, reason: 'dirty-worktree-preserved' });
            continue;
          }

          if (options.eventStore && options.featureId) {
            await unifyWorktreeRemove(
              worktreePath,
              options.eventStore,
              options.featureId,
              options,
            );
          } else {
            try {
              await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], options);
            } catch {
            }
          }
          removed += 1;
        }

        const base = `Cleaned up ${removed} worktree(s)`;
        const message =
          skippedWorktrees.length === 0
            ? base
            : `${base}; preserved ${skippedWorktrees.length} worktree(s) with ` +
              `uncommitted changes (dirty-worktree-preserved): ` +
              skippedWorktrees.map((s) => s.worktreePath).join(', ');

        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'executed',
          message,
          ...(skippedWorktrees.length > 0 && { skippedWorktrees }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'failed',
          message: `Failed to clean up worktrees: ${msg}`,
          ...(skippedWorktrees.length > 0 && { skippedWorktrees }),
        };
      }
    },
  };
}

/**
 * Deletes the task branches, locally and on `origin`.
 * With an event store, it appends `branch.delete.requested`, deletes each branch that exists, and appends `branch.delete.executed`.
 * It reuses the operationId of an orphan request. The git commands run outside the append retry, so a retry does not repeat them.
 *
 * An absent branch is an idempotent success. A failed delete fails the action while the branch still exists.
 * Without an event store, it ignores each failed delete.
 */
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
            const featureId = options.featureId;
            const eventStore = options.eventStore;
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

            const existsLocally = await localBranchExists(branch, options);
            const existsRemote = await remoteBranchExists(branch, 'origin', options);
            let deletedLocally = false;
            let deletedRemote = false;

            if (existsLocally) {
              try {
                await runCommand('git', ['branch', '-D', branch], options);
                deletedLocally = true;
              } catch (err) {
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
                const stillExists = await remoteBranchExists(branch, 'origin', options);
                if (stillExists) {
                  throw err;
                }
              }
            }

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
            try {
              await runCommand('git', ['branch', '-D', branch], options);
            } catch {
            }
            try {
              await runCommand('git', ['push', 'origin', '--delete', branch], options);
            } catch {
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

function getCompensationActions(): readonly CompensationAction[] {
  return [
    createClosePrAction(),
    createDeleteIntegrationBranchAction(),
    createCleanupWorktreesAction(),
    createDeleteFeatureBranchesAction(),
  ];
}

/** Returns the current phase and the phases before it, in reverse. An unknown phase gives all phases in reverse. */
function getPhasesInReverseOrder(currentPhase: string): string[] {
  const idx = PHASE_ORDER.indexOf(currentPhase);
  if (idx === -1) {
    return [...PHASE_ORDER].reverse();
  }
  return PHASE_ORDER.slice(0, idx + 1).reverse();
}

function orderedCompensationActions(currentPhase: string): CompensationAction[] {
    const phasesInOrder = getPhasesInReverseOrder(currentPhase);
    const allActions = getCompensationActions();
    const orderedActions: CompensationAction[] = [];
    for (const phase of phasesInOrder) {
      for (const action of allActions) {
        if (action.phase === phase) orderedActions.push(action);
      }
    }
    return orderedActions;
  }

  function processEventData(
    options: ProcessManagedCompensationOptions,
    actionId: string,
  ): {
    cancelId: string;
    featureId: string;
    phaseAttemptId: string;
    actionId: string;
  } {
    return {
      cancelId: options.cancelProcess.cancelId,
      featureId: options.featureId,
      phaseAttemptId: options.cancelProcess.phaseAttemptId,
      actionId,
    };
  }

  /**
   * Appends one cancellation event through the fenced append.
   * The idempotency key keeps the `cancel:` plus 64-hex shape, and the `operationId` makes a crash-resume idempotent.
   * The append checks `writerEpoch` in its transaction, so a stale instance cannot write.
   */
  async function appendCancellationProcessEvent(
    options: ProcessManagedCompensationOptions,
    type:
      | 'cancel.compensation-requested'
      | 'cancel.compensation-completed'
      | 'cancel.compensation-failed'
      | 'cancel.compensation-retry-scheduled'
      | 'cancel.manual-intervention-required',
    data: Record<string, unknown>,
    suffix: string,
  ): Promise<void> {
    const featureId = options.featureId;
    const key = `cancel:${createHash('sha256')
      .update(`${featureId}\0${options.cancelProcess.cancelId}\0${suffix}`, 'utf8')
      .digest('hex')}`;
    await appendFencedCancelEvent(options.eventStore, {
      featureId,
      cancelId: options.cancelProcess.cancelId,
      writerEpoch: options.cancelProcess.writerEpoch,
      type,
      data,
      idempotencyKey: key,
      operationId: `cancel-op:${options.cancelProcess.cancelId}:${suffix}`,
    });
  }

  function validActionResult(
    value: unknown,
    actionId: string,
  ): value is CompensationActionResult {
    if (typeof value !== 'object' || value === null) return false;
    const result = value as Partial<CompensationActionResult>;
    return (
      result.actionId === actionId
      && (result.status === 'executed'
        || result.status === 'skipped'
        || result.status === 'failed')
      && typeof result.message === 'string'
      && result.message.length > 0
    );
  }

  /**
   * Runs the compensation actions under the cancellation process manager.
   * Each attempt appends the request, runs the action once, and appends the outcome. Attempt-scoped keys make a resumed attempt append nothing new.
   * A malformed durable outcome gives a `malformed-result` failure, and the action does not run.
   *
   * The folded saga decides each step, so a durably completed action does not run again after a restart or takeover.
   * An iteration cap above the attempt budget guards against a decision bug.
   * Success also needs a durable completion event for each action.
   */
  async function executeProcessManagedCompensation(
    state: Record<string, unknown>,
    currentPhase: string,
    options: ProcessManagedCompensationOptions,
  ): Promise<CompensationResult> {
    const eventStore = options.eventStore;
    const featureId = options.featureId;
    const cancelId = options.cancelProcess.cancelId;
    const actions = orderedCompensationActions(currentPhase);
    const results: CompensationActionResult[] = [];
    const policy: CancelRetryPolicy = {
      maxAttempts: options.cancelProcess.maxAttempts ?? CANCEL_MAX_ATTEMPTS,
    };

    const runOneAttempt = async (
      action: CompensationAction,
      attempt: number,
    ): Promise<void> => {
      await appendCancellationProcessEvent(
        options,
        'cancel.compensation-requested',
        {
          eventVersion: '1.0',
          ...processEventData(options, action.id),
          requestedAt: new Date().toISOString(),
        },
        `compensation:${action.id}:attempt${attempt}:requested`,
      );

      let rawResult: unknown;
      try {
        rawResult = await action.execute(state, options);
      } catch (error) {
        rawResult = {
          actionId: action.id,
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (!validActionResult(rawResult, action.id)) {
        await appendCancellationProcessEvent(
          options,
          'cancel.compensation-failed',
          {
            eventVersion: '1.0',
            ...processEventData(options, action.id),
            reason: 'malformed-result',
            message: `Malformed compensation result for ${action.id}`,
            failedAt: new Date().toISOString(),
          },
          `compensation:${action.id}:attempt${attempt}:failed`,
        );
        return;
      }

      if (rawResult.status === 'failed') {
        await appendCancellationProcessEvent(
          options,
          'cancel.compensation-failed',
          {
            eventVersion: '1.0',
            ...processEventData(options, action.id),
            reason: 'effect-failed',
            message: rawResult.message,
            failedAt: new Date().toISOString(),
          },
          `compensation:${action.id}:attempt${attempt}:failed`,
        );
      } else {
        await appendCancellationProcessEvent(
          options,
          'cancel.compensation-completed',
          {
            eventVersion: '1.0',
            ...processEventData(options, action.id),
            status: rawResult.status,
            message: rawResult.message,
            completedAt: new Date().toISOString(),
          },
          `compensation:${action.id}:attempt${attempt}:completed`,
        );
      }
    };

    for (const action of actions) {
      const priorHistory = await eventStore.query(featureId);
      const malformedOutcome = priorHistory.find((event) => {
        const data = event.data as Record<string, unknown> | undefined;
        if (data?.cancelId !== cancelId || data?.actionId !== action.id) return false;
        return (
          (event.type === 'cancel.compensation-completed'
            && !CancelCompensationCompletedData.safeParse(event.data).success)
          || (event.type === 'cancel.compensation-failed'
            && !CancelCompensationFailedData.safeParse(event.data).success)
        );
      });
      if (malformedOutcome !== undefined) {
        const message = `Malformed durable compensation result for ${action.id}`;
        await appendCancellationProcessEvent(
          options,
          'cancel.compensation-failed',
          {
            eventVersion: '1.0',
            ...processEventData(options, action.id),
            reason: 'malformed-result',
            message,
            failedAt: new Date().toISOString(),
          },
          `compensation:${action.id}:malformed:failed`,
        );
        results.push({ actionId: action.id, status: 'failed', message });
        continue;
      }

      const cap = policy.maxAttempts * 2 + 4;
      let terminal: CompensationActionResult | undefined;
      for (let guard = 0; guard < cap && terminal === undefined; guard++) {
        const saga = foldCancelSaga(await eventStore.query(featureId), cancelId);
        const plan = decideCompensationAction(saga, action.id, policy);
        switch (plan.kind) {
          case 'satisfied':
            terminal = {
              actionId: action.id,
              status: 'skipped',
              message: 'Already completed (event replay)',
            };
            break;
          case 'blocked-manual':
            terminal = {
              actionId: action.id,
              status: 'failed',
              message: `Manual intervention required for ${action.id}`,
            };
            break;
          case 'escalate-manual':
            await appendCancellationProcessEvent(
              options,
              'cancel.manual-intervention-required',
              {
                eventVersion: '1.0',
                ...processEventData(options, action.id),
                epoch: options.cancelProcess.writerEpoch,
                attempts: plan.attempts,
                reason: plan.reason,
                message: `Compensation ${action.id} exhausted ${plan.attempts} attempt(s)`,
                requiredAt: new Date().toISOString(),
              },
              `compensation:${action.id}:manual`,
            );
            break;
          case 'retry':
            await appendCancellationProcessEvent(
              options,
              'cancel.compensation-retry-scheduled',
              {
                eventVersion: '1.0',
                ...processEventData(options, action.id),
                epoch: options.cancelProcess.writerEpoch,
                attempt: plan.failedAttempt,
                maxAttempts: policy.maxAttempts,
                reason: plan.reason,
                message: plan.message,
                scheduledAt: new Date().toISOString(),
              },
              `compensation:${action.id}:attempt${plan.failedAttempt}:retry`,
            );
            await runOneAttempt(action, plan.nextAttempt);
            break;
          case 'execute':
            await runOneAttempt(action, plan.attempt);
            break;
        }
      }
      results.push(
        terminal ?? {
          actionId: action.id,
          status: 'failed',
          message: `Compensation did not converge for ${action.id}`,
        },
      );
    }

    const replay = await eventStore.query(featureId);
    const completedActionIds: string[] = [];
    const outcomeSequences: number[] = [];
    let incomplete = false;
    for (const action of actions) {
      const completed = replay.find((event) => {
        if (event.type !== 'cancel.compensation-completed') return false;
        const parsed = CancelCompensationCompletedData.safeParse(event.data);
        return parsed.success
          && parsed.data.cancelId === cancelId
          && parsed.data.actionId === action.id;
      });
      if (completed !== undefined) {
        completedActionIds.push(action.id);
        outcomeSequences.push(completed.sequence);
      } else {
        incomplete = true;
      }
    }

    const hasFailure =
      incomplete || results.some((result) => result.status === 'failed');
    return {
      actions: results,
      events: [],
      success: !hasFailure,
      ...(hasFailure ? { errorCode: ErrorCode.COMPENSATION_PARTIAL } : {}),
      checkpoint: null,
      durableOutcomes: { completedActionIds, outcomeSequences },
    };
}

/**
 * Runs the compensation actions for `currentPhase` and the phases before it, in reverse phase order.
 * With `cancelProcess`, it runs the process-managed path. That path needs `eventStore` and `featureId` and cannot be a dry run.
 * Without it, it skips the actions in the checkpoint and logs one `compensation` event for each action.
 * @throws {Error} When `eventStore` is set without `featureId`. Else git effects run without an audit trail.
 */
export async function executeCompensation(
  state: Record<string, unknown>,
  currentPhase: string,
  events: readonly Event[],
  eventSequence: number,
  options: CompensationOptions,
): Promise<CompensationResult> {
  if (options.eventStore !== undefined && options.featureId === undefined) {
    throw new Error(
      'executeCompensation: options.eventStore was provided without ' +
        'options.featureId — two-event-split audit trail cannot land ' +
        'without a stream ID. Either pass both, or omit both to use the ' +
        'legacy non-event-sourced path.',
    );
  }
  if (options.cancelProcess !== undefined) {
    const { eventStore, featureId, cancelProcess } = options;
    if (eventStore === undefined || featureId === undefined) {
      throw new Error(
        'executeCompensation: cancelProcess requires eventStore and featureId',
      );
    }
    if (options.dryRun) {
      throw new Error('executeCompensation: cancelProcess cannot run in dry-run mode');
    }
    return executeProcessManagedCompensation(state, currentPhase, {
      ...options,
      eventStore,
      featureId,
      cancelProcess,
    });
  }

  const orderedActions = orderedCompensationActions(currentPhase);

  const results: CompensationActionResult[] = [];
  const compensationEvents: Event[] = [];
  let currentSequence = eventSequence;
  let hasFailure = false;
  const completedSet = new Set(options.checkpoint?.completedActions ?? []);

  for (const action of orderedActions) {
    let result: CompensationActionResult;

    if (completedSet.has(action.id)) {
      result = { actionId: action.id, status: 'skipped', message: 'Already completed (checkpoint)' };
    } else {
      result = await action.execute(state, options);

      if (result.status === 'failed') {
        hasFailure = true;
      }

      if (result.status === 'executed' || result.status === 'skipped') {
        completedSet.add(action.id);
      }
    }

    results.push(result);

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
