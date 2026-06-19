// ─── handleMergeOrchestrate — top-level orchestrator handler (T11) ─────────
//
// DR-MO-1 (preflight) + DR-MO-2 (executor) — composes the merge preflight
// composer (T06/T07) with the executor handler (T15) under one coherent
// entry point.
//
// SCOPE — T11 covers the happy path; T12 adds the abort branch; T13 adds
// the dry-run short-circuit:
//   • run preflight via the injectable composer
//   • emit `merge.preflight` to the stream (direct append, NOT wrapped in
//     `gate.executed` — the dedicated schema (T03) is top-level so HSM
//     guards / observability can match on it directly)
//   • on preflight pass, delegate to `handleExecuteMerge` and surface its
//     `phase: 'completed'` result with the preflight payload attached.
//   • on preflight fail (T12), persist
//     `mergeOrchestrator: { phase: 'aborted', preflight, abortReason:
//     'preflight-failed' }` to workflow state and return a structured
//     `PREFLIGHT_FAILED` ToolResult WITHOUT invoking the executor.
//   • on `dryRun: true` (T13), short-circuit AFTER preflight emission but
//     BEFORE persistence/executor. Returns
//     `{ success: preflight.passed, data: { dryRun: true, preflight, phase } }`
//     where `phase` is `'pending'` on pass and `'aborted'` on fail. Dry-run
//     is observation-only: NEVER persists state (would leave a transient
//     phase that never resolves) and NEVER invokes the executor.
//
// Out of scope (handled in subsequent tasks):
//   • T14 — `args.resume` + concurrency retry.
//   • T20 — composite registration.
//
// The composer + executor are exposed as injectable adapters so tests can
// bypass the real `mergePreflight` (which shells out to git) and the real
// `handleExecuteMerge` (which talks to the VCS provider). In production,
// the composite dispatcher (T20) constructs the defaults from
// `ctx.projectConfig` + `ctx.stateDir`.
// ───────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import {
  mergePreflight as defaultMergePreflight,
  type GitExec,
  type GitExecResult,
  type MergePreflightArgs,
  type MergePreflightResult,
} from './pure/merge-preflight.js';
import {
  handleExecuteMerge as defaultHandleExecuteMerge,
  type HandleExecuteMergeInput,
} from './execute-merge.js';
import { buildMergeOrchestrateIdempotencyKey } from './merge-keys.js';
import { SequenceConflictError } from '../event-store/store.js';
import {
  readStateFile,
  writeStateFile,
  VersionConflictError,
  StateStoreError,
} from '../workflow/state-store.js';
import { ErrorCode } from '../workflow/schemas.js';
import { EXCLUDED_MERGE_PHASES } from '../workflow/hsm-definitions.js';
import {
  withStateRetry,
  MAX_STATE_RETRIES,
} from '../workflow/state-retry.js';
import {
  ConcurrencyError,
  StorageBusyError,
} from '../event-store/index.js';
import type { MergeOrchestratorState } from '../projections/merge-orchestrator/index.js';
// Side-effect import — registers `merge-orchestrator@v1` with `defaultRegistry`
// so the Wave 3 primitive (`AtomicAppender.decide`) can resolve the reducer
// by id when Phase A commits `merge.requested` (audit §F1.2 two-event split).
// Most production wiring already pulls in this barrel transitively via the
// rebuild/rehydrate paths, but importing it here makes the dependency
// explicit at the call site (mirrors the pattern in the migration test).
import '../projections/merge-orchestrator/index.js';

// ─── Args schema ───────────────────────────────────────────────────────────
//
// Note: this handler validates inputs via Zod (`safeParse` below) rather than
// the manual guard-clause pattern most other orchestrate handlers use. The
// deviation is deliberate — the merge orchestrator surface is rich (six
// fields, three of them booleans/enums with exact-value semantics, plus
// optional repoRoot) and is reachable through DI overrides that bypass the
// MCP registration boundary's Zod validation. Centralizing validation here
// keeps the contract enforceable at every entry point, including in-process
// test callers that wouldn't otherwise hit MCP. The schema is also
// reused by `cli.ts` as the source of truth for `exarchos
// merge-orchestrate` flag coercion (#1109 §2 user-visible parity), so a
// manual guard-clause sweep here would have to be duplicated in three
// places.

