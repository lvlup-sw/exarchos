/**
 * Launcher ⇄ WLM composition (DR-3).
 *
 * The harness launcher is a **producer / actuator** — it makes worktrees and
 * asks for merges — while the shipped Worktree Lifecycle Manager (WLM) remains
 * the single owner of *tracking*, *verifying*, and *serializing*, **including**
 * for worktrees the launcher did NOT create. This module is the thin seam that
 * WIRES the launcher's producer surface onto the WLM's shipped entry points; it
 * re-homes nothing and reimplements nothing.
 *
 * ## What composes here (and what deliberately does not)
 *
 *   - **Producer wiring.** {@link LauncherWlm.createWorktree} delegates to the
 *     Task-005 {@link createLauncherWorktree}, whose `reserve` step emits the
 *     ownership event `worktree.reserved` that the `worktrees@v1` projection
 *     folds — so the launcher is a *producer the projection consumes*, giving
 *     `exarchos_view{worktrees|ps}` launcher visibility with no fresh scan. (The
 *     `worktree.create.*` pair is INV-13 creation **audit**, correlated by
 *     `operationId`, a `worktrees@v1` reducer no-op — NOT a projection input.)
 *   - **Retain adopt / reconcile.** {@link LauncherWlm.adopt} /
 *     {@link LauncherWlm.reconcile} stay reachable and delegate straight to the
 *     shipped {@link WorktreeManager}. The launcher does NOT assume sole
 *     ownership of worktree creation: a **harness-created nested worktree**
 *     (a Claude Code `.claude/worktrees/agent-*`, a Codex/Cursor worktree, a
 *     hand-made `git worktree add`) is tracked through `adopt`. A
 *     **launcher-created worktree** — already `reserved` — is NOT re-adopted when
 *     a concurrent `adopt`/prune enumerates `git worktree list`, because
 *     `adopt`'s "already tracked → skip" backstop leaves it untouched. Both
 *     paths share ONE event store, so the create-vs-adopt boundary is decided by
 *     the folded state, not by who holds a manager instance.
 *   - **Serialize merges.** {@link LauncherWlm.serializeIntegrationMerge}
 *     delegates to the shipped {@link serializeMerge} optimistic lease, which
 *     composes `merge_orchestrate` UNCHANGED. The launcher is a *caller*: it
 *     re-homes neither `merge_orchestrate` nor the WLM projections, and it never
 *     bypasses the lease with a direct merge.
 *
 * The WLM itself (`manager.ts`, `merge-serializer.ts`, `projections/worktrees.ts`)
 * is untouched by this module — composition, not replacement (DR-3).
 */

import type { DispatchContext } from '../dispatch/core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  WorktreeManager,
  type AdoptResult,
  type ReconcileResult,
  type GitRunner,
} from '../verbs/worktree/manager.js';
import {
  serializeMerge,
  type SerializeMergeInput,
  type SerializeMergeDeps,
} from '../verbs/worktree/merge-serializer.js';
import type { RealpathResolver } from '../verbs/worktree/pure/path-containment.js';
import {
  createLauncherWorktree,
  type CreateLauncherWorktreeInput,
  type CreateLauncherWorktreeDeps,
  type CreateLauncherWorktreeResult,
} from './create-worktree.js';

/** Construction dependencies for {@link LauncherWlm}. */
export interface LauncherWlmDeps {
  /**
   * The dispatch context whose `eventStore` is the single append substrate every
   * composed WLM path (produce / adopt / reconcile / serialize-merge) writes to,
   * and which {@link serializeMerge} threads to the composed `merge_orchestrate`.
   */
  readonly ctx: DispatchContext;
  /**
   * The shipped WLM facade. Injected so a caller (or test) can share a
   * pre-built manager; defaults to a fresh {@link WorktreeManager} over
   * `ctx.eventStore` with the same `realpath` / `gitRunner` seams the producer
   * path uses, so `adopt` and the launcher's `reserve` canonicalize a worktree
   * path to the SAME `worktreeId` key (the create-vs-adopt boundary depends on it).
   */
  readonly manager?: WorktreeManager;
  /**
   * Symlink-resolving canonicalizer shared by the manager AND the producer path
   * so both derive an identical `worktreeId`. Defaults to the manager/producer
   * defaults (`defaultRealpath`).
   */
  readonly realpath?: RealpathResolver;
  /**
   * Low-level git runner shared by the manager AND the producer's
   * `git worktree add` / registration precheck. Defaults to the shipped
   * `defaultGitRunner`.
   */
  readonly gitRunner?: GitRunner;
}

