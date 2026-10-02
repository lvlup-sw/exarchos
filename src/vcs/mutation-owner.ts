/**
 * The typed owner of git and worktree mutation. `VcsMutationOwner` returns {@link EffectOutcome}
 * carriers under four contracts:
 *   1. Idempotency: a key with a recorded terminal replays that outcome and runs no second effect.
 *   2. Fencing: a request whose `epoch` is below the highest recorded epoch fails with
 *      {@link VcsStaleEpochError}.
 *   3. Convergence: the ledger records an intent before the effect and a terminal after it. The
 *      effects probe before they mutate, so a retry of an interrupted run converges.
 *   4. Dry-run: a dry-run request returns the plan and never calls the effect. The owner never
 *      infers this mode.
 *
 * Process effects go only through {@link spawnCommandSync}, and persistence only through the
 * injected {@link EventStore}. The module imports neither `node:child_process` nor `node:fs`.
 */

import {
  LIVE,
  effectIdempotencyKey,
  emissionRecorder,
  plannedDryRun,
  runEffect,
  succeeded,
  failed,
  toEffectError,
  records,
  replayedEvidence,
  type EffectMode,
  type EffectOutcome,
  type EffectPlan,
  type EmissionCondition,
  type EffectEmission,
  type RecordsEmissions,
} from '../dispatch/core/effect-carrier.js';
import type { EventStore } from '../events/store.js';
import type { EventType, WorkflowEvent } from '../events/schemas.js';
import { spawnCommandSync } from '../utils/process.js';

/** The dedicated stream carrying the VCS mutation intent/terminal ledger. */
export const VCS_MUTATION_STREAM = 'vcs-mutations';

/**
 * Durable intent, appended before the git or provider effect. This name and the two terminals below
 * are built-in types of the event catalog. The constants give the owner and the ledger readers one
 * spelling.
 */
export const VCS_REQUESTED = 'vcs.requested';
/** Durable success terminal, appended after the effect succeeds. */
export const VCS_EXECUTED = 'vcs.executed';
/** Durable failure terminal, appended after the effect fails. */
export const VCS_COMPENSATED = 'vcs.compensated';

/**
 * The ledger that the owner writes around each mutation, declared on the effect plan. The carrier
 * refuses to run the effect without a real appender, so the intent cannot be skipped. A reader can
 * see what a mutation records without a trace of the control flow.
 *
 * An intent with no terminal marks an interrupted run. The two terminals are mutually exclusive,
 * because one execution either returns or throws.
 */
export const VCS_LEDGER_EMISSIONS: RecordsEmissions = records(
  { event: VCS_REQUESTED, when: 'before' },
  { event: VCS_EXECUTED, when: 'on-success' },
  { event: VCS_COMPENSATED, when: 'on-failure' },
);

/**
 * The error for a stale-epoch VCS mutation. An owner with an epoch below the highest recorded
 * epoch lost ownership and must not mutate. It mirrors `StaleEpochError` in
 * `workflow/cancel-process-manager.ts`.
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
 * Rejects a mutation from a stale epoch. An epoch below the current epoch fails. An equal epoch
 * (the current owner) or a higher epoch (a takeover) passes.
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
 * Default real-git runner through {@link spawnCommandSync}, the cross-OS spawn primitive. It never
 * throws. A git failure gives a non-zero status with stderr, or with the spawn error message when
 * git did not start.
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

/**
 * The canonical git argv for a forced worktree removal. `verbs/worktree/manager.ts` and
 * `verbs/merge/local-git-merge.ts` have their own idempotency boundary, so they use these argv
 * helpers and not a second ledger. The census in `tools/conformance/src/vcs-ownership.ts` fails
 * on a worktree or branch mutation in a module that it does not declare.
 */
export function worktreeRemoveForceArgs(worktreePath: string): readonly string[] {
  return ['worktree', 'remove', '--force', worktreePath];
}

/** The canonical git argv for a forced branch deletion. */
export function branchDeleteForceArgs(branch: string): readonly string[] {
  return ['branch', '-D', branch];
}

/**
 * Force-removes a worktree with the argv of the owner through the transport of the caller. It
 * returns the result of the transport, so the caller keeps its own result shape.
 */
export function removeWorktreeForce<R>(
  run: (argv: readonly string[]) => R,
  worktreePath: string,
): R {
  return run(worktreeRemoveForceArgs(worktreePath));
}

/** Force-deletes a branch with the argv of the owner through the transport of the caller. */
export function deleteBranchForce<R>(
  run: (argv: readonly string[]) => R,
  branch: string,
): R {
  return run(branchDeleteForceArgs(branch));
}

