// ─── Worktree-lifecycle dispatch handlers (WLM foundation, task 008) ─────────
//
// The four composite ACTIONS that ride the existing visible tools (INV-5d — NO
// new visible tool):
//
//   - `acquire_worktree`  (exarchos_orchestrate) — adopt-then-reserve composite.
//   - `release_worktree`  (exarchos_orchestrate) — release the caller's claim.
//   - `prune_worktrees`   (exarchos_orchestrate) — the GC (dry-run by default).
//   - `worktrees`         (exarchos_view)        — read the worktrees@v1 fold.
//
// Every handler carries ZERO behavior of its own (INV-2): it constructs the
// in-process {@link WorktreeManager} facade over `ctx.eventStore` and delegates.
// Because both the CLI and MCP adapters dispatch through the same composite
// router, the same DispatchContext + args project an identical ToolResult on
// either surface.
// ─────────────────────────────────────────────────────────────────────────────

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import {
  WorktreeManager,
  type WorktreeManagerDeps,
  type ReserveInput,
} from './manager.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from './pure/process-identity.js';
import {
  serializeMerge,
  type SerializeMergeInput,
  type SerializeMergeDeps,
} from './merge-serializer.js';

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Test/DI seam: subset of {@link WorktreeManagerDeps} a caller may thread
 * through args to make a dispatch deterministic (inject a fake git probe /
 * process source / git runner). Production callers omit every field, so the
 * manager wires the real OS-backed defaults. Kept OUT of the registry input
 * schema — these are never user-facing flags.
 */
type InjectableDeps = Omit<WorktreeManagerDeps, 'eventStore'>;

/** Build a {@link WorktreeManager} over the dispatch event store + opt-in deps. */
function buildManager(ctx: DispatchContext, deps?: InjectableDeps): WorktreeManager {
  return new WorktreeManager({ eventStore: ctx.eventStore, ...deps });
}