export const HandleMergeOrchestrateArgsSchema = z.object({
  featureId: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  taskId: z.string().optional(),
  // Required, no default — aligns with `merge_pr.strategy` (registry.ts)
  // per #1127, makes operator intent explicit in the event log (DIM-2),
  // and gives CLI/MCP user-visible parity (#1109 §2). Defaults at the
  // schema layer were dead code: every existing call site already passes
  // strategy explicitly.
  strategy: z.enum(['squash', 'rebase', 'merge']),
  /** Reserved for T13. Not honored in T11. */
  dryRun: z.boolean().optional(),
  /**
   * When true, the handler consults existing `mergeOrchestrator` state
   * (via the `readState` adapter / default state-store reader) before
   * dispatching. If the existing phase is terminal
   * (see {@link EXCLUDED_MERGE_PHASES}), the handler short-circuits and
   * returns the existing result with no new events / no executor call.
   * Otherwise (e.g. `pending`), it falls through to preflight + executor
   * as if it were a fresh dispatch.
   */
  resume: z.boolean().optional(),
  /** Optional override for the repository root used by the preflight gitExec. */
  repoRoot: z.string().optional(),
});

export type HandleMergeOrchestrateArgs = z.infer<typeof HandleMergeOrchestrateArgsSchema>;

// ─── DI override types (test-only; never crossed over the wire) ────────────

type PreflightAdapter = (args: MergePreflightArgs) => Promise<MergePreflightResult>;

type ExecuteMergeAdapter = (
  input: HandleExecuteMergeInput,
  ctx: DispatchContext,
) => Promise<ToolResult>;

/**
 * Persistence callback for the orchestrator's `mergeOrchestrator` state
 * field. T12 emits the `aborted` shape; further shapes (e.g. `pending`,
 * `executing`) may be added by future tasks.
 */
type OrchestratorPersistState = (
  state: {
    readonly phase: 'aborted';
    readonly preflight: MergePreflightResult;
    readonly abortReason: 'preflight-failed';
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly taskId?: string;
  },
) => Promise<void> | void;

/**
 * Read callback for the orchestrator's resume path (T14). Returns the
 * subset of workflow state the resume logic cares about, or `undefined`
 * if no state exists yet. Default implementation reads the state file
 * via `readStateFile`. Tests inject a mock to bypass the file system.
 */
type OrchestratorReadState = () => Promise<
  | {
      readonly mergeOrchestrator?: Record<string, unknown>;
    }
  | undefined
>;

export interface HandleMergeOrchestrateInput extends HandleMergeOrchestrateArgs {
  readonly preflight?: PreflightAdapter;
  readonly executeMerge?: ExecuteMergeAdapter;
  readonly gitExec?: GitExec;
  readonly persistState?: OrchestratorPersistState;
  readonly readState?: OrchestratorReadState;
}

// ─── Path normalization ────────────────────────────────────────────────────

/**
 * Resolve a filesystem path to its canonical form. Prefers `realpathSync`
 * so symlink segments are followed (matching git's internal canonicalization
 * of worktree paths), falling back to `path.resolve` if the path does not
 * exist on disk (rare: covers a caller passing a stale repoRoot before any
 * disk operation has had the chance to fail with a clearer error).
 */
function normalizePath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// ─── Default gitExec ───────────────────────────────────────────────────────

/**
 * Default `gitExec` for the preflight composer. Mirrors the convention used
 * by `handleExecuteMerge`: synchronous shell-out with a 120s ceiling, never
 * throws (we surface failures via `exitCode`).
 */
