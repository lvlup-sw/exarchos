/**
 * Composes the harness launcher with the Worktree Lifecycle Manager (WLM).
 *
 * The launcher creates worktrees and asks for merges. The WLM tracks, verifies, and serializes them,
 * including worktrees that the launcher did not create. This module wires the launcher onto the WLM entry
 * points and reimplements nothing.
 *
 * - `createWorktree` emits `worktree.reserved` through {@link createLauncherWorktree}, so the
 *   `worktrees@v1` projection tracks the worktree with no new scan. The `worktree.create.*` events are a
 *   creation audit that the reducer ignores.
 * - `adopt` and `reconcile` delegate to {@link WorktreeManager}. `adopt` tracks a worktree that a harness
 *   or a person created, and skips a worktree that is already tracked.
 * - `serializeIntegrationMerge` goes through the {@link serializeMerge} lease and never merges directly.
 */

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import {
  WorktreeManager,
  type AdoptResult,
  type ReconcileResult,
  type GitRunner,
} from '../../verbs/worktree/manager.js';
import {
  serializeMerge,
  type SerializeMergeInput,
  type SerializeMergeDeps,
} from '../../verbs/worktree/merge-serializer.js';
import type { RealpathResolver } from '../../verbs/worktree/pure/path-containment.js';
import {
  createLauncherWorktree,
  type CreateLauncherWorktreeInput,
  type CreateLauncherWorktreeDeps,
  type CreateLauncherWorktreeResult,
} from './create-worktree.js';

/** Construction dependencies for {@link LauncherWlm}. */
export interface LauncherWlmDeps {
  /**
   * The dispatch context. Its `eventStore` takes the appends of each composed path, and
   * {@link serializeMerge} passes the context on to `merge_orchestrate`.
   */
  readonly ctx: DispatchContext;
  /**
   * The WLM facade. The default is a new {@link WorktreeManager} over `ctx.eventStore` with the same
   * `realpath` and `gitRunner` as the producer path. Thus `adopt` and `reserve` derive the same
   * `worktreeId` for a path, and the boundary between create and adopt depends on that.
   */
  readonly manager?: WorktreeManager;
  /**
   * Symlink-resolving canonicalizer that the manager and the producer path share, so both derive the same
   * `worktreeId`. The default is `defaultRealpath`.
   */
  readonly realpath?: RealpathResolver;
  /**
   * Git runner that the manager and the producer path share, for `git worktree add` and the registration
   * precheck. The default is `defaultGitRunner`.
   */
  readonly gitRunner?: GitRunner;
}

/**
 * The composition facade of the launcher over the WLM. It keeps no state other than its dependencies, and
 * each method delegates to a WLM entry point.
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

  /** The WLM facade that this composition uses. */
  get worktreeManager(): WorktreeManager {
    return this.manager;
  }

  /**
   * Creates the top-level, task-less worktree of the launcher through {@link createLauncherWorktree}. Its
   * `reserve` step emits `worktree.reserved`, so the projection tracks the worktree with no new scan. It
   * shares the manager, `realpath`, and `gitRunner` of this facade, so a later {@link adopt} derives the
   * same `worktreeId` and skips the worktree.
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
   * Delegates to {@link WorktreeManager.adopt}. It emits `worktree.adopted` for each on-disk worktree that
   * has no tracking entry, such as a nested worktree from a harness. A worktree that the launcher reserved
   * is already tracked, so `adopt` skips it.
   */
  adopt(repoRoot: string): Promise<AdoptResult> {
    return this.manager.adopt(repoRoot);
  }

  /**
   * Delegates to {@link WorktreeManager.reconcile}, which releases each reservation whose owner process is
   * provably dead. It stays reachable, so launcher activity cannot strand the reservation of a dead owner.
   */
  reconcile(): Promise<ReconcileResult> {
    return this.manager.reconcile();
  }

  /**
   * Runs an integration merge through the {@link serializeMerge} lease, which composes `merge_orchestrate`.
   * The lease allows at most one in-flight merge per `integrationRef`. The merge writes to the dispatch
   * context of this facade.
   *
   * It passes `dryRun: false` unless the caller asks for a dry run. The `serialize_merge` handler defaults
   * to dry run, but this method calls {@link serializeMerge} directly.
   */
  serializeIntegrationMerge(
    input: SerializeMergeInput,
    deps: SerializeMergeDeps = {},
  ): Promise<ToolResult> {
    return serializeMerge({ ...input, dryRun: input.dryRun ?? false }, this.ctx, deps);
  }
}

/** Builds a {@link LauncherWlm}, in the same call style as the other launcher building blocks. */
export function createLauncherWlm(deps: LauncherWlmDeps): LauncherWlm {
  return new LauncherWlm(deps);
}
