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
 * Resolve the reserving process identity. An explicit `ownerPid` /
 * `ownerStartedAt` pair wins (the caller already knows the live owner); else we
 * stamp the CURRENT process via the injected {@link ProcessSource} so the
 * reservation is healed correctly once this process dies (crash-safe ownership,
 * DR-3). A platform that cannot resolve a create-time fingerprint yields `''` —
 * still a well-formed reservation, it just cannot defeat PID reuse.
 */
function resolveOwner(
  rest: Record<string, unknown>,
  processSource: ProcessSource,
): { ownerPid: number; ownerStartedAt: string } {
  const explicitPid = rest.ownerPid;
  const ownerPid =
    typeof explicitPid === 'number' && Number.isInteger(explicitPid) && explicitPid > 0
      ? explicitPid
      : process.pid;
  const explicitStartedAt = optionalString(rest.ownerStartedAt);
  const ownerStartedAt =
    explicitStartedAt ?? processSource.getStartTime(ownerPid) ?? '';
  return { ownerPid, ownerStartedAt };
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

  const featureId = args.featureId === null ? null : optionalString(args.featureId) ?? null;
  const reserveInput: ReserveInput = {
    worktreeId,
    path: optionalString(args.path) ?? worktreeId,
    featureId,
    ...resolveOwner(args, processSource),
  };
  await manager.reserve(reserveInput);

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
 * Release the caller's reservation: appends `worktree.released`. An unknown
 * `worktreeId` still emits a well-formed released event (the manager folds the
 * current entry for provenance and clears the owner fields), so the action is a
 * safe idempotent no-op when nothing is held.
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
  await manager.release(worktreeId);
  return {
    success: true,
    data: { worktreeId, released: true },
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