function defaultGitExec(repoRoot: string, args: readonly string[]): GitExecResult {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      timeout: 120_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    // Capture stderr separately so #1362 phase-1 diagnostics can read the
    // actual git error output (e.g., for `merge-base --is-ancestor` exit
    // codes != 0/1 indicating a real failure vs the documented "non-ancestor"
    // signal). Also fold stderr into stdout for backwards-compat with
    // existing callers that read `stdout` as the failure-message channel.
    const status = (err as { status?: number }).status;
    const rawStderr = (err as { stderr?: string | Buffer }).stderr;
    const rawStdout = (err as { stdout?: string | Buffer }).stdout;
    const stderr =
      typeof rawStderr === 'string' ? rawStderr : rawStderr?.toString('utf-8') ?? '';
    const stdoutOnly =
      typeof rawStdout === 'string' ? rawStdout : rawStdout?.toString('utf-8') ?? '';
    const message = [stdoutOnly, stderr].filter(Boolean).join('\n');
    return {
      stdout: message,
      stderr,
      exitCode: typeof status === 'number' ? status : 1,
    };
  }
}

/**
 * Default `persistState` for the orchestrator. Reads the workflow state
 * file at `<stateDir>/<featureId>.state.json`, sets the
 * `mergeOrchestrator` field to the supplied shape, and writes back
 * atomically. Mirrors the convention from `handleExecuteMerge`.
 */
function buildDefaultPersistState(
  featureId: string,
  stateDir: string,
): OrchestratorPersistState {
  return async (next) => {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    // Let `StateStoreError(STATE_NOT_FOUND)` propagate so the handler can
    // surface a structured `STATE_READ_FAILED` ToolResult. Inventing a
    // baseline state here would land an incomplete record on disk and
    // trip write-time schema validation anyway.
    const state = await readStateFile(stateFile);
    // Capture the CAS version BEFORE mutating so the write enforces
    // optimistic concurrency. Without `expectedVersion`, `writeStateFile`
    // skips the CAS check entirely, which makes the surrounding
    // `withStateRetry` non-functional and leaves concurrent writers free
    // to clobber each other. `_version` defaults to 1 for legacy files.
    const expectedVersion = (state as Record<string, unknown>)._version as number | undefined ?? 1;
    // REPLACE the `mergeOrchestrator` block instead of shallow-merging onto
    // any prior attempt. Spreading the previous object would carry stale
    // `mergeSha`, `rollbackSha`, or old failure metadata into a fresh
    // terminal write (e.g., `aborted` after a previous `executing`),
    // leaving contradictory state for resume/status consumers.
    const updated = {
      ...state,
      mergeOrchestrator: { ...next },
    };
    await writeStateFile(stateFile, updated as typeof state, { expectedVersion });
  };
}

/**
 * Default `readState` adapter. Reads the workflow state file at
 * `<stateDir>/<featureId>.state.json` and returns it (or `undefined` if
 * the file does not yet exist). Used by the T14 resume path.
 */
function buildDefaultReadState(
  featureId: string,
  stateDir: string,
): OrchestratorReadState {
  return async () => {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    try {
      const state = await readStateFile(stateFile);
      return state as unknown as { mergeOrchestrator?: Record<string, unknown> };
    } catch (err) {
      // Only treat "state file does not exist" as resumable absence — a
      // corrupt or unreadable file MUST surface so resume:true doesn't
      // silently degrade into a fresh dispatch and emit a duplicate
      // preflight/merge attempt.
      // `readStateFile` translates ENOENT into a StateStoreError with
      // ErrorCode.STATE_NOT_FOUND — match on that, not the underlying
      // NodeJS errno (which never escapes the state-store boundary).
      if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
        return undefined;
      }
      throw err;
    }
  };
}

// State-write retry (T14 / DR-MO-2): optimistic-concurrency on
// `VersionConflictError`. Extracted to a shared module in T29 — also used
// by `handleExecuteMerge`. See `workflow/state-retry.ts` for the contract.

/**
 * Derive a short, operator-facing reason string from a failed preflight
 * result. Order mirrors the precedence used by the pure composer:
 * ancestry > current-branch protection > worktree assertion > drift.
 */