/** One mutating VCS request. */
export interface VcsMutationRequest {
  /** The mutation family for the audit trail, for example `branch.create`. */
  readonly kind: string;
  /** Provider idempotency key — a duplicate key replays the recorded outcome. */
  readonly idempotencyKey: string;
  /** Monotonic fencing epoch of the requesting owner. */
  readonly epoch: number;
  /** Human-readable account of the effect, carried on the dry-run plan. */
  readonly description: string;
  /** The repair/compensation contract for this effect, when it has one. */
  readonly compensation?: string;
  /** Explicit mode. The default is live. */
  readonly mode?: EffectMode;
  /**
   * Reality probe for the replay of an `executed` terminal. When it returns `false`, the recorded
   * terminal no longer matches the world, so the owner skips the replay and runs the effect again.
   * When it is absent, the replay is unconditional. A `compensated` terminal never calls it.
   */
  readonly verifyReplay?: () => boolean;
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
 * Folds the ledger stream into the fencing epoch, the terminal for each key, and the set of
 * intents. Pure over the queried events.
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

export interface VcsMutationOwnerDeps {
  readonly eventStore: EventStore;
  /** Injectable git runner (default: real git via {@link spawnCommandSync}). */
  readonly gitRunner?: VcsGitRunner;
  /** Ledger stream override for test isolation. The default is {@link VCS_MUTATION_STREAM}. */
  readonly stream?: string;
}

/**
 * What the effect thunk produced, recorded so the terminal emission can carry it. The carrier gives
 * a sink only the emission and the plan.
 */
type CapturedEffect =
  | { readonly kind: 'success'; readonly value: Record<string, unknown> }
  | { readonly kind: 'failure'; readonly cause: unknown };

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

/** The single typed owner for git & worktree mutation. */
export class VcsMutationOwner {
  private readonly eventStore: EventStore;
  private readonly git: VcsGitRunner;
  private readonly stream: string;

  constructor(deps: VcsMutationOwnerDeps) {
    this.eventStore = deps.eventStore;
    this.git = deps.gitRunner ?? defaultVcsGitRunner;
    this.stream = deps.stream ?? VCS_MUTATION_STREAM;
  }

  private planFor(request: VcsMutationRequest): EffectPlan {
    const base = {
      effectClass: 'vcs' as const,
      owner: 'vcs-mutation-owner',
      description: request.description,
      idempotent: true,
      emits: VCS_LEDGER_EMISSIONS,
    };
    return request.compensation !== undefined
      ? { ...base, compensation: request.compensation }
      : base;
  }

  /** An explicit mode wins, else LIVE. Dry-run is never inferred. */
  private resolveMode(request: VcsMutationRequest): EffectMode {
    return request.mode ?? LIVE;
  }

  /**
   * Appends one ledger event. The claim key includes the stream, so a key cannot exist without the
   * stream it is claimed against. Claim rows from older code have no stream in the text, so they do
   * not collapse with new rows. The ledger fold is the primary guard, and the claim only covers a
   * crash between the fold and the append.
   */
  private async append(
    type: EventType,
    request: VcsMutationRequest,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const claim = effectIdempotencyKey(this.stream, `${type}:${request.idempotencyKey}`);
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
      { idempotencyKey: claim.value },
    );
  }

  /**
   * The payload of a declared emission, read back from {@link CapturedEffect}. The intent carries
   * only the common fields, because no result or failure exists when it is appended.
   */
  private emissionPayload(
    when: EmissionCondition,
    plan: EffectPlan,
    captured: CapturedEffect | undefined,
  ): Record<string, unknown> {
    if (when === 'on-success' && captured?.kind === 'success') {
      return { result: captured.value };
    }
    if (when === 'on-failure' && captured?.kind === 'failure') {
      return { error: toEffectError(plan, captured.cause).message };
    }
    return {};
  }

