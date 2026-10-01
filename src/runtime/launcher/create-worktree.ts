/**
 * Creates the top-level, task-less worktree of the harness launcher. It is a different kind from a delegation task worktree.
 * It is tracked through `worktree.reserved` and the launch liveness pair, not the task-scoped `worktree.created` terminal.
 * That terminal requires a `taskId`, and a task-less worktree has none.
 * The steps run in this order, and each append goes to the `worktrees` stream:
 *   1. The topology guard ({@link deriveWorktreePath} and {@link guardWorktreeContainment}) refuses a nested or escaping target.
 *   2. {@link WorktreeManager.reserve} emits `worktree.reserved`, so the worktree is tracked before it exists on disk. A concurrent adopt or prune thus cannot race it.
 *   3. `worktree.create.requested` records the durable intent.
 *   4. `git worktree add` runs through the {@link GitRunner} seam.
 *   5. `worktree.create.executed` records the terminal.
 *
 * The `worktree.create.*` pair is creation audit, correlated by `operationId` for crash recovery. The `worktrees@v1` reducer ignores it.
 * After a crash, {@link recoverPendingCreations} resumes each intent that has no terminal.
 */

import { randomUUID } from 'node:crypto';
import type { EventStore } from '../../events/store.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { withStateRetry } from '../../workflow/state-retry.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  defaultGitRunner,
  parseWorktreeListPorcelain,
  type GitRunner,
  type ReservationOwner,
} from '../../verbs/worktree/manager.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from '../../verbs/worktree/pure/process-identity.js';
import { canonicalWorktreeId } from '../../verbs/worktree/pure/path-containment.js';
import {
  deriveWorktreePath,
  guardWorktreeContainment,
  defaultRealpath,
  type RealpathResolver,
  type WorktreePathGuardResult,
  type WorktreePathRefused,
} from './topology.js';

/** The intent event for the creation of a launcher top-level worktree. */
export const CREATE_REQUESTED = 'worktree.create.requested';
/** The terminal event for the creation of a launcher top-level worktree. It shares the stem of the intent. */
export const CREATE_EXECUTED = 'worktree.create.executed';

/** The containment guard seam, with the shape of {@link guardWorktreeContainment}. Tests inject it to spy on the order of the guard and the add. */
export type ContainmentGuard = (
  base: string,
  target: string,
  realpath?: RealpathResolver,
) => WorktreePathGuardResult;

/** Arguments for {@link createLauncherWorktree}. */
export interface CreateLauncherWorktreeInput {
  /** Absolute path of the base worktree that the new sibling path derives from. */
  readonly baseWorktree: string;
  /** Single path-segment sibling id, for example the launch id. */
  readonly id: string;
  /** Owning feature id, or `null` when the launch is unattached. */
  readonly featureId: string | null;
  /** New branch to create with `-b` (omit to let git derive one from the path). */
  readonly newBranch?: string;
  /** Optional start-point commit-ish for the new worktree. */
  readonly startPoint?: string;
  /** Repo root `git worktree add` runs from. Defaults to {@link baseWorktree}. */
  readonly repoRoot?: string;
}

/** Injectable seams for {@link createLauncherWorktree}. */
export interface CreateLauncherWorktreeDeps {
  /**
   * The git seam for the worktree git calls (`git worktree add` and the registration precheck).
   * Tests inject it to record the argument vectors. Defaults to {@link defaultGitRunner}.
   */
  readonly gitRunner?: GitRunner;
  /** The WLM manager whose `reserve` records ownership. Defaults to a fresh one. */
  readonly manager?: WorktreeManager;
  /** The containment guard. Defaults to {@link guardWorktreeContainment}. */
  readonly guard?: ContainmentGuard;
  /** Symlink-resolver used for canonical keying. Defaults to {@link defaultRealpath}. */
  readonly realpath?: RealpathResolver;
  /** Process-identity source for self create-time. Defaults to the real OS source. */
  readonly processSource?: ProcessSource;
  /** Reserving process PID. Defaults to `process.pid`. */
  readonly selfPid?: number;
  /**
   * Create-time fingerprint of the reserving process. Defaults to the probed value.
   * It is `null`, never `''`, when the platform cannot resolve it, as the `ownerStartedAt` field of `worktree.reserved` requires.
   */
  readonly selfStartedAt?: string | null;
  /** Idempotency correlator for the create pair. Defaults to a fresh uuid. */
  readonly operationId?: string;
}