/**
 * The launcher's composition facade over the shipped WLM (DR-3). Holds no state
 * of its own beyond the shared {@link WorktreeManager} + dispatch context; every
 * method delegates to an already-shipped WLM entry point.
 */
export class LauncherWlm {
  private readonly ctx: DispatchContext;
  private readonly manager: WorktreeManager;
  private readonly realpath: RealpathResolver | undefined;
  private readonly gitRunner: GitRunner | undefined;

  constructor(deps: LauncherWlmDeps) {
    this.ctx = deps.ctx;
    this.realpath = deps.realpath;
    this.gitRunner = deps.gitRunner;
    this.manager =
      deps.manager ??
      new WorktreeManager({
        eventStore: deps.ctx.eventStore,
        ...(deps.realpath !== undefined ? { realpath: deps.realpath } : {}),
        ...(deps.gitRunner !== undefined ? { gitRunner: deps.gitRunner } : {}),
      });
  }

  /** The shipped WLM facade this composition wires — exposed for advanced callers. */
  get worktreeManager(): WorktreeManager {
    return this.manager;
  }

  /**
   * PRODUCER wiring: create the launcher's top-level, task-less worktree via the
   * shipped {@link createLauncherWorktree}. Its `reserve` step emits the
   * `worktree.reserved` ownership event the `worktrees@v1` projection folds, so
   * the created worktree is tracked (state `reserved`) with no fresh scan. Shares
   * this facade's {@link WorktreeManager} + `realpath` / `gitRunner` seams so the
   * reserved `worktreeId` matches what a later {@link adopt} would derive.
   */
  createWorktree(
    input: CreateLauncherWorktreeInput,
    deps: CreateLauncherWorktreeDeps = {},
  ): Promise<CreateLauncherWorktreeResult> {
    return createLauncherWorktree(this.ctx.eventStore, input, {
      manager: this.manager,
      ...(this.realpath !== undefined ? { realpath: this.realpath } : {}),
      ...(this.gitRunner !== undefined ? { gitRunner: this.gitRunner } : {}),
      ...deps,
    });
  }

  /**
   * RETAIN adopt: track every on-disk worktree the launcher did NOT create by
   * delegating to the shipped {@link WorktreeManager.adopt}. A harness-created
   * nested worktree is folded into `worktree.adopted`; a launcher-created worktree
   * that is already `reserved` is left untouched by adopt's "already tracked →
   * skip" backstop. Pure delegation — the launcher owns no adoption logic.
   */
  adopt(repoRoot: string): Promise<AdoptResult> {
    return this.manager.adopt(repoRoot);
  }

  /**
   * RETAIN reconcile: heal every reservation whose owning process is provably
   * dead, by delegating to the shipped {@link WorktreeManager.reconcile}. Kept
   * reachable so the launcher's producer activity never strands a dead-owner
   * reservation the WLM could not reap.
   */
  reconcile(): Promise<ReconcileResult> {
    return this.manager.reconcile();
  }

  /**
   * CALLER of the merge serializer: route an integration merge through the
   * shipped {@link serializeMerge} optimistic lease (which composes
   * `merge_orchestrate` UNCHANGED). The launcher never merges directly — the
   * lease is the single serialization point, so at most one in-flight merge runs
   * per `integrationRef`. Threads this facade's dispatch context so the composed
   * merge writes to the same substrate.
   *
   * DR-1 default-flip safety: `serialize_merge` now DEFAULTS to dry-run, so this
   * integration-merge surface pins `dryRun: false` (an EXECUTE) unless the caller
   * explicitly asked for a dry-run preview — otherwise the new default would
   * silently no-op a real integration merge.
   */
  serializeIntegrationMerge(
    input: SerializeMergeInput,
    deps: SerializeMergeDeps = {},
  ): Promise<ToolResult> {
    return serializeMerge({ ...input, dryRun: input.dryRun ?? false }, this.ctx, deps);
  }
}

/**
 * Construct a {@link LauncherWlm} composition facade. Thin factory kept for
 * call-site symmetry with the other launcher building blocks.
 */
export function createLauncherWlm(deps: LauncherWlmDeps): LauncherWlm {
  return new LauncherWlm(deps);
}
