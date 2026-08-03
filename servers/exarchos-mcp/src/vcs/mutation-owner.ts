/**
 * P04-05 — the single typed VCS mutation owner (EFF-010 / EFF-011).
 *
 * The unified remediation plan (PROGRAM-04) mandates that **every effect has one
 * typed owner, idempotency boundary, and repair or compensation contract**, and
 * that **VCS is a typed effect owner** alongside filesystem / process / install /
 * network. This module is that owner for git & worktree *mutation*: every
 * branch/worktree create+delete and every provider PR/merge routes through one
 * class that returns P04-01 {@link EffectOutcome} carriers and enforces four
 * contracts uniformly:
 *
 *   1. **Idempotency key** — each mutating request carries an `idempotencyKey`.
 *      The owner folds a durable ledger stream before acting; a key that already
 *      recorded a terminal outcome REPLAYS that outcome and performs no second
 *      effect. This is the exit-proof core: duplicate requests cannot create
 *      duplicate PRs, merges, branches, or worktrees.
 *
 *   2. **Fencing** — every request carries a monotonic `epoch`. A writer whose
 *      epoch is below the highest epoch the ledger has recorded has lost
 *      ownership (a newer owner took over) and is rejected with a typed
 *      {@link VcsStaleEpochError}. This reuses P04-02's cancel-saga fencing
 *      vocabulary (`assertEpochCurrent` / `StaleEpochError`) rather than
 *      inventing a second one.
 *
 *   3. **Compensation / convergence** — the ledger records a durable INTENT
 *      (`vcs.requested`) BEFORE the git effect and a TERMINAL (`vcs.executed` /
 *      `vcs.compensated`) AFTER it. The git effects are probe-before-mutate
 *      (idempotent), so an interrupted run — the observed real-world defect where
 *      `setup_worktree` left a worktree AND branch on disk with NO recorded
 *      event — converges on retry: the same key re-runs an effect that no-ops,
 *      then records the missing terminal. A multi-step create that fails partway
 *      (branch created, `worktree add` fails) compensates the branch it minted so
 *      no orphaned on-disk state survives a failure.
 *
 *   4. **Capability-aware fallback** — a caller that does not hold the
 *      shared-mutating capability set (or that is worktree-isolated) degrades to
 *      a typed dry-run outcome that performs NO mutation, rather than failing
 *      obscurely. Dry-run is structural: {@link runEffect} in dry-run mode never
 *      invokes the effect thunk.
 *
 * The owner is process-effect only via {@link spawnCommandSync} (the single
 * cross-OS spawn primitive) and persists exclusively through the injected
 * {@link EventStore}; it imports neither `node:child_process` nor `node:fs`
 * directly, so it sits under the existing `vcs/` process-owner rule in the
 * effect ledger with no ledger edit required.
 */