/** Outcome of {@link createLauncherWorktree}. */
export type CreateLauncherWorktreeResult =
  | {
      readonly ok: true;
      /** Canonical (symlink-resolved) worktree path — the `worktrees@v1` key. */
      readonly worktreeId: string;
      /** Absolute path of the created (or already-present) worktree. */
      readonly worktreePath: string;
      /** The correlator of the create pair. */
      readonly operationId: string;
      /** True when this call created the worktree, and false when it was already on disk. */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'containment-refused';
      /** The structured containment refusal: nested inside the base, or escaping containment. */
      readonly refusal: WorktreePathRefused;
    }
  | {
      readonly ok: false;
      readonly reason: 'reserve-conflict';
      /** The live owner already holding the worktree, when known. */
      readonly conflict?: ReservationOwner | undefined;
    }
  | {
      readonly ok: false;
      readonly reason: 'git-add-failed';
      readonly worktreePath: string;
      /** git's failure output. The durable intent is left for a recovery pass. */
      readonly stderr: string;
    };

/**
 * Create the launcher top-level worktree in the order of the module header: guard, `reserve`, intent, `git worktree add`, terminal.
 * A failed add leaves the intent open for a recovery pass. A re-run with the same `operationId`, or {@link recoverPendingCreations}, resumes an unfinished create.
 */
export async function createLauncherWorktree(
  eventStore: EventStore,
  input: CreateLauncherWorktreeInput,
  deps: CreateLauncherWorktreeDeps = {},
): Promise<CreateLauncherWorktreeResult> {
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const realpath = deps.realpath ?? defaultRealpath;
  const guard = deps.guard ?? guardWorktreeContainment;
  const processSource = deps.processSource ?? defaultProcessSource;
  const manager =
    deps.manager ??
    new WorktreeManager({ eventStore, realpath, gitRunner, processSource });
  const repoRoot = input.repoRoot ?? input.baseWorktree;

  const derived = deriveWorktreePath(input.baseWorktree, input.id);
  const guardResult = guard(input.baseWorktree, derived, realpath);
  if (!guardResult.ok) {
    return { ok: false, reason: 'containment-refused', refusal: guardResult };
  }
  const worktreePath = guardResult.path;
  const worktreeId = canonicalWorktreeId(worktreePath, realpath);

  const selfPid = deps.selfPid ?? process.pid;
  const selfStartedAt =
    deps.selfStartedAt ?? resolveSelfStartedAt(selfPid, processSource);
  const reserve = await manager.reserve({
    worktreeId,
    path: worktreePath,
    featureId: input.featureId,
    ownerPid: selfPid,
    ownerStartedAt: selfStartedAt,
  });
  if (!reserve.reserved) {
    return { ok: false, reason: 'reserve-conflict', conflict: reserve.conflict };
  }

  const operationId = deps.operationId ?? randomUUID();
  await appendCreateRequested(eventStore, operationId, worktreePath, worktreeId, {
    ...(input.newBranch !== undefined ? { branch: input.newBranch } : {}),
    ...(input.startPoint !== undefined ? { startPoint: input.startPoint } : {}),
  });

  const outcome = ensureWorktreeCreated(
    gitRunner,
    repoRoot,
    worktreePath,
    buildAddArgs(input, worktreePath),
    realpath,
  );
  if (!outcome.ok) {
    return { ok: false, reason: 'git-add-failed', worktreePath, stderr: outcome.stderr };
  }

  await appendCreateExecuted(
    eventStore,
    operationId,
    worktreePath,
    outcome.created,
    worktreeId,
  );
  return { ok: true, worktreeId, worktreePath, operationId, created: outcome.created };
}

/** One resumed creation folded by {@link recoverPendingCreations}. */
export interface RecoveredCreation {
  readonly operationId: string;
  readonly worktreePath: string;
  readonly worktreeId: string | null;
  /** True when the resume ran the add, and false when the worktree was already on disk. */
  readonly created: boolean;
}

/** Injectable seams for {@link recoverPendingCreations}. */
export interface RecoverPendingCreationsDeps {
  readonly gitRunner?: GitRunner;
  readonly realpath?: RealpathResolver;
  /**
   * Rebuild the `git worktree add` argument vector for a resumed creation, from the recovered `spec`.
   * The intent carries the original `branch` and `startPoint`, so the default ({@link composeAddArgs}) replays the full command, `-b <branch>` included.
   */
  readonly rebuildAddArgs?: (
    worktreePath: string,
    spec: AddArgsSpec,
  ) => readonly string[];
}

