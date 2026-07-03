/**
 * Launcher top-level, task-less worktree creation (DR-2, DR-5).
 *
 * The harness launcher's worktree is a **top-level, task-less** harness-process
 * worktree — a distinct kind from a delegation task worktree. It is therefore
 * tracked through the WLM lifecycle family the `worktrees@v1` projection already
 * folds (`worktree.reserved` + the launch liveness pair), NOT through the
 * task-scoped `worktree.created` terminal (which requires `taskId` + `branch`
 * and would give the launcher zero `ps` visibility — see the DR-2 correction in
 * the spec). This module performs the actual creation in the exact ordering the
 * spec pins, with EVERY append on the singleton `worktrees` stream:
 *
 *   1. **`reserve` FIRST — before `git worktree add`.** {@link WorktreeManager.reserve}
 *      emits a single `worktree.reserved` ownership event so the worktree is
 *      tracked in `worktrees@v1` (state `reserved`) BEFORE it exists on disk —
 *      closing the untracked-on-disk window a concurrent `adopt`/prune would race.
 *   2. **`worktree.create.requested`** — the INV-13 durable intent, idempotency
 *      key `worktree.create.requested:<operationId>`.
 *   3. **`git worktree add`** — routed through the manager's {@link GitRunner}
 *      seam (never a scattered `execFile`). The DR-5 topology guard
 *      ({@link deriveWorktreePath} + {@link guardWorktreeContainment}) runs
 *      BEFORE the add; a nested/escaping target is refused with a structured error.
 *   4. **`worktree.create.executed`** — the INV-13 shared-stem terminal.
 *
 * ## Crash-precheck (idempotent resume)
 *
 * A crash between the intent and the terminal is recovered by an idempotent
 * precheck: if the worktree is already registered on disk the add is skipped and
 * the terminal records `created: false`; otherwise the add is re-run. The
 * `<eventType>:<operationId>` idempotency key makes the appends idempotent (the
 * event-append lock serializes the *appends*, not the git side-effect between
 * intent and terminal — INV-7). {@link recoverPendingCreations} resumes any
 * `worktree.create.requested` with no paired `worktree.create.executed`.
 *
 * The `worktree.create.*` pair is INV-13 creation **audit**, correlated by
 * `operationId` for crash recovery — a `worktrees@v1` reducer no-op like
 * `worktree.remove.requested`, NOT a projection input. Launcher `ps` visibility
 * comes from `worktree.reserved` + `launch.*`.
 */

import { randomUUID } from 'node:crypto';
import type { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { withStateRetry } from '../workflow/state-retry.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  defaultGitRunner,
  parseWorktreeListPorcelain,
  type GitRunner,
  type ReservationOwner,
} from '../orchestrate/worktree/manager.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from '../orchestrate/worktree/pure/process-identity.js';
import { canonicalWorktreeId } from '../orchestrate/worktree/pure/path-containment.js';
import {
  deriveWorktreePath,
  guardWorktreeContainment,
  defaultRealpath,
  type RealpathResolver,
  type WorktreePathGuardResult,
  type WorktreePathRefused,
} from './topology.js';

/** The launcher's top-level worktree INTENT (INV-13). */
export const CREATE_REQUESTED = 'worktree.create.requested';
/** The launcher's top-level worktree TERMINAL (INV-13, shared stem). */
export const CREATE_EXECUTED = 'worktree.create.executed';

/**
 * The DR-5 containment guard seam. Structurally identical to
 * {@link guardWorktreeContainment}; injected so a test can spy on invocation
 * order (guard-before-add) without reaching into the topology internals.
 */
export type ContainmentGuard = (
  base: string,
  target: string,
  realpath?: RealpathResolver,
) => WorktreePathGuardResult;