import type { Capability } from '../agents/capabilities.js';
import { capabilitiesForPosture } from '../capabilities/posture-mapping.js';
import {
  LIVE,
  plannedDryRun,
  runEffect,
  succeeded,
  failed,
  type EffectMode,
  type EffectOutcome,
  type EffectPlan,
} from '../core/effect-carrier.js';
import { getValidEventTypes, registerEventType } from '../event-store/schemas.js';
import type { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { spawnCommandSync } from '../utils/process.js';

// ─── Durable ledger vocabulary ───────────────────────────────────────────────

/** The dedicated stream carrying the VCS mutation intent/terminal ledger. */
export const VCS_MUTATION_STREAM = 'vcs-mutations';

/** Durable INTENT — appended BEFORE the git/provider effect fires. */
export const VCS_REQUESTED = 'vcs.requested';
/** Durable success TERMINAL — appended AFTER the effect succeeds. */
export const VCS_EXECUTED = 'vcs.executed';
/** Durable failure TERMINAL — appended after a compensated / failed effect. */
export const VCS_COMPENSATED = 'vcs.compensated';

const VCS_EVENT_TYPES: readonly string[] = [VCS_REQUESTED, VCS_EXECUTED, VCS_COMPENSATED];

/**
 * Register the three VCS-ledger event types via the event-store's runtime
 * registration seam (idempotent — only registers a name the allowlist does not
 * already carry). Using the seam avoids editing `event-store/schemas.ts`, the
 * same "registration seam, not source edit" posture P04-01's ledger asks for.
 */
export function ensureVcsMutationEventTypes(): void {
  const valid = new Set(getValidEventTypes());
  for (const name of VCS_EVENT_TYPES) {
    if (!valid.has(name)) {
      registerEventType(name, { source: 'auto' });
    }
  }
}

// ─── Typed fencing error (mirrors P04-02 cancel-saga StaleEpochError) ─────────

/**
 * A stale-epoch VCS mutation was rejected. The classic distributed-lock fencing
 * token: an owner holding an epoch below the highest the ledger recorded has
 * lost ownership to a newer owner and MUST NOT mutate. Mirrors
 * `workflow/cancel-process-manager.ts`'s `StaleEpochError` so the two fencing
 * surfaces share one vocabulary.
 */
export class VcsStaleEpochError extends Error {
  readonly code = 'VCS_STALE_EPOCH' as const;

  constructor(
    readonly writerEpoch: number,
    readonly currentEpoch: number,
    readonly idempotencyKey: string,
  ) {
    super(
      `VCS_STALE_EPOCH: writer epoch ${writerEpoch} is fenced out by current owner ` +
        `epoch ${currentEpoch} (key=${idempotencyKey})`,
    );
    this.name = 'VcsStaleEpochError';
  }
}

/**
 * Reject a mutation from a fenced-out (stale) epoch. A writer whose epoch is
 * below the current owner's has lost ownership and MUST NOT write; an epoch
 * equal to (the reigning owner) or above (a fresh takeover) is allowed.
 */
export function assertVcsEpochCurrent(
  currentEpoch: number,
  writerEpoch: number,
  idempotencyKey: string,
): void {
  if (writerEpoch < currentEpoch) {
    throw new VcsStaleEpochError(writerEpoch, currentEpoch, idempotencyKey);
  }
}

// ─── Capability model ────────────────────────────────────────────────────────

/**
 * The capability set a `shared-mutating` posture holds (`fs:read` + `fs:write` +
 * `shell:exec`). Sourced from the canonical posture→capability table so this
 * owner consumes the existing trust model rather than re-deriving it.
 */
const SHARED_MUTATING_CAPS: ReadonlySet<Capability> =
  capabilitiesForPosture('shared-mutating');

const WORKTREE_ISOLATION: Capability = 'isolation:worktree';

/**
 * Whether `capabilities` authorizes a live shared VCS mutation. A worktree/branch
 * mutation lands on the SHARED `.git`, so — mirroring
 * `resolver.ts`'s `enforceSharedMutatingGate` — a worktree-isolated caller is
 * denied, and a caller must hold every shared-mutating capability. A caller that
 * fails this degrades to a dry-run outcome (never an obscure failure).
 */
export function canMutateShared(capabilities: ReadonlySet<Capability>): boolean {
  if (capabilities.has(WORKTREE_ISOLATION)) return false;
  for (const cap of SHARED_MUTATING_CAPS) {
    if (!capabilities.has(cap)) return false;
  }
  return true;
}

// ─── Git runner seam ─────────────────────────────────────────────────────────

/** Captured result of one git invocation. Never throws — a failure is `status !== 0`. */
export interface VcsGitOutput {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable git runner. The default shells real git via the portable spawn primitive. */
export interface VcsGitRunner {
  run(args: readonly string[], cwd: string): VcsGitOutput;
}

/**
 * Default real-git runner: routes every git invocation through
 * {@link spawnCommandSync} (the single cross-OS spawn primitive — Windows `.cmd`
 * shim safe, #1623). Never throws; a git failure surfaces as a non-zero status
 * with stderr (or the spawn error message when git never launched).
 */
export const defaultVcsGitRunner: VcsGitRunner = {
  run(args: readonly string[], cwd: string): VcsGitOutput {
    const result = spawnCommandSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = result.stderr ?? '';
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: stderr || (result.error?.message ?? ''),
    };
  },
};

// ─── Request + result shapes ─────────────────────────────────────────────────

/** A single mutating VCS request. The four contracts (key/epoch/mode/description) are explicit. */
export interface VcsMutationRequest {
  /** Discriminates the mutation family for the audit trail (e.g. `branch.create`). */
  readonly kind: string;
  /** Provider idempotency key — a duplicate key replays the recorded outcome. */
  readonly idempotencyKey: string;
  /** Monotonic fencing epoch of the requesting owner. */
  readonly epoch: number;
  /** Human-readable account of the effect, carried on the dry-run plan. */
  readonly description: string;
  /** The repair/compensation contract for this effect, when it has one. */
  readonly compensation?: string;
  /** Explicit mode override; defaults to capability-resolved live/dry-run. */
  readonly mode?: EffectMode;
}

/** Outcome of a branch create. `created` is `false` when the branch already existed (idempotent). */
export interface BranchCreateResult extends Record<string, unknown> {
  readonly branch: string;
  readonly created: boolean;
}

/** Outcome of a branch delete. `deleted` is `false` when the branch was already absent. */
export interface BranchDeleteResult extends Record<string, unknown> {
  readonly branch: string;
  readonly deleted: boolean;
}

/** Outcome of an atomic branch+worktree create. */
export interface WorktreeCreateResult extends Record<string, unknown> {
  readonly worktreePath: string;
  readonly branch: string;
  readonly createdBranch: boolean;
  readonly createdWorktree: boolean;
}

/** Outcome of a worktree remove. `removed` is `false` when it was already absent. */
export interface WorktreeRemoveResult extends Record<string, unknown> {
  readonly worktreePath: string;
  readonly removed: boolean;
}

// ─── Ledger fold ─────────────────────────────────────────────────────────────

interface LedgerTerminal {
  readonly kind: 'executed' | 'compensated';
  readonly result: Record<string, unknown> | undefined;
  readonly error: string | undefined;
}

interface LedgerFold {
  readonly currentEpoch: number;
  readonly terminals: ReadonlyMap<string, LedgerTerminal>;
  readonly intents: ReadonlySet<string>;
}

function numberField(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = data?.[key];
  return typeof v === 'number' ? v : undefined;
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = data?.[key];
  return typeof v === 'string' ? v : undefined;
}

function recordField(
  data: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const v = data?.[key];
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Fold the ledger stream into the fencing epoch, the terminal-by-key map (the
 * idempotency cache), and the set of open intents. Pure over the queried events.
 */
export function foldVcsLedger(events: readonly WorkflowEvent[]): LedgerFold {
  let currentEpoch = 0;
  const terminals = new Map<string, LedgerTerminal>();
  const intents = new Set<string>();

  for (const event of events) {
    const data = event.data;
    const epoch = numberField(data, 'epoch');
    if (epoch !== undefined && epoch > currentEpoch) currentEpoch = epoch;

    const key = stringField(data, 'idempotencyKey');
    if (key === undefined) continue;

    if (event.type === VCS_REQUESTED) {
      intents.add(key);
    } else if (event.type === VCS_EXECUTED) {
      terminals.set(key, {
        kind: 'executed',
        result: recordField(data, 'result'),
        error: undefined,
      });
    } else if (event.type === VCS_COMPENSATED) {
      terminals.set(key, {
        kind: 'compensated',
        result: undefined,
        error: stringField(data, 'error'),
      });
    }
  }

  return { currentEpoch, terminals, intents };
}

// ─── The owner ───────────────────────────────────────────────────────────────

export interface VcsMutationOwnerDeps {
  readonly eventStore: EventStore;
  /** The requesting caller's capability set (drives the dry-run fallback). */
  readonly capabilities: ReadonlySet<Capability>;
  /** Injectable git runner (default: real git via {@link spawnCommandSync}). */
  readonly gitRunner?: VcsGitRunner;
  /** Ledger stream override (default {@link VCS_MUTATION_STREAM}); useful for test isolation. */
  readonly stream?: string;
}

/** A serializable failure raised by a git effect thunk (captured into an error carrier). */
export class VcsEffectError extends Error {
  constructor(
    readonly gitArgs: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${gitArgs.join(' ')} failed: ${stderr}`);
    this.name = 'VcsEffectError';
  }
}

/**
 * The single typed owner for git & worktree mutation. Construct one per caller
 * (its `capabilities` gate whether mutation runs live or degrades to dry-run).
 */
export class VcsMutationOwner {
  private readonly eventStore: EventStore;
  private readonly capabilities: ReadonlySet<Capability>;
  private readonly git: VcsGitRunner;
  private readonly stream: string;

  constructor(deps: VcsMutationOwnerDeps) {
    ensureVcsMutationEventTypes();
    this.eventStore = deps.eventStore;
    this.capabilities = deps.capabilities;
    this.git = deps.gitRunner ?? defaultVcsGitRunner;
    this.stream = deps.stream ?? VCS_MUTATION_STREAM;
  }

  private planFor(request: VcsMutationRequest): EffectPlan {
    const base = {
      effectClass: 'vcs' as const,
      owner: 'vcs-mutation-owner',
      description: request.description,
      idempotent: true,
    };
    return request.compensation !== undefined
      ? { ...base, compensation: request.compensation }
      : base;
  }

  /** Resolve the effective mode: an explicit override wins; otherwise capabilities decide. */
  private resolveMode(request: VcsMutationRequest): EffectMode {
    if (request.mode !== undefined) return request.mode;
    return canMutateShared(this.capabilities) ? LIVE : { kind: 'dry-run' };
  }

  private async append(
    type: string,
    request: VcsMutationRequest,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.eventStore.append(
      this.stream,
      {
        type,
        data: {
          kind: request.kind,
          idempotencyKey: request.idempotencyKey,
          epoch: request.epoch,
          ...extra,
        },
      },
      { idempotencyKey: `${type}:${request.idempotencyKey}` },
    );
  }

  /**
   * The general mutation primitive. Every named op is a thin wrapper. Enforces
   * capability fallback → fencing → idempotency replay → intent → effect →
   * terminal, returning a typed {@link EffectOutcome}.
   *
   * `effect` MUST be probe-before-mutate (idempotent): a convergence retry after
   * an interrupted run re-invokes it, and it must no-op when the target state
   * already exists.
   */
  async mutate<T extends Record<string, unknown>>(
    request: VcsMutationRequest,
    effect: () => Promise<T>,
  ): Promise<EffectOutcome<T>> {
    const plan = this.planFor(request);

    // 1. Capability-aware fallback: no shared-mutating authority → dry-run.
    //    Structural: the effect thunk is never reached in dry-run mode.
    const mode = this.resolveMode(request);
    if (mode.kind === 'dry-run') {
      return plannedDryRun<T>(plan);
    }

    const fold = foldVcsLedger(await this.eventStore.query(this.stream));

    // 2. Fencing: a stale-epoch owner is rejected before any effect.
    try {
      assertVcsEpochCurrent(fold.currentEpoch, request.epoch, request.idempotencyKey);
    } catch (cause) {
      return failed<T>({
        code: 'VCS_STALE_EPOCH',
        message: cause instanceof Error ? cause.message : 'stale epoch',
        cause,
      });
    }

    // 3. Idempotency: a recorded terminal replays with NO second effect.
    const recorded = fold.terminals.get(request.idempotencyKey);
    if (recorded !== undefined) {
      if (recorded.kind === 'executed') {
        return succeeded<T>((recorded.result ?? {}) as T);
      }
      return failed<T>({
        code: 'VCS_ALREADY_COMPENSATED',
        message:
          `request "${request.idempotencyKey}" already terminated as compensated` +
          (recorded.error !== undefined ? `: ${recorded.error}` : ''),
      });
    }

    // 4. Durable intent BEFORE the effect. If this append fails no effect ran, so
    //    there is nothing to converge — surface a clean error.
    try {
      await this.append(VCS_REQUESTED, request, {});
    } catch (cause) {
      return failed<T>({
        code: 'VCS_INTENT_APPEND_FAILED',
        message: cause instanceof Error ? cause.message : 'intent append failed',
        cause,
      });
    }

    // 5. Run the (idempotent) effect through the carrier — captures throws.
    const outcome = await runEffect<T>(mode, plan, effect);
    if (outcome.kind === 'error') {
      // Best-effort compensation record; failure here still leaves the intent
      // durable for a later reconcile.
      try {
        await this.append(VCS_COMPENSATED, request, { error: outcome.error.message });
      } catch {
        /* the durable intent already suffices for convergence */
      }
      return outcome;
    }
    if (outcome.kind === 'dry-run') {
      // Unreachable in `live` mode; kept for exhaustiveness.
      return outcome;
    }

    // 6. Success terminal. If THIS append fails, the effect already happened and
    //    the intent is durable — a retry with the same key converges (the effect
    //    no-ops and records the terminal). Surface the failure typed.
    try {
      await this.append(VCS_EXECUTED, request, { result: outcome.value });
    } catch (cause) {
      return failed<T>({
        code: 'VCS_TERMINAL_APPEND_FAILED',
        message: cause instanceof Error ? cause.message : 'terminal append failed',
        cause,
      });
    }

    return outcome;
  }

  // ─── git probes (read-only, idempotency helpers) ────────────────────────────

  private branchExists(repoRoot: string, branch: string): boolean {
    return (
      this.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)
        .status === 0
    );
  }

  private worktreeExists(worktreePath: string): boolean {
    // Ask git directly AT the candidate path rather than string-matching against
    // `git worktree list` output: worktree path canonicalization differs across
    // platforms (Windows 8.3 short names, symlink resolution, drive-letter case),
    // so a string compare is fragile. `git -C <path> rev-parse --git-dir` returns
    // status 0 iff the path is a live git worktree, and a non-existent path makes
    // the spawn fail (non-zero) — exactly the idempotency probe we need, with no
    // `node:fs` import (which would trip the effect ledger's `vcs/`-has-no-fs rule).
    return this.git.run(['rev-parse', '--git-dir'], worktreePath).status === 0;
  }

  // ─── named git mutations ────────────────────────────────────────────────────

  /**
   * Create a branch. Idempotent: an existing branch is a no-op (`created: false`).
   * Duplicate requests (same key) replay one recorded outcome — exactly one branch.
   */
  async createBranch(input: {
    readonly repoRoot: string;
    readonly branch: string;
    readonly base: string;
    readonly idempotencyKey: string;
    readonly epoch: number;
    readonly mode?: EffectMode;
  }): Promise<EffectOutcome<BranchCreateResult>> {
    const request: VcsMutationRequest = {
      kind: 'branch.create',
      idempotencyKey: input.idempotencyKey,
      epoch: input.epoch,
      description: `create branch ${input.branch} from ${input.base}`,
      compensation: 'delete the branch (git branch -D)',
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    };
    return this.mutate<BranchCreateResult>(request, async () => {
      const existed = this.branchExists(input.repoRoot, input.branch);
      if (!existed) {
        const r = this.git.run(['branch', input.branch, input.base], input.repoRoot);
        if (r.status !== 0) throw new VcsEffectError(['branch', input.branch, input.base], r.stderr);
      }
      return { branch: input.branch, created: !existed };
    });
  }

  /**
   * Delete a branch. Idempotent: an absent branch is a no-op (`deleted: false`).
   */
  async deleteBranch(input: {
    readonly repoRoot: string;
    readonly branch: string;
    readonly idempotencyKey: string;
    readonly epoch: number;
    readonly mode?: EffectMode;
  }): Promise<EffectOutcome<BranchDeleteResult>> {
    const request: VcsMutationRequest = {
      kind: 'branch.delete',
      idempotencyKey: input.idempotencyKey,
      epoch: input.epoch,
      description: `delete branch ${input.branch}`,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    };
    return this.mutate<BranchDeleteResult>(request, async () => {
      const existed = this.branchExists(input.repoRoot, input.branch);
      if (existed) {
        const r = this.git.run(['branch', '-D', input.branch], input.repoRoot);
        if (r.status !== 0) throw new VcsEffectError(['branch', '-D', input.branch], r.stderr);
      }
      return { branch: input.branch, deleted: existed };
    });
  }

  /**
   * Create a worktree AND its branch atomically-with-event. Both steps are
   * probe-before-mutate (idempotent); if `worktree add` fails after the branch
   * was minted, the freshly-created branch is COMPENSATED (deleted) so no
   * orphaned on-disk state survives a partial failure. The `vcs.executed`
   * terminal is recorded only on full success — the fix for the observed
   * `setup_worktree` non-atomicity defect. An interrupted run converges on retry.
   */
  async createWorktree(input: {
    readonly repoRoot: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly base: string;
    readonly idempotencyKey: string;
    readonly epoch: number;
    readonly mode?: EffectMode;
  }): Promise<EffectOutcome<WorktreeCreateResult>> {
    const request: VcsMutationRequest = {
      kind: 'worktree.create',
      idempotencyKey: input.idempotencyKey,
      epoch: input.epoch,
      description: `create worktree ${input.worktreePath} on branch ${input.branch}`,
      compensation:
        'remove the worktree (git worktree remove) and delete a branch minted for it',
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    };
    return this.mutate<WorktreeCreateResult>(request, async () => {
      const branchExisted = this.branchExists(input.repoRoot, input.branch);
      if (!branchExisted) {
        const r = this.git.run(['branch', input.branch, input.base], input.repoRoot);
        if (r.status !== 0) throw new VcsEffectError(['branch', input.branch, input.base], r.stderr);
      }

      const worktreeExisted = this.worktreeExists(input.worktreePath);
      if (!worktreeExisted) {
        const r = this.git.run(
          ['worktree', 'add', input.worktreePath, input.branch],
          input.repoRoot,
        );
        if (r.status !== 0) {
          // Compensate the branch we minted this call so a failed create leaves
          // NO orphaned on-disk state (the observed defect's inverse).
          if (!branchExisted) {
            this.git.run(['branch', '-D', input.branch], input.repoRoot);
          }
          throw new VcsEffectError(
            ['worktree', 'add', input.worktreePath, input.branch],
            r.stderr,
          );
        }
      }

      return {
        worktreePath: input.worktreePath,
        branch: input.branch,
        createdBranch: !branchExisted,
        createdWorktree: !worktreeExisted,
      };
    });
  }

  /**
   * Remove a worktree. Idempotent: an absent worktree is a no-op (`removed: false`).
   */
  async removeWorktree(input: {
    readonly repoRoot: string;
    readonly worktreePath: string;
    readonly idempotencyKey: string;
    readonly epoch: number;
    readonly mode?: EffectMode;
  }): Promise<EffectOutcome<WorktreeRemoveResult>> {
    const request: VcsMutationRequest = {
      kind: 'worktree.remove',
      idempotencyKey: input.idempotencyKey,
      epoch: input.epoch,
      description: `remove worktree ${input.worktreePath}`,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    };
    return this.mutate<WorktreeRemoveResult>(request, async () => {
      const existed = this.worktreeExists(input.worktreePath);
      if (existed) {
        const r = this.git.run(
          ['worktree', 'remove', '--force', input.worktreePath],
          input.repoRoot,
        );
        if (r.status !== 0) {
          throw new VcsEffectError(
            ['worktree', 'remove', '--force', input.worktreePath],
            r.stderr,
          );
        }
      }
      return { worktreePath: input.worktreePath, removed: existed };
    });
  }

  /**
   * Run a provider mutation (PR create, PR merge, remote merge, …) under the same
   * idempotency+fencing+ledger contract as the git ops. The `effect` is the
   * provider call; a duplicate key replays the recorded outcome so a retried
   * request produces exactly ONE PR / merge. The provider call itself need not be
   * idempotent — the owner's key check guarantees it runs at most once per key
   * (barring an interrupt between effect and terminal, which converges only if
   * the provider effect is itself replay-safe; providers should carry their own
   * marker, as `workflow/feedback.ts` does).
   */
  async runProviderMutation<T extends Record<string, unknown>>(
    input: {
      readonly kind: string;
      readonly description: string;
      readonly idempotencyKey: string;
      readonly epoch: number;
      readonly compensation?: string;
      readonly mode?: EffectMode;
    },
    effect: () => Promise<T>,
  ): Promise<EffectOutcome<T>> {
    const request: VcsMutationRequest = {
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      epoch: input.epoch,
      description: input.description,
      ...(input.compensation !== undefined ? { compensation: input.compensation } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    };
    return this.mutate<T>(request, effect);
  }

  // ─── repair / convergence ───────────────────────────────────────────────────

  /**
   * Report the idempotency keys with a durable INTENT but no TERMINAL — the
   * interrupted-run cohort. An operator/reconciler retries each with its original
   * request (the effect no-ops, the terminal lands) to converge. Exposed so the
   * "orphaned on-disk state without an event" hazard is observable and closeable.
   */
  async openIntents(): Promise<readonly string[]> {
    const fold = foldVcsLedger(await this.eventStore.query(this.stream));
    return [...fold.intents].filter((key) => !fold.terminals.has(key));
  }
}