/**
 * Finish each crashed creation: a `worktree.create.requested` with no paired `worktree.create.executed`.
 * For each, the precheck ({@link ensureWorktreeCreated}) skips the add when the worktree is on disk, or runs the add again.
 * Then it emits the missing terminal with the original `operationId`. An add that fails again leaves the intent for a later pass.
 */
export async function recoverPendingCreations(
  eventStore: EventStore,
  repoRoot: string,
  deps: RecoverPendingCreationsDeps = {},
): Promise<RecoveredCreation[]> {
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const realpath = deps.realpath ?? defaultRealpath;
  const rebuildAddArgs =
    deps.rebuildAddArgs ??
    ((p: string, spec: AddArgsSpec): readonly string[] => composeAddArgs(p, spec));

  const pending = await listPendingCreations(eventStore);
  const handled = new Set<string>();
  const recovered: RecoveredCreation[] = [];
  for (const { operationId, worktreePath, worktreeId, branch, startPoint } of pending) {
    if (handled.has(operationId)) continue;
    handled.add(operationId);
    const outcome = ensureWorktreeCreated(
      gitRunner,
      repoRoot,
      worktreePath,
      rebuildAddArgs(worktreePath, {
        ...(branch !== undefined ? { branch } : {}),
        ...(startPoint !== undefined ? { startPoint } : {}),
      }),
      realpath,
    );
    if (!outcome.ok) continue;
    await appendCreateExecuted(
      eventStore,
      operationId,
      worktreePath,
      outcome.created,
      worktreeId ?? canonicalWorktreeId(worktreePath, realpath),
    );
    recovered.push({ operationId, worktreePath, worktreeId, created: outcome.created });
  }
  return recovered;
}

/** The `-b`/start-point spec threaded through the create pair for faithful replay. */
interface AddArgsSpec {
  /** New branch to create with `-b` (omit to let git derive one from the path). */
  readonly branch?: string;
  /** Optional start-point commit-ish. */
  readonly startPoint?: string;
}

/**
 * The one `git worktree add` argument composer, for the first create ({@link buildAddArgs}) and for the resume ({@link recoverPendingCreations}).
 * Thus a resume replays the exact recorded command and never drops a `-b <branch>` or a start point.
 */
function composeAddArgs(worktreePath: string, spec: AddArgsSpec): string[] {
  const args: string[] = ['worktree', 'add'];
  if (spec.branch !== undefined) args.push('-b', spec.branch);
  args.push(worktreePath);
  if (spec.startPoint !== undefined) args.push(spec.startPoint);
  return args;
}

/** Build the `git worktree add` argument vector for `input`. */
function buildAddArgs(
  input: CreateLauncherWorktreeInput,
  worktreePath: string,
): readonly string[] {
  return composeAddArgs(worktreePath, {
    ...(input.newBranch !== undefined ? { branch: input.newBranch } : {}),
    ...(input.startPoint !== undefined ? { startPoint: input.startPoint } : {}),
  });
}

/** Outcome of the idempotent {@link ensureWorktreeCreated} precheck. */
type EnsureOutcome =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: false; readonly stderr: string };

/**
 * An idempotent precheck and add. When the worktree is already registered, it skips the add with `created: false`.
 * When the add fails but the worktree is then registered, a concurrent create won the race, and the result is also `created: false`.
 * A genuine failure returns `{ ok: false }` with the stderr of git, or stdout when stderr is empty. The caller then leaves the intent open.
 */
function ensureWorktreeCreated(
  gitRunner: GitRunner,
  repoRoot: string,
  worktreePath: string,
  addArgs: readonly string[],
  realpath: RealpathResolver,
): EnsureOutcome {
  if (isWorktreeRegistered(gitRunner, repoRoot, worktreePath, realpath)) {
    return { ok: true, created: false };
  }
  const { status, stdout, stderr } = gitRunner.run(addArgs, repoRoot);
  if (status === 0) return { ok: true, created: true };
  if (isWorktreeRegistered(gitRunner, repoRoot, worktreePath, realpath)) {
    return { ok: true, created: false };
  }
  const diagnostic = stderr !== undefined && stderr.trim().length > 0 ? stderr : stdout;
  return { ok: false, stderr: diagnostic };
}