  /**
   * The general mutation primitive, in the order mode, fencing, replay, intent, effect, terminal.
   * A replay returns witness evidence, not a receipt, because no effect ran in this call.
   * The carrier drives the intent and the terminal as declared emissions. When a ledger append
   * fails, the carrier throws, and this method maps the throw to an owner error code. The write of
   * the failure terminal is best-effort, so if it fails, the caller still gets the effect error.
   *
   * `effect` must probe before it mutates. A retry after an interrupted run calls it again, and it
   * must do nothing when the target state exists.
   */
  async mutate<T extends Record<string, unknown>>(
    request: VcsMutationRequest,
    effect: () => Promise<T>,
  ): Promise<EffectOutcome<T>> {
    const plan = this.planFor(request);

    const mode = this.resolveMode(request);
    if (mode.kind === 'dry-run') {
      return plannedDryRun<T>(plan);
    }

    const fold = foldVcsLedger(await this.eventStore.query(this.stream));

    try {
      assertVcsEpochCurrent(fold.currentEpoch, request.epoch, request.idempotencyKey);
    } catch (cause) {
      return failed<T>({
        code: 'VCS_STALE_EPOCH',
        message: cause instanceof Error ? cause.message : 'stale epoch',
        cause,
      });
    }

    const recorded = fold.terminals.get(request.idempotencyKey);
    if (recorded !== undefined) {
      if (recorded.kind === 'executed') {
        if (request.verifyReplay === undefined || request.verifyReplay()) {
          return succeeded<T>(
            (recorded.result ?? {}) as T,
            replayedEvidence(VCS_EXECUTED, `ledger fold terminal for ${request.idempotencyKey}`),
          );
        }
      } else {
        return failed<T>({
          code: 'VCS_ALREADY_COMPENSATED',
          message:
            `request "${request.idempotencyKey}" already terminated as compensated` +
            (recorded.error !== undefined ? `: ${recorded.error}` : ''),
        });
      }
    }

    let captured: CapturedEffect | undefined;
    const observed = async (): Promise<T> => {
      try {
        const value = await effect();
        captured = { kind: 'success', value };
        return value;
      } catch (cause) {
        captured = { kind: 'failure', cause };
        throw cause;
      }
    };

    let failedWhen: EmissionCondition | undefined;
    const ledger = emissionRecorder(async (emission) => {
      try {
        await this.append(
          emission.event,
          request,
          this.emissionPayload(emission.when, plan, captured),
        );
      } catch (cause) {
        failedWhen = emission.when;
        throw cause;
      }
    });

    try {
      return await runEffect<T>(mode, plan, observed, ledger);
    } catch (cause) {
      if (failedWhen === 'before') {
        return failed<T>({
          code: 'VCS_INTENT_APPEND_FAILED',
          message: cause instanceof Error ? cause.message : 'intent append failed',
          cause,
        });
      }
      if (failedWhen === 'on-success') {
        return failed<T>({
          code: 'VCS_TERMINAL_APPEND_FAILED',
          message: cause instanceof Error ? cause.message : 'terminal append failed',
          cause,
        });
      }
      if (failedWhen === 'on-failure' && captured?.kind === 'failure') {
        return failed<T>(toEffectError(plan, captured.cause));
      }
      throw cause;
    }
  }

  private branchExists(repoRoot: string, branch: string): boolean {
    return (
      this.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)
        .status === 0
    );
  }

  /**
   * True when `git rev-parse --git-dir` succeeds at the path. A string compare against
   * `git worktree list` breaks on path canonicalization, such as Windows 8.3 short names.
   */
  private worktreeExists(worktreePath: string): boolean {
    return this.git.run(['rev-parse', '--git-dir'], worktreePath).status === 0;
  }

  /**
   * Creates a branch. An existing branch is a no-op (`created: false`). A recorded create replays
   * only while the branch exists.
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
      verifyReplay: () => this.branchExists(input.repoRoot, input.branch),
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
   * Deletes a branch. An absent branch is a no-op (`deleted: false`). A recorded delete replays only
   * while the branch is absent.
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
      verifyReplay: () => !this.branchExists(input.repoRoot, input.branch),
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
   * Creates a worktree and its branch. Both steps probe before they mutate. If `worktree add` fails
   * after this call created the branch, the call deletes that branch. The `vcs.executed` terminal
   * records only on full success.
   *
   * Worktrees are removed and requested again at the same path. Thus a recorded create replays only
   * while the worktree exists, and a removed worktree does not report success.
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
      verifyReplay: () => this.worktreeExists(input.worktreePath),
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
   * Removes a worktree. An absent worktree is a no-op (`removed: false`). A recorded remove replays
   * only while the worktree is absent, so a remove after a recreate runs the effect again.
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
      verifyReplay: () => !this.worktreeExists(input.worktreePath),
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
   * Runs a provider mutation, such as a PR create or merge, under the idempotency, fencing and
   * ledger contract of the git operations. A duplicate key replays the recorded outcome. An
   * interrupt between the effect and the terminal converges only when the provider call is
   * replay-safe.
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

  /**
   * Returns the idempotency keys with a durable intent and no terminal: the interrupted runs. A
   * retry of each original request converges, because the effect does nothing and the terminal
   * lands.
   */
  async openIntents(): Promise<readonly string[]> {
    const fold = foldVcsLedger(await this.eventStore.query(this.stream));
    return [...fold.intents].filter((key) => !fold.terminals.has(key));
  }
}
