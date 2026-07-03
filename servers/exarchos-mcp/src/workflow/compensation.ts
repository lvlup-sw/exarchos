import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendEvent } from './events.js';
import { ErrorCode } from './schemas.js';
import { withStateRetry } from './state-retry.js';
import type { Event } from './types.js';
import type { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
// WLM unification (DR-3): compensation-triggered worktree teardown appends to the
// SINGLETON `worktrees` stream — the SAME stream + reducer the WorktreeManager
// owns — so a compensation removal genuinely reaches the `worktrees@v1` view
// instead of being stranded on the `featureId` stream (the DIM-1 single-source
// violation). `withIndexLockRetry` (DR-1) wraps this call site's git remove.
// `defaultGitRunner` / `GitRunner` are the SAME real-git probe seam the
// WorktreeManager uses for its INV-14 dirty check — reused here so the
// teardown's dirty-guard is byte-for-byte the ladder's, not a re-invention.
import {
  WORKTREES_STREAM,
  defaultGitRunner,
  type GitRunner,
} from '../orchestrate/worktree/manager.js';
import {
  withIndexLockRetry,
  type IndexLockRetryOptions,
} from '../orchestrate/worktree/git-retry.js';
import {
  canonicalWorktreeId,
  defaultRealpath,
  type RealpathResolver,
} from '../orchestrate/worktree/pure/path-containment.js';
import {
  createWorktreesReducer,
  type WorktreesProjection,
} from '../orchestrate/worktree/projections/worktrees.js';

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

// ─── INV-14 dirty-guard (DR-3) ───────────────────────────────────────────────

/**
 * True when the worktree at `worktreePath` carries uncommitted work.
 *
 * `git status --porcelain --untracked-files=all` non-empty ⇒ dirty — the SAME
 * **untracked-aware** probe {@link WorktreeManager}'s `isDirty` uses, so an
 * untracked-only worktree (a brand-new file the author never `git add`ed) is
 * correctly seen as dirty and is preserved, not force-removed.
 *
 * **Fail-CLOSED.** When the probe cannot prove the tree clean — a non-zero git
 * status on a worktree that IS present on disk (a locked index, a transient git
 * error, a broken-but-present repo) — this returns `true` (treat as dirty, skip).
 * Reading an unverifiable probe as "clean" would let the teardown `--force`-remove
 * and silently destroy uncommitted work (the Claude Code #55724 data-loss mode).
 * Mirrors the manager's backing-present fail-closed stance. Callers MUST gate this
 * on the worktree actually existing on disk — an ABSENT path is an idempotent
 * no-op for the removal, not a dirty skip.
 */
function worktreeHasUncommittedChanges(
  worktreePath: string,
  gitRunner: GitRunner,
): boolean {
  const { status, stdout } = gitRunner.run(
    ['status', '--porcelain', '--untracked-files=all'],
    worktreePath,
  );
  if (status !== 0) return true; // cannot prove clean ⇒ preserve (fail-closed)
  return stdout.trim().length > 0;
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

/**
 * Scan ONE stream for a `worktree.remove.requested` matching `worktreePath` with
 * no paired `worktree.remove.executed` (operationId-correlated) — the crashed
 * removal whose operationId must be reused. Returns the most recent unmatched
 * operationId, or `undefined` when none is orphaned on this stream.
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
    const data = requested[i].data as unknown as WorktreeRemoveRequestedData;
    if (executedOps.has(data.operationId)) continue;
    if (data.worktreePath === worktreePath) return data.operationId;
  }
  return undefined;
}

/**
 * Recover the operationId of a crashed worktree removal so the resumed removal
 * completes the ORIGINAL 1:1 audit pair instead of minting a second one.
 *
 * Scans the UNIFIED singleton `worktrees` stream first (DR-3 — the post-unification
 * home of the remove pair). Falls back to the LEGACY `featureId` stream so a
 * compensation that crashed PRE-unification — with its `worktree.remove.requested`
 * stranded on the old `featureId` stream and never paired — still resumes under
 * that original operationId. The resumed `worktree.remove.executed` now lands on
 * the `worktrees` stream (per-stream idempotency keeps the re-emit isolated), so
 * the crash is healed across the deploy boundary rather than double-recorded.
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
 * Fold the singleton `worktrees` stream through `worktrees@v1` into its live
 * {@link WorktreesProjection}. Used by the compensation adopt-gate to decide
 * whether a to-be-removed worktree already has a governed entry. A pure read —
 * appends nothing — over the same reducer the {@link WorktreeManager} uses.
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
 * Tear down ONE worktree through the unified `worktrees`-stream removal (DR-3).
 *
 *   0. **Adopt-gate** (mirrors prune step-0). When the worktree has NO entry on
 *      the `worktrees` stream — the manager never governed it — emit
 *      `worktree.adopted` FIRST (canonical `worktreeId` derived the SAME way the
 *      manager does, via {@link canonicalWorktreeId}). Without this the terminal
 *      remove would drop nothing and the `worktrees@v1` view would keep showing a
 *      live entry for a worktree that was actually removed (a vacuous pass).
 *   A. **Durable intent.** `worktree.remove.requested` on the `worktrees` stream,
 *      reusing a crashed removal's operationId (see
 *      {@link recoverWorktreeRemoveOperationId}) so the audit pair stays 1:1.
 *   B. **Idempotent side-effect OUTSIDE the retry boundary.** `git worktree
 *      remove` only when still registered, wrapped in {@link withIndexLockRetry}
 *      (DR-1) so a transient burst `index.lock` contention is retried without
 *      re-emitting the request; an already-absent worktree records `removed:false`
 *      (idempotent success), and a remove that fails while STILL registered
 *      surfaces as a real error.
 *   C. **Record the outcome.** `worktree.remove.executed` (idempotency keyed on
 *      operationId, stamped with the canonical `worktreeId`) — the `worktrees@v1`
 *      reducer drops the entry on it.
 */
async function unifyWorktreeRemove(
  worktreePath: string,
  eventStore: EventStore,
  featureId: string,
  options: CompensationOptions,
): Promise<void> {
  const realpath = options.realpath ?? defaultRealpath;
  // Canonical key derived the SAME way the manager keys its entries so the
  // adopt / remove pair folds onto (and drops) the SAME `worktrees@v1` entry.
  const worktreeId = canonicalWorktreeId(worktreePath, realpath);

  // ── Step 0: adopt-gate — an untracked worktree needs a governed entry BEFORE
  // the remove pair, or the terminal drop is vacuous (no-op) and the view lies. ──
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

  // ── Phase A: durable intent on the UNIFIED stream, reusing a crashed op. ──
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

  // ── Phase B: idempotent side-effect OUTSIDE the retry boundary. ──
  // Query registration OUTSIDE the withStateRetry above so a retried append does
  // not re-fire the remove. The remove itself is wrapped in withIndexLockRetry
  // so a transient git `index.lock` contention (burst teardown) is absorbed.
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
      // Only downgrade to an idempotent miss if the worktree is now actually
      // gone (raced away between precheck and command). Still registered ⇒ the
      // failure is real (locked, missing repo, lock-contention exhausted) and
      // must surface rather than be masked as `removed: false`.
      const stillRegistered = await worktreeIsRegistered(worktreePath, options);
      if (stillRegistered) {
        throw err;
      }
    }
  }

  // ── Phase C: record the actual outcome (drops the entry on the reducer). ──
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

/**
 * Scannable reason a compensation worktree teardown PRESERVED a worktree rather
 * than removing it. A closed token set — a consumer / telemetry sink branches on
 * it without parsing prose — mirroring the launcher teardown's
 * `TeardownRecoveryError` discriminator shape.
 */
export type WorktreeTeardownSkipReason =
  /**
   * The worktree had uncommitted work (INCLUDING untracked-only changes) — it is
   * preserved, never `--force`-removed (INV-14; recovery never `git reset --hard`s).
   */
  | 'dirty-worktree-preserved';

/** A worktree the compensation teardown deliberately preserved rather than removed. */
export interface SkippedWorktreeTeardown {
  readonly worktreePath: string;
  readonly reason: WorktreeTeardownSkipReason;
}

export interface CompensationOptions {
  readonly dryRun: boolean;
  readonly stateDir?: string;
  readonly checkpoint?: CompensationCheckpoint;
  /** External event store for emitting two-event-split audit events (B4/B5). */
  readonly eventStore?: EventStore;
  /** Feature ID (stream ID) for event store appends. Required when eventStore is set. */
  readonly featureId?: string;
  /**
   * Injectable symlink resolver for deriving the canonical `worktreeId` the
   * unified `worktrees`-stream removal keys under (DR-3). Defaults to
   * {@link defaultRealpath}; tests inject a pure map so the fold is
   * filesystem-free and deterministic — mirroring the manager's seam.
   */
  readonly realpath?: RealpathResolver;
  /**
   * Injectable git `index.lock` retry seams (sleep / jitter / bounds) for the
   * compensation `git worktree remove` call site (DR-1). Defaults leave the real
   * backoff timers in place; tests inject a no-op sleep so the retry sequence is
   * asserted without a wall-clock wait.
   */
  readonly indexLockRetry?: IndexLockRetryOptions;
  /**
   * Injectable git probe for the INV-14 teardown dirty-guard (`git status
   * --porcelain --untracked-files=all`). Defaults to {@link defaultGitRunner} —
   * the SAME real-git spawn the WorktreeManager probes with — so a worktree with
   * uncommitted work (including untracked-only) is preserved, not force-removed.
   * Distinct from the `execFile`-based side-effect helpers so a test can drive the
   * dirty check against a REAL worktree while stubbing the removal.
   */
  readonly gitRunner?: GitRunner;
}

export interface CompensationActionResult {
  readonly actionId: string;
  readonly status: 'executed' | 'skipped' | 'failed' | 'dry-run';
  readonly message: string;
  /**
   * Worktrees the teardown deliberately PRESERVED (dirty-guard) instead of
   * removing — each with a scannable {@link WorktreeTeardownSkipReason} so
   * callers / telemetry can see WHY a worktree survived compensation. Absent when
   * nothing was preserved.
   */
  readonly skippedWorktrees?: readonly SkippedWorktreeTeardown[];
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

      const gitRunner = options.gitRunner ?? defaultGitRunner;
      const skippedWorktrees: SkippedWorktreeTeardown[] = [];
      let removed = 0;

      try {
        for (const worktree of Object.values(worktrees)) {
          const worktreePath = worktree.path as string | undefined;
          if (!worktreePath) continue;

          // ─── INV-14 dirty-guard (DR-3): NEVER --force-remove uncommitted work ──
          // A worktree that is present on disk AND carries uncommitted changes —
          // INCLUDING untracked-only changes — is skipped-and-surfaced with a
          // scannable reason, never destroyed. Recovery NEVER `git reset --hard`s.
          // An ABSENT path is deliberately NOT probed here: the removal below
          // already treats it as an idempotent no-op (`removed:false`), and
          // fail-closing on the git error a missing directory produces would
          // wrongly strand it as "dirty" forever.
          if (
            existsSync(worktreePath) &&
            worktreeHasUncommittedChanges(worktreePath, gitRunner)
          ) {
            skippedWorktrees.push({ worktreePath, reason: 'dirty-worktree-preserved' });
            continue;
          }

          removed += 1;
          if (options.eventStore && options.featureId) {
            // ─── DR-3: unified `worktrees`-stream removal ────────────────────
            // Adopt-then-remove on the SINGLETON stream (retry-wrapped remove),
            // so a compensation teardown genuinely reaches the `worktrees@v1`
            // view instead of stranding the pair on the `featureId` stream.
            await unifyWorktreeRemove(
              worktreePath,
              options.eventStore,
              options.featureId,
              options,
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