function describePreflightFailure(preflight: MergePreflightResult): string {
  if (!preflight.ancestry.passed) {
    const missing = preflight.ancestry.missing ?? [];
    return missing.length > 0
      ? `ancestry missing: ${missing.join(', ')}`
      : 'ancestry not satisfied';
  }
  if (preflight.currentBranchProtection.blocked) {
    const branch = preflight.currentBranchProtection.currentBranch ?? 'unknown';
    return `current branch protected: ${branch}`;
  }
  if (!preflight.worktree.isMain) {
    return `not on main worktree (actual: ${preflight.worktree.actual})`;
  }
  if (!preflight.drift.clean) {
    if (preflight.drift.detachedHead) return 'working tree detached';
    if (preflight.drift.indexStale) return 'git index stale';
    const files = preflight.drift.uncommittedFiles;
    return files.length > 0
      ? `uncommitted changes: ${files.length} file(s)`
      : 'working tree drift';
  }
  return 'preflight failed';
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleMergeOrchestrate(
  input: HandleMergeOrchestrateInput,
  ctx: DispatchContext,
): Promise<ToolResult> {
  // Validate the externally-supplied args (DI hooks bypass the schema).
  const parsed = HandleMergeOrchestrateArgsSchema.safeParse({
    featureId: input.featureId,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    taskId: input.taskId,
    strategy: input.strategy,
    dryRun: input.dryRun,
    resume: input.resume,
    repoRoot: input.repoRoot,
  });
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `handleMergeOrchestrate: ${parsed.error.message}`,
      },
    };
  }
  const args = parsed.data;

  const preflightFn = input.preflight ?? defaultMergePreflight;
  const executeMergeFn = input.executeMerge ?? defaultHandleExecuteMerge;
  const gitExec = input.gitExec ?? defaultGitExec;
  const persistState =
    input.persistState ?? buildDefaultPersistState(args.featureId, ctx.stateDir);
  const readState =
    input.readState ?? buildDefaultReadState(args.featureId, ctx.stateDir);

  // ─── 0a. Target-worktree availability preflight (#1356) ──────────────────
  //
  // When the merge target branch is checked out in a SIBLING worktree of
  // the same repository, the executor's local `git merge` against the
  // target would fail with a confusing "fatal: '<branch>' is already
  // checked out at '<other-worktree-path>'", and worse — the executor
  // captures `rollbackSha` from the cwd's HEAD (which is on a different
  // branch), so a rollback would `git reset --keep` to the wrong commit.
  //
  // Detect this topology BEFORE any event emission or executor delegation
  // so the abort path:
  //   • does NOT fire a `merge.requested` event (Phase A intent)
  //   • does NOT fire a `merge.preflight` event
  //   • does NOT capture a wrong rollback SHA
  //   • does NOT touch workflow state on disk
  //
  // We parse `git worktree list --porcelain`, whose record shape is:
  //     worktree <absolute-path>
  //     HEAD <sha>
  //     branch refs/heads/<branchname>      (omitted for detached HEAD)
  //     <blank line separator>
  // If any record's branch equals our target AND its path is NOT the
  // repoRoot we're about to operate on, the topology is unsafe — abort.
  // Normalize repoRoot so the string comparison against `git worktree list`
  // output is robust on macOS / Windows. `git worktree list --porcelain`
  // emits symlink-resolved absolute paths (git canonicalizes internally),
  // so without realpath here the equality test below would false-negative
  // when the caller's cwd traverses a symlinked segment (a common case on
  // macOS where /var → /private/var, or developer-symlinked checkouts).
  // realpathSync requires the path to exist; fall back to resolve() if not.
  //
  // When `repoRoot` is not supplied, derive it from `git rev-parse
  // --show-toplevel` rather than `process.cwd()`. The cwd may be a subdir
  // of the repo (test runners frequently invoke vitest from
  // `servers/exarchos-mcp/` — a sub-package), in which case the
  // `git worktree list --porcelain` output (which emits the canonical
  // top-level path) would never equal cwd and the main worktree itself
  // would be misidentified as a sibling holding the target branch.
  // Falling back to cwd preserves the previous behavior when not inside
  // any git repo (rare; surfaces as a clean preflight skip rather than a
  // spurious abort).
  let derivedRoot = args.repoRoot;
  if (derivedRoot === undefined) {
    const topLevel = gitExec(process.cwd(), ['rev-parse', '--show-toplevel']);
    if (topLevel.exitCode === 0) {
      derivedRoot = topLevel.stdout.trim();
    } else {
      derivedRoot = process.cwd();
    }
  }
  const repoRoot = normalizePath(derivedRoot);
  const worktreeListResult = gitExec(repoRoot, ['worktree', 'list', '--porcelain']);
  if (worktreeListResult.exitCode === 0) {
    const targetRef = `refs/heads/${args.targetBranch}`;
    let currentPath: string | undefined;
    let siblingHoldingTarget: string | undefined;
    for (const rawLine of worktreeListResult.stdout.split('\n')) {
      const line = rawLine.trimEnd();
      if (line.startsWith('worktree ')) {
        // Normalize the path emitted by git so the equality test below
        // compares apples to apples regardless of separator normalization.
        currentPath = normalizePath(line.slice('worktree '.length));
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        if (ref === targetRef && currentPath !== undefined && currentPath !== repoRoot) {
          siblingHoldingTarget = currentPath;
          break;
        }
      } else if (line === '') {
        currentPath = undefined;
      }
    }
    if (siblingHoldingTarget !== undefined) {
      return {
        success: false,
        error: {
          code: 'PREFLIGHT_FAILED',
          message: `Target branch '${args.targetBranch}' is checked out in sibling worktree: ${siblingHoldingTarget}`,
        },
        data: {
          phase: 'aborted' as const,
          reason: 'target-checked-out-elsewhere' as const,
          siblingWorktreePath: siblingHoldingTarget,
        },
      };
    }
  }

  // ─── 0. Resume short-circuit (T14) ───────────────────────────────────────
  // When `resume: true`, consult existing `mergeOrchestrator` state. If the
  // phase is terminal (per EXCLUDED_MERGE_PHASES — `completed`, `rolled-back`,
  // `aborted`), return the prior result without re-emitting events or
  // re-invoking the executor. Non-terminal phases (e.g. `pending`) fall
  // through to a fresh preflight + executor run, which is safe because the
  // executor handlers are idempotent on already-merged target branches.
  //
  // When `resume` is falsy we deliberately skip the state read — fresh
  // dispatch semantics mean prior state must NOT influence the outcome.
  if (args.resume === true) {
    let existing: Awaited<ReturnType<OrchestratorReadState>>;
    try {
      existing = await readState();
    } catch (err) {
      // `readState` returns undefined for ENOENT (no prior state — fall
      // through to fresh dispatch). Anything else (corrupt file, IO error)
      // must surface — silently swallowing would let resume:true emit a
      // duplicate preflight/merge against an unreadable state file.
      return {
        success: false,
        error: {
          code: 'STATE_READ_FAILED',
          message: `Resume read failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    const merge = existing?.mergeOrchestrator;
    const phase = typeof merge?.phase === 'string' ? merge.phase : undefined;
    if (phase !== undefined && EXCLUDED_MERGE_PHASES.has(phase)) {
      // Terminal-phase resume: surface the recorded result verbatim. We
      // treat `completed` as success and any other terminal state
      // (`rolled-back`, `aborted`) as a structured failure so callers can
      // distinguish them.
      if (phase === 'completed') {
        return {
          success: true,
          data: { ...merge },
        };
      }
      return {
        success: false,
        error: {
          code: phase === 'aborted' ? 'PREFLIGHT_FAILED' : 'MERGE_ROLLED_BACK',
          message: `Resume: merge already in terminal phase '${phase}'`,
        },
        data: { ...merge },
      };
    }
    // Any non-terminal phase (`pending`, `executing`, or undefined) falls
    // through to a fresh preflight + executor run. The mid-run `executing`
    // case is the most subtle: a crash during a previous attempt left state
    // at `executing` with a `rollbackSha` pinned, but the merge itself may
    // or may not have applied. Re-running is safe because the underlying
    // VCS handlers are idempotent on already-merged branches and a
    // re-recorded rollback sha from the fresh `git rev-parse HEAD` will
    // reflect post-merge HEAD if the prior run did succeed.
  }

  // ─── 1. Run preflight ────────────────────────────────────────────────────
  let preflight: MergePreflightResult;
  try {
    preflight = await preflightFn({
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      gitExec,
      ...(args.repoRoot !== undefined ? { cwd: args.repoRoot } : {}),
    });
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'PREFLIGHT_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // ─── 2. Emit merge.preflight (direct append — see header note) ───────────
  // DR-MO-1 AC#1 / DR-MO-2: include the structured sub-results
  // (ancestry / currentBranchProtection / worktree / drift) so the event
  // log is self-sufficient for timeline reconstruction. Also surface
  // `failureReasons` when the preflight failed so observability and
  // operators see the same diagnostic returned in the ToolResult.
  //
  // #1303 (α-04): pass `idempotencyKey` (when `taskId` is present) and
  // `expectedSequence` (CAS on the stream high-water mark) so the substrate
  // guarantees from #1259 / #1323 reach this append site too. Same shape as
  // the α-02 wiring at `execute-merge.ts:340-387` for `merge.executed`:
  //   • idempotencyKey-dedup makes crash-replay safe — a retry after a
  //     mid-handler crash returns the original cached event rather than
  //     appending a duplicate `merge.preflight`.
  //   • `expectedSequence` enforces optimistic concurrency at the append
  //     boundary — two concurrent invocations against the same stream
  //     cannot land overlapping sequences without a typed conflict.
  const tailEventsPreflight = await ctx.eventStore.query(args.featureId);
  const expectedSequencePreflight =
    tailEventsPreflight.length > 0
      ? Math.max(...tailEventsPreflight.map((e) => e.sequence))
      : 0;
  // INV-8: always set an idempotency key (helper falls back to a
  // featureId-only shape when taskId is absent) so concurrent invocations
  // without a taskId still dedup at the substrate layer rather than racing
  // to append. Symmetric with the executed/completed/rollback sites in
  // execute-merge.ts.
  const appendOptionsPreflight: { idempotencyKey: string; expectedSequence: number } = {
    expectedSequence: expectedSequencePreflight,
    idempotencyKey: buildMergeOrchestrateIdempotencyKey(
      args.featureId,
      args.taskId,
      'merge.preflight',
    ),
  };
  try {
    await ctx.eventStore.append(
      args.featureId,
      {
        type: 'merge.preflight',
        data: {
          ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
          sourceBranch: args.sourceBranch,
          targetBranch: args.targetBranch,
          passed: preflight.passed,
          ancestry: preflight.ancestry,
          currentBranchProtection: preflight.currentBranchProtection,
          worktree: preflight.worktree,
          drift: preflight.drift,
          ...(preflight.passed
            ? {}
            : { failureReasons: [describePreflightFailure(preflight)] }),
          // #1362 phase 1 — thread the optional debug payload from the helper
          // through to the event so phase-2 analysis can read the persisted
          // ancestry-mismatch diagnostic. The helper only attaches `debug`
          // when `EXARCHOS_PREFLIGHT_DEBUG=1 && !ancestry.passed`; we double-
          // gate here on `ancestry.passed === false` so a future code path
          // (or a test fixture) that constructs a `PreflightResult` with
          // `debug` set on a PASSING preflight cannot leak the diagnostic
          // into a passing-preflight event. Defense-in-depth at the event-
          // sourcing boundary (INV-1).
          ...(preflight.debug !== undefined && preflight.ancestry?.passed === false
            ? { debug: preflight.debug }
            : {}),
        },
      },
      appendOptionsPreflight,
    );
  } catch (err) {
    // SequenceConflict means a concurrent invocation already advanced the
    // stream past our observed tail. The other side will have appended the
    // canonical `merge.preflight` (its own idempotency key dedups its own
    // retry) — surface a structured STATE_CONFLICT rather than letting a
    // raw substrate error escape past the handler boundary.
    if (err instanceof SequenceConflictError) {
      return {
        success: false,
        error: {
          code: 'STATE_CONFLICT',
          message: `merge.preflight append lost sequence race: expected=${err.expected} actual=${err.actual}`,
        },
      };
    }
    throw err;
  }

  // ─── 3. Dry-run short-circuit (T13) ──────────────────────────────────────
  // Dry-run is observation-only: preflight has already run and emitted, so
  // operators get the same gate signal as a real run, but we MUST NOT
  // persist `mergeOrchestrator` state (would leave a transient phase that
  // never resolves) and MUST NOT invoke the executor (would actually merge).
  if (args.dryRun === true) {
    if (preflight.passed) {
      return {
        success: true,
        data: {
          dryRun: true as const,
          preflight,
          phase: 'pending' as const,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'PREFLIGHT_FAILED',
        message: `Preflight failed: ${describePreflightFailure(preflight)}`,
      },
      data: {
        dryRun: true as const,
        preflight,
        phase: 'aborted' as const,
      },
    };
  }

  // ─── 4. Preflight-fail abort branch (T12) ────────────────────────────────
  if (!preflight.passed) {
    // Persist the abort to workflow state BEFORE returning so downstream
    // observers (HSM guards, status views) see the aborted phase even if
    // the caller drops the ToolResult on the floor. The executor must NOT
    // run on this path.
    //
    // T14: wrap in `withStateRetry` so concurrent writers (e.g. another
    // orchestrator process bumping the same workflow file) don't fail us
    // permanently on a single CAS conflict. After MAX_STATE_RETRIES the
    // VersionConflictError bubbles out and is mapped to STATE_CONFLICT.
    try {
      await withStateRetry(() =>
        Promise.resolve(
          persistState({
            phase: 'aborted',
            preflight,
            abortReason: 'preflight-failed',
            sourceBranch: args.sourceBranch,
            targetBranch: args.targetBranch,
            ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
          }),
        ),
      );
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return {
          success: false,
          error: {
            code: 'STATE_CONFLICT',
            message: `Workflow state version conflict after ${MAX_STATE_RETRIES} retries`,
          },
        };
      }
      // Surface other StateStoreErrors (notably STATE_NOT_FOUND if the
      // workflow's state file is missing) as structured failures rather
      // than letting them propagate as unhandled exceptions. The
      // `merge.preflight` event was already emitted, so projection rebuild
      // can still reconstruct the aborted phase from events alone.
      if (err instanceof StateStoreError) {
        return {
          success: false,
          error: {
            code: err.code === ErrorCode.STATE_NOT_FOUND ? 'STATE_READ_FAILED' : err.code,
            message: err.message,
          },
          data: {
            phase: 'aborted' as const,
            preflight,
          },
        };
      }
      throw err;
    }
    return {
      success: false,
      error: {
        code: 'PREFLIGHT_FAILED',
        message: `Preflight failed: ${describePreflightFailure(preflight)}`,
      },
      data: {
        phase: 'aborted' as const,
        preflight,
      },
    };
  }

  // ─── 4b. Phase A — durable INTENT (Wave 4 / audit §F1.2) ────────────────
  //
  // The two-event split: commit `merge.requested` purely under
  // `withStateRetry` BEFORE the executor's side effect fires. The decide
  // closure short-circuits idempotently when the merge-orchestrator
  // projection already shows `requested` / `executed` / `recovering` /
  // `completed`, so concurrent invocations (and OCC retries within a
  // single invocation) cannot land a duplicate `merge.requested`.
  //
  // The side effect (executor delegation in section 5 below) runs OUTSIDE
  // this retry boundary, so an OCC loss inside `decide` never re-fires the
  // executor's local git merge. The executor's `merge.executed` append is
  // the Phase C outcome record — the orchestrator does not emit a
  // separate terminal event (the `merge.completed` type referenced by the
  // projection is not yet registered in `event-store/schemas.ts`; out of
  // scope for Wave 4 per the prompt's "no new event types beyond
  // `merge.requested`" guard).
  //
  // Idempotency: derive `operationId` from `featureId` + `taskId` so two
  // concurrent invocations targeting the same feature/task converge on
  // one canonical event via the substrate's idempotency_claims row.
  // Without `taskId`, fall back to `featureId` alone — still stable
  // across retries of the same invocation, weaker against concurrent
  // dispatch but the state-check-in-decide short-circuit provides the
  // belt-and-suspenders layer.
  const operationId =
    args.taskId !== undefined
      ? `merge-requested:${args.featureId}:${args.taskId}`
      : `merge-requested:${args.featureId}`;
  const appender = ctx.eventStore.getAppender();
  try {
    await withStateRetry(() =>
      appender.decide<MergeOrchestratorState>(
        args.featureId,
        'merge-orchestrator@v1',
        (state) => {
          // Short-circuit on any phase past `preflight` (the projection's
          // current phase after section 2's `merge.preflight` fold). Any
          // forward-progress phase indicates a concurrent or replayed
          // invocation already recorded the intent; emit nothing so the
          // retry returns a `no-op` rather than a duplicate.
          if (
            state.phase === 'requested' ||
            state.phase === 'executed' ||
            state.phase === 'recovering' ||
            state.phase === 'completed'
          ) {
            return [];
          }
          return [
            {
              type: 'merge.requested',
              data: {
                sourceBranch: args.sourceBranch,
                targetBranch: args.targetBranch,
                strategy: args.strategy,
                ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
                featureId: args.featureId,
              },
              correlationId: operationId,
            },
          ];
        },
        // alwaysEnforceConsistency=false: the no-op branches above (state
        // already requested/executed/recovering/completed) intentionally
        // emit zero events. With the default-on tail re-read, a concurrent
        // merge.executed landing between the read and our empty return
        // would throw spurious ConcurrencyError on a path whose only job
        // was to confirm "already done". Disabling the empty-write check
        // makes the idempotent-recovery path safe under contention; the
        // event-emitting branch is unaffected because it actually appends.
        // Sentry #14059252/1.
        { operationId, alwaysEnforceConsistency: false },
      ),
    );
  } catch (err) {
    // Translate the Wave 3 typed errors to the orchestrator's existing
    // ToolResult shape (mirrors how the abort branch handles
    // VersionConflictError above). After `MAX_STATE_RETRIES` exhaustion
    // we surface a structured failure rather than letting the typed
    // error escape past the handler boundary.
    if (err instanceof ConcurrencyError) {
      return {
        success: false,
        error: {
          code: 'CONCURRENCY_CONFLICT',
          message: `merge.requested decide lost OCC race after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    if (err instanceof StorageBusyError) {
      return {
        success: false,
        error: {
          code: 'STORAGE_BUSY',
          message: `merge.requested decide hit storage contention after ${MAX_STATE_RETRIES} retries: ${err.message}`,
        },
      };
    }
    throw err;
  }

  // ─── 5. Delegate to executor ─────────────────────────────────────────────
  //
  // Phase B (audit §F1.2): the executor performs the local git merge — the
  // non-idempotent side effect. It runs OUTSIDE the Phase A retry
  // boundary above so OCC retries on `merge.requested` never re-fire the
  // merge. The executor itself emits `merge.executed` (its own Phase C
  // outcome record); the orchestrator does not duplicate that here.
  const execResult = await executeMergeFn(
    {
      featureId: args.featureId,
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      strategy: args.strategy,
      ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
    },
    ctx,
  );

  if (!execResult.success) {
    return execResult;
  }

  // ─── 6. Combine results ──────────────────────────────────────────────────
  const execData = execResult.data as {
    phase: 'completed';
    mergeSha: string;
    rollbackSha: string;
  };

  return {
    success: true,
    data: {
      phase: 'completed' as const,
      mergeSha: execData.mergeSha,
      rollbackSha: execData.rollbackSha,
      preflight,
    },
  };
}