function invalidInput(message: string, expectedShape?: Record<string, unknown>): ToolResult {
  return {
    success: false,
    error: { code: 'INVALID_INPUT', message, ...(expectedShape ? { expectedShape } : {}) },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Resolve the reserving process identity — **all-or-nothing**.
 *
 * A `(ownerPid, ownerStartedAt)` tuple must describe ONE real process, so the
 * two fields are accepted only together:
 *
 *   - **both** explicit → use them verbatim (the caller already knows the live
 *     owner, e.g. it is stamping on behalf of a child it spawned);
 *   - **neither** → derive BOTH from the CURRENT process — `process.pid` paired
 *     with that same PID's create-time via the injected {@link ProcessSource} —
 *     so the reservation heals correctly once this process dies (DR-3);
 *   - **exactly one** → REJECT. Pairing a lone `ownerStartedAt` with
 *     `process.pid`, or a lone `ownerPid` with a derived create-time, would
 *     persist a fingerprint NO real process ever had — a reservation that can
 *     never be matched against a live process (ownership corruption).
 *
 * A platform that cannot resolve the current process's create-time yields `''`
 * (still a well-formed reservation; it just cannot defeat PID reuse).
 */
function resolveOwner(
  rest: Record<string, unknown>,
  processSource: ProcessSource,
):
  | { ok: true; owner: { ownerPid: number; ownerStartedAt: string } }
  | { ok: false; error: string } {
  const hasPid = rest.ownerPid !== undefined;
  const hasStartedAt = rest.ownerStartedAt !== undefined;

  // Partial override → reject (the all-or-nothing contract).
  if (hasPid !== hasStartedAt) {
    return {
      ok: false,
      error:
        'ownerPid and ownerStartedAt must be provided together (both or neither) — a partial owner override would persist a tuple no real process had',
    };
  }

  if (hasPid && hasStartedAt) {
    const explicitPid = rest.ownerPid;
    if (
      typeof explicitPid !== 'number' ||
      !Number.isInteger(explicitPid) ||
      explicitPid <= 0
    ) {
      return { ok: false, error: 'ownerPid must be a positive integer' };
    }
    const explicitStartedAt = optionalString(rest.ownerStartedAt);
    if (explicitStartedAt === undefined || explicitStartedAt.length === 0) {
      return { ok: false, error: 'ownerStartedAt must be a non-empty string' };
    }
    return { ok: true, owner: { ownerPid: explicitPid, ownerStartedAt: explicitStartedAt } };
  }

  // Neither explicit → derive BOTH from the current process.
  const ownerPid = process.pid;
  const probe = processSource.getStartTime(ownerPid);
  const ownerStartedAt = probe.status === 'present' ? probe.startedAt : '';
  return { ok: true, owner: { ownerPid, ownerStartedAt } };
}

// ─── acquire_worktree ────────────────────────────────────────────────────────

/**
 * Adopt-then-reserve composite. First runs the harness-neutral adopt pass over
 * `repoRoot` so every on-disk worktree is tracked in `worktrees@v1`, then
 * reserves `worktreeId` for the live owner. Idempotent: a re-run re-adopts to a
 * no-op and re-reserves under the manager's per-call idempotency key.
 */
export async function handleAcquireWorktree(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: InjectableDeps,
): Promise<ToolResult> {
  const repoRoot = optionalString(args.repoRoot);
  if (!repoRoot) {
    return invalidInput('acquire_worktree requires repoRoot: string', {
      repoRoot: 'string',
    });
  }
  const worktreeId = optionalString(args.worktreeId);
  if (!worktreeId) {
    return invalidInput('acquire_worktree requires worktreeId: string', {
      worktreeId: 'string',
    });
  }
  const manager = buildManager(ctx, deps);
  const processSource = deps?.processSource ?? defaultProcessSource;

  // Adopt-gate FIRST so an unadopted on-disk worktree is governed before the
  // reservation lands (mirrors prune's step 0).
  const adoptResult = await manager.adopt(repoRoot);

  const ownerResult = resolveOwner(args, processSource);
  if (!ownerResult.ok) {
    return invalidInput(ownerResult.error, {
      ownerPid: 'number (with ownerStartedAt)',
      ownerStartedAt: 'string (with ownerPid)',
    });
  }

  const featureId = args.featureId === null ? null : optionalString(args.featureId) ?? null;
  const reserveInput: ReserveInput = {
    worktreeId,
    path: optionalString(args.path) ?? worktreeId,
    featureId,
    ownerPid: ownerResult.owner.ownerPid,
    ownerStartedAt: ownerResult.owner.ownerStartedAt,
  };
  const reserveResult = await manager.reserve(reserveInput);

  // Exclusive ownership: the worktree is already reserved by a different live
  // owner — reject the claim rather than fabricate a second concurrent owner.
  if (!reserveResult.reserved) {
    return {
      success: false,
      error: {
        code: 'WORKTREE_RESERVED',
        message: `worktree ${worktreeId} is already reserved by a live owner`,
        ...(reserveResult.conflict
          ? { conflict: reserveResult.conflict }
          : {}),
      },
    };
  }

  return {
    success: true,
    data: {
      worktreeId,
      path: reserveInput.path,
      featureId,
      reserved: true,
      adopted: adoptResult.adopted.includes(worktreeId),
    },
  };
}

// ─── release_worktree ────────────────────────────────────────────────────────

/**
 * Release the CALLER's reservation: appends `worktree.released`. The caller's
 * process identity is resolved (or taken from an explicit owner override) and
 * passed to the manager, which REFUSES to release a worktree currently reserved
 * by a DIFFERENT live owner (a stale caller must not free someone else's live
 * claim — reaping a dead owner is `reconcile`'s job). An unknown / not-reserved
 * / dead-owner / same-owner `worktreeId` still emits a well-formed released
 * event (owner fields cleared) — a safe idempotent no-op when nothing live is
 * held.
 */
export async function handleReleaseWorktree(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: InjectableDeps,
): Promise<ToolResult> {
  const worktreeId = optionalString(args.worktreeId);
  if (!worktreeId) {
    return invalidInput('release_worktree requires worktreeId: string', {
      worktreeId: 'string',
    });
  }
  const manager = buildManager(ctx, deps);
  const processSource = deps?.processSource ?? defaultProcessSource;
  const ownerResult = resolveOwner(args, processSource);
  if (!ownerResult.ok) {
    return invalidInput(ownerResult.error, {
      ownerPid: 'number (with ownerStartedAt)',
      ownerStartedAt: 'string (with ownerPid)',
    });
  }
  const result = await manager.release(worktreeId, ownerResult.owner);
  if (result.rejectedForeignOwner) {
    return {
      success: false,
      error: {
        code: 'WORKTREE_OWNED_BY_OTHER',
        message: `worktree ${worktreeId} is reserved by a different live owner — refusing to release another process's claim`,
      },
    };
  }
  return {
    success: true,
    data: { worktreeId, released: result.released },
  };
}

// ─── prune_worktrees ─────────────────────────────────────────────────────────

/**
 * The fail-closed worktree GC. DRY-RUN by DEFAULT: omitting `dryRun` (or passing
 * `dryRun: true`) reports candidates + reclaimable bytes + grouped skip reasons
 * and deletes NOTHING. Only `dryRun: false` applies; orphan deletion needs the
 * explicit `pruneOrphans` + `yes` opt-in on top of an apply run.
 */
export async function handlePruneWorktrees(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: InjectableDeps,
): Promise<ToolResult> {
  const repoRoot = optionalString(args.repoRoot);
  if (!repoRoot) {
    return invalidInput('prune_worktrees requires repoRoot: string', {
      repoRoot: 'string',
    });
  }
  // INV-5c safe default: dry-run unless the caller EXPLICITLY opts out with
  // `dryRun: false`. The Zod default lives here (not on the schema) because two
  // sibling actions declare `dryRun` with no default and the MCP-registration
  // flattener forbids divergent defaults across a shared field.
  const apply = optionalBoolean(args.dryRun) === false;
  const manager = buildManager(ctx, deps);
  const result = await manager.prune({
    repoRoot,
    apply,
    pruneOrphans: optionalBoolean(args.pruneOrphans),
    yes: optionalBoolean(args.yes),
  });
  return { success: true, data: result };
}

// ─── worktrees (view) ────────────────────────────────────────────────────────

/**
 * Read the `worktrees@v1` projection: fold the `worktrees` stream and return
 * the live governed-worktree set. Pure read — no adopt, no git probe, no
 * append.
 */
export async function handleViewWorktrees(
  _args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: InjectableDeps,
): Promise<ToolResult> {
  const manager = buildManager(ctx, deps);
  const worktrees = await manager.list();
  return {
    success: true,
    data: { worktrees, count: worktrees.length },
  };
}

// ─── serialize_merge (WLM operational core, DR-7) ─────────────────────────────

/**
 * Serialize an integration-branch merge behind the optimistic per-`integrationRef`
 * lease, then compose `merge_orchestrate` UNCHANGED. The lease (a
 * `worktree.merge_requested` / `worktree.merge_executed` pair on the singleton
 * `worktrees` stream) is the ONLY serialization — no flock, no `.lock` file. The
 * `deps` parameter is the test-only DI seam (injected sleep / process-table
 * probe / composed merge); production callers omit it so the serializer wires the
 * real OS-backed defaults. Validates the four required fields up front so a
 * malformed dispatch returns a structured `INVALID_INPUT` rather than reaching
 * the lease loop.
 */
export async function handleSerializeMerge(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: SerializeMergeDeps,
): Promise<ToolResult> {
  const featureId = optionalString(args.featureId);
  if (!featureId) {
    return invalidInput('serialize_merge requires featureId: string', {
      featureId: 'string',
    });
  }
  const integrationRef = optionalString(args.integrationRef);
  if (!integrationRef) {
    return invalidInput('serialize_merge requires integrationRef: string', {
      integrationRef: 'string',
    });
  }
  const sourceBranch = optionalString(args.sourceBranch);
  if (!sourceBranch) {
    return invalidInput('serialize_merge requires sourceBranch: string', {
      sourceBranch: 'string',
    });
  }
  const strategy = optionalString(args.strategy);
  if (strategy !== 'squash' && strategy !== 'rebase' && strategy !== 'merge') {
    return invalidInput(
      "serialize_merge requires strategy: 'squash' | 'rebase' | 'merge'",
      { strategy: "'squash' | 'rebase' | 'merge'" },
    );
  }
  const taskId = optionalString(args.taskId);
  const repoRoot = optionalString(args.repoRoot);
  const timeoutMs =
    typeof args.timeoutMs === 'number' &&
    Number.isInteger(args.timeoutMs) &&
    args.timeoutMs > 0
      ? args.timeoutMs
      : undefined;

  const input: SerializeMergeInput = {
    featureId,
    integrationRef,
    sourceBranch,
    strategy,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return serializeMerge(input, ctx, deps);
}