/** Arguments for {@link createLauncherWorktree}. */
export interface CreateLauncherWorktreeInput {
  /** Absolute path of the base worktree the new sibling is derived off (DR-5). */
  readonly baseWorktree: string;
  /** Single path-segment sibling id (e.g. the launch id). */
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
   * The single git seam ALL worktree-mutating git routes through (`git worktree
   * add`, the registration precheck). Injected so a test can record the exact
   * argument vectors and assert nothing bypasses it; defaults to the real,
   * portable {@link defaultGitRunner}.
   */
  readonly gitRunner?: GitRunner;
  /** The WLM manager whose `reserve` records ownership. Defaults to a fresh one. */
  readonly manager?: WorktreeManager;
  /** The DR-5 containment guard. Defaults to {@link guardWorktreeContainment}. */
  readonly guard?: ContainmentGuard;
  /** Symlink-resolver used for canonical keying. Defaults to {@link defaultRealpath}. */
  readonly realpath?: RealpathResolver;
  /** Process-identity source for self create-time. Defaults to the real OS source. */
  readonly processSource?: ProcessSource;
  /** Reserving process PID. Defaults to `process.pid`. */
  readonly selfPid?: number;
  /** Reserving process create-time fingerprint. Defaults to the probed value. */
  readonly selfStartedAt?: string;
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
      /** The INV-13 create-pair correlator. */
      readonly operationId: string;
      /** True if this call created it; false if it was already on disk (idempotent). */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'containment-refused';
      /** The structured DR-5 refusal (nested-inside-base / escapes-containment). */
      readonly refusal: WorktreePathRefused;
    }
  | {
      readonly ok: false;
      readonly reason: 'reserve-conflict';
      /** The live owner already holding the worktree, when known. */
      readonly conflict?: ReservationOwner;
    }
  | {
      readonly ok: false;
      readonly reason: 'git-add-failed';
      readonly worktreePath: string;
      /** git's failure output. The durable intent is left for a recovery pass. */
      readonly stderr: string;
    };

/**
 * Create the launcher's top-level, task-less worktree in the spec-pinned order:
 * DR-5 guard → `reserve` → `worktree.create.requested` → `git worktree add` →
 * `worktree.create.executed`. All appends land on the singleton `worktrees`
 * stream. Idempotent under crash: a re-run with the same `operationId` (or
 * {@link recoverPendingCreations}) resumes an unfinished create.
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

  // ── Step A (DR-5): derive the sibling path + guard containment BEFORE add. ──
  const derived = deriveWorktreePath(input.baseWorktree, input.id);
  const guardResult = guard(input.baseWorktree, derived, realpath);
  if (!guardResult.ok) {
    return { ok: false, reason: 'containment-refused', refusal: guardResult };
  }
  const worktreePath = guardResult.path;
  const worktreeId = canonicalWorktreeId(worktreePath, realpath);

  // ── Step B (DR-2): RESERVE FIRST — before git worktree add. ──
  // The worktree is tracked in `worktrees@v1` (state `reserved`) BEFORE it
  // exists on disk, closing the untracked-on-disk window a concurrent adopt
  // would otherwise race.
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

  // ── Step C (INV-13): intent → add → terminal, all on the worktrees stream. ──
  const operationId = deps.operationId ?? randomUUID();
  await appendCreateRequested(eventStore, operationId, worktreePath, worktreeId);

  const outcome = ensureWorktreeCreated(
    gitRunner,
    repoRoot,
    worktreePath,
    buildAddArgs(input, worktreePath),
    realpath,
  );
  if (!outcome.ok) {
    // Genuine add failure (e.g. non-git target): leave the durable intent
    // unclosed so a recovery pass re-attempts. Never emit the terminal here.
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
  /** True if the resume re-ran the add; false if the worktree was already on disk. */
  readonly created: boolean;
}

/** Injectable seams for {@link recoverPendingCreations}. */
export interface RecoverPendingCreationsDeps {
  readonly gitRunner?: GitRunner;
  readonly realpath?: RealpathResolver;
  /**
   * Reconstruct the `git worktree add` argument vector for a resumed creation.
   * The `worktree.create.requested` event carries only path/id (not the branch),
   * so the default re-runs `git worktree add <path>` and lets git derive a
   * branch from the (unique) path basename.
   */
  readonly rebuildAddArgs?: (worktreePath: string) => readonly string[];
}

/**
 * Finish any crashed creation: a `worktree.create.requested` on the `worktrees`
 * stream with no paired `worktree.create.executed`. For each, run the SAME
 * idempotent precheck ({@link ensureWorktreeCreated}) — worktree on disk? emit
 * the terminal (`created: false`) : re-run the add — and emit the missing
 * `worktree.create.executed` REUSING the original `operationId`, so the audit
 * pair stays 1:1 and the entry is created exactly once across the crash.
 */