/** Whether `worktreePath` is registered in `git worktree list` (canonical compare). */
function isWorktreeRegistered(
  gitRunner: GitRunner,
  repoRoot: string,
  worktreePath: string,
  realpath: RealpathResolver,
): boolean {
  const { status, stdout } = gitRunner.run(['worktree', 'list', '--porcelain'], repoRoot);
  if (status !== 0) return false;
  const targetId = canonicalWorktreeId(worktreePath, realpath);
  return parseWorktreeListPorcelain(stdout).some(
    (wt) => canonicalWorktreeId(wt.path, realpath) === targetId,
  );
}

/**
 * Append the creation intent with idempotency key `worktree.create.requested:<operationId>`.
 * It records `branch` and `startPoint` when they are set, so a resume replays the original command.
 */
async function appendCreateRequested(
  eventStore: EventStore,
  operationId: string,
  worktreePath: string,
  worktreeId: string,
  spec: AddArgsSpec,
): Promise<void> {
  await withStateRetry(() =>
    eventStore.append(
      WORKTREES_STREAM,
      {
        type: CREATE_REQUESTED,
        data: {
          operationId,
          worktreePath,
          worktreeId,
          ...(spec.branch !== undefined ? { branch: spec.branch } : {}),
          ...(spec.startPoint !== undefined ? { startPoint: spec.startPoint } : {}),
        },
      },
      { idempotencyKey: `${CREATE_REQUESTED}:${operationId}` },
    ),
  );
}

/** Append the creation terminal with idempotency key `worktree.create.executed:<operationId>`. */
async function appendCreateExecuted(
  eventStore: EventStore,
  operationId: string,
  worktreePath: string,
  created: boolean,
  worktreeId: string,
): Promise<void> {
  await withStateRetry(() =>
    eventStore.append(
      WORKTREES_STREAM,
      { type: CREATE_EXECUTED, data: { operationId, worktreePath, created, worktreeId } },
      { idempotencyKey: `${CREATE_EXECUTED}:${operationId}` },
    ),
  );
}

/** Read a string field off an event payload (`null` when absent / non-string). */
function eventStringField(event: WorkflowEvent, key: string): string | null {
  const value = event.data?.[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Scan the `worktrees` stream for `worktree.create.requested` events with no
 * paired `worktree.create.executed` (operationId-correlated) — the crashed
 * creations to resume, in stream order.
 */
async function listPendingCreations(
  eventStore: EventStore,
): Promise<
  Array<{
    operationId: string;
    worktreePath: string;
    worktreeId: string | null;
    branch?: string;
    startPoint?: string;
  }>
> {
  const events = await eventStore.query(WORKTREES_STREAM);
  const executedOps = new Set<string>();
  for (const event of events) {
    if (event.type !== CREATE_EXECUTED) continue;
    const op = eventStringField(event, 'operationId');
    if (op !== null) executedOps.add(op);
  }
  const pending: Array<{
    operationId: string;
    worktreePath: string;
    worktreeId: string | null;
    branch?: string;
    startPoint?: string;
  }> = [];
  for (const event of events) {
    if (event.type !== CREATE_REQUESTED) continue;
    const operationId = eventStringField(event, 'operationId');
    const worktreePath = eventStringField(event, 'worktreePath');
    if (operationId === null || worktreePath === null) continue;
    if (executedOps.has(operationId)) continue;
    const worktreeId = eventStringField(event, 'worktreeId');
    const branch = eventStringField(event, 'branch');
    const startPoint = eventStringField(event, 'startPoint');
    pending.push({
      operationId,
      worktreePath,
      worktreeId,
      ...(branch !== null ? { branch } : {}),
      ...(startPoint !== null ? { startPoint } : {}),
    });
  }
  return pending;
}

/**
 * Resolve the create-time fingerprint of the reserving process through the injected {@link ProcessSource}.
 * When the probe fails, it returns `null`, never `''`, because the `ownerStartedAt` schema accepts `null` but not an empty string.
 * The reservation stays valid, but it cannot detect PID reuse.
 */
function resolveSelfStartedAt(pid: number, source: ProcessSource): string | null {
  const probe = source.getStartTime(pid);
  return probe.status === 'present' ? probe.startedAt : null;
}