export async function recoverPendingCreations(
  eventStore: EventStore,
  repoRoot: string,
  deps: RecoverPendingCreationsDeps = {},
): Promise<RecoveredCreation[]> {
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const realpath = deps.realpath ?? defaultRealpath;
  const rebuildAddArgs =
    deps.rebuildAddArgs ?? ((p: string): readonly string[] => ['worktree', 'add', p]);

  const pending = await listPendingCreations(eventStore);
  const handled = new Set<string>();
  const recovered: RecoveredCreation[] = [];
  for (const { operationId, worktreePath, worktreeId } of pending) {
    if (handled.has(operationId)) continue; // one executed per operationId
    handled.add(operationId);
    const outcome = ensureWorktreeCreated(
      gitRunner,
      repoRoot,
      worktreePath,
      rebuildAddArgs(worktreePath),
      realpath,
    );
    if (!outcome.ok) continue; // still unrecoverable — leave the intent for later.
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

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Build the `git worktree add` argument vector for `input`. */
function buildAddArgs(
  input: CreateLauncherWorktreeInput,
  worktreePath: string,
): readonly string[] {
  const args: string[] = ['worktree', 'add'];
  if (input.newBranch !== undefined) args.push('-b', input.newBranch);
  args.push(worktreePath);
  if (input.startPoint !== undefined) args.push(input.startPoint);
  return args;
}

/** Outcome of the idempotent {@link ensureWorktreeCreated} precheck. */
type EnsureOutcome =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: false; readonly stderr: string };

/**
 * Idempotent precheck + add. Registered on disk already ⇒ skip the add
 * (`created: false`, an idempotent success). Otherwise run `git worktree add`
 * via the injected runner; a non-zero status that nonetheless left the worktree
 * registered (a concurrent create won the race) also downgrades to
 * `created: false`. A genuine failure (still unregistered) surfaces as
 * `{ ok: false }` so the caller can leave the INV-13 intent open for resume.
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
  const { status, stdout } = gitRunner.run(addArgs, repoRoot);
  if (status === 0) return { ok: true, created: true };
  if (isWorktreeRegistered(gitRunner, repoRoot, worktreePath, realpath)) {
    return { ok: true, created: false }; // raced into existence — idempotent.
  }
  return { ok: false, stderr: stdout };
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

/** Append the INV-13 intent (idempotency key `worktree.create.requested:<operationId>`). */
async function appendCreateRequested(
  eventStore: EventStore,
  operationId: string,
  worktreePath: string,
  worktreeId: string,
): Promise<void> {
  await withStateRetry(() =>
    eventStore.append(
      WORKTREES_STREAM,
      { type: CREATE_REQUESTED, data: { operationId, worktreePath, worktreeId } },
      { idempotencyKey: `${CREATE_REQUESTED}:${operationId}` },
    ),
  );
}

/** Append the INV-13 terminal (idempotency key `worktree.create.executed:<operationId>`). */
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
): Promise<Array<{ operationId: string; worktreePath: string; worktreeId: string | null }>> {
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
  }> = [];
  for (const event of events) {
    if (event.type !== CREATE_REQUESTED) continue;
    const operationId = eventStringField(event, 'operationId');
    const worktreePath = eventStringField(event, 'worktreePath');
    if (operationId === null || worktreePath === null) continue;
    if (executedOps.has(operationId)) continue;
    const worktreeId = eventStringField(event, 'worktreeId');
    pending.push({ operationId, worktreePath, worktreeId });
  }
  return pending;
}

/**
 * Resolve the reserving process's create-time fingerprint via the injected
 * {@link ProcessSource}; `''` when it cannot be probed (still a well-formed
 * reservation — it just cannot defeat PID reuse). Mirrors the self-identity
 * resolution in `merge-serializer.ts` / `handlers.ts`.
 */
function resolveSelfStartedAt(pid: number, source: ProcessSource): string {
  const probe = source.getStartTime(pid);
  return probe.status === 'present' ? probe.startedAt : '';
}
