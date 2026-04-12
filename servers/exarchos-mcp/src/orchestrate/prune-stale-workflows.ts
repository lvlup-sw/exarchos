/**
 * Stale-workflow pruning.
 *
 * Two layers in this module:
 *
 * 1. `selectPruneCandidates` (T7) — a pure function. No IO, no clock,
 *    no shell-outs. Takes an entry list and returns candidates + exclusions.
 *    Tests inject a deterministic `now`.
 *
 * 2. `handlePruneStaleWorkflows` (T3) — the orchestrate handler that
 *    composes the pure selector with real IO: `handleList`, `handleCancel`,
 *    a `ctx.eventStore` for emitting `workflow.pruned`, and the safeguard
 *    backends in `prune-safeguards.ts`. All IO seams are wrapped in a
 *    `PruneHandlerDeps` bundle that defaults to production implementations,
 *    so tests can pass stubs instead of shelling out to `gh`/`git`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { EventType } from '../event-store/schemas.js';
import { handleList } from '../workflow/tools.js';
import { handleCancel } from '../workflow/cancel.js';
import { isTerminalPhase as baseIsTerminalPhase } from '../workflow/terminal-phases.js';
import { orchestrateLogger } from '../logger.js';
import { defaultSafeguards, type PruneSafeguards } from './prune-safeguards.js';
export type { PruneSafeguards } from './prune-safeguards.js';

// 7 days in minutes — matches the plan's v1 default threshold.
const DEFAULT_THRESHOLD_MINUTES = 10_080;

/**
 * Minimal subset of a workflow list entry needed for prune selection.
 * Mirrors the shape produced by `handleList` in `workflow/tools.ts`,
 * but only includes the fields this pure function actually reads so
 * fixtures stay lightweight.
 */
export interface WorkflowListEntry {
  featureId: string;
  workflowType: string;
  phase: string;
  stateFile: string;
  _checkpoint: {
    lastActivityTimestamp: string;
  };
}

export interface PruneConfig {
  /** Minutes of inactivity before a workflow is considered stale. Default 10080 (7 days). */
  thresholdMinutes?: number;
  /** When false, oneshot workflows are excluded from candidates. Default true. */
  includeOneShot?: boolean;
}

export interface PruneCandidate {
  featureId: string;
  workflowType: string;
  phase: string;
  /** Minutes since `_checkpoint.lastActivityTimestamp` at selection time. */
  stalenessMinutes: number;
}

export interface PruneExclusion {
  featureId: string;
  reason: 'terminal' | 'fresh' | 'oneshot-excluded';
}

export interface PruneSelection {
  candidates: PruneCandidate[];
  excluded: PruneExclusion[];
}

/**
 * Describes a `handleList` entry that failed structural validation. These
 * entries are excluded from prune selection entirely — the handler will
 * never consider them candidates, so a regressed `handleList` shape cannot
 * silently cause bulk-cancellation of active work (see T15 integration bug).
 *
 * `featureId` is optional because the entry may be missing that field —
 * it's the first thing we'd want to look up, so we include it when we have it.
 */
export interface PruneMalformedEntry {
  featureId?: string;
  reason: string;
}

/**
 * Compute minutes since a checkpoint's last activity.
 *
 * Pure helper — takes `now` as a parameter rather than calling
 * `Date.now()`, so callers (and tests) can inject a deterministic clock.
 */
function minutesSince(lastActivityTimestamp: string, now: Date): number {
  const last = new Date(lastActivityTimestamp).getTime();
  if (Number.isNaN(last)) return 0;
  const diffMs = Math.max(0, now.getTime() - last);
  return Math.floor(diffMs / (60 * 1000));
}

/** True if the entry has been inactive longer than `thresholdMinutes`. */
function isBeyondThreshold(
  checkpoint: { lastActivityTimestamp: string },
  thresholdMinutes: number,
  now: Date,
): boolean {
  return minutesSince(checkpoint.lastActivityTimestamp, now) > thresholdMinutes;
}

function isTerminalPhase(phase: string): boolean {
  return baseIsTerminalPhase(phase);
}

/**
 * Pure function: given a list of workflow entries and a config, partition
 * them into prune candidates and exclusions (with reasons).
 *
 * Exclusion precedence (highest first):
 *   1. terminal phase  → reason: 'terminal'
 *   2. oneshot filter  → reason: 'oneshot-excluded' (only when `includeOneShot === false`)
 *   3. freshness       → reason: 'fresh'
 *
 * @param entries  Workflow summaries (typically from `handleList`).
 * @param config   Threshold + oneshot toggle; all fields optional.
 * @param now      Injectable clock for deterministic tests. Defaults to `new Date()`.
 */
export function selectPruneCandidates(
  entries: WorkflowListEntry[],
  config: PruneConfig = {},
  now: Date = new Date(),
): PruneSelection {
  const thresholdMinutes = config.thresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES;
  const includeOneShot = config.includeOneShot ?? true;

  const candidates: PruneCandidate[] = [];
  const excluded: PruneExclusion[] = [];

  for (const entry of entries) {
    if (isTerminalPhase(entry.phase)) {
      excluded.push({ featureId: entry.featureId, reason: 'terminal' });
      continue;
    }

    if (!includeOneShot && entry.workflowType === 'oneshot') {
      excluded.push({ featureId: entry.featureId, reason: 'oneshot-excluded' });
      continue;
    }

    if (!isBeyondThreshold(entry._checkpoint, thresholdMinutes, now)) {
      excluded.push({ featureId: entry.featureId, reason: 'fresh' });
      continue;
    }

    candidates.push({
      featureId: entry.featureId,
      workflowType: entry.workflowType,
      phase: entry.phase,
      stalenessMinutes: minutesSince(entry._checkpoint.lastActivityTimestamp, now),
    });
  }

  return { candidates, excluded };
}

// ═══════════════════════════════════════════════════════════════════════════
// Handler (T3)
// ═══════════════════════════════════════════════════════════════════════════

// Window used when asking `hasRecentCommits`. The design locks this at 24h
// for v1; expose it as a constant so tests can see the contract even though
// the value isn't configurable through the public handler args yet.
const RECENT_COMMITS_WINDOW_HOURS = 24;

/**
 * Input args accepted by the handler. All fields optional with safe defaults:
 *   thresholdMinutes → 10080 (7 days)
 *   dryRun           → true   (refuses to mutate unless explicitly disabled)
 *   force            → false  (bypass safeguards)
 *   includeOneShot   → true
 *   now              → current time (injectable as ISO string for tests)
 */
export interface PruneHandlerArgs {
  thresholdMinutes?: number;
  dryRun?: boolean;
  force?: boolean;
  includeOneShot?: boolean;
  /** Test-only override for the selection clock. */
  now?: string;
}

/**
 * Injectable IO seams. Production wiring is `productionDeps(stateDir, ctx)`.
 * Tests construct their own instance and pass it as the 4th handler arg.
 */
export interface PruneHandlerDeps {
  handleList: (stateDir: string) => Promise<ToolResult>;
  handleCancel: (
    args: { featureId: string; reason?: string },
    stateDir: string,
  ) => Promise<ToolResult>;
  /** Reads the top-level branchName from a workflow state file. */
  readBranchName: (featureId: string, stateDir: string) => Promise<string | undefined>;
  safeguards: PruneSafeguards;
}

export interface PruneSkipped {
  featureId: string;
  /**
   * Why this candidate was skipped rather than pruned.
   * - `open-pr`              — safeguard: an open PR exists for the branch
   * - `active-branch`        — safeguard: commits landed on the branch
   *                            within the recency window
   *                            (user-facing name from the prune-workflows
   *                            skill and design doc; the implementation
   *                            detail — a `git log --since` window — is
   *                            on the `hasRecentCommits` backend)
   * - `cancel-failed`        — `handleCancel` returned `success: false`
   * - `event-append-failed`  — cancel succeeded but appending `workflow.pruned`
   *                            to the event store threw; the workflow is
   *                            cancelled on disk but NOT counted as pruned,
   *                            because the audit trail is incomplete
   */
  reason: 'open-pr' | 'active-branch' | 'cancel-failed' | 'event-append-failed';
  message?: string;
}

export interface PrunePruned {
  featureId: string;
  stalenessMinutes: number;
  skippedSafeguards?: string[];
}

export interface PruneHandlerResult {
  candidates: PruneCandidate[];
  skipped: PruneSkipped[];
  /**
   * Only present in apply mode. Dry-run returns omit this field entirely
   * rather than surfacing an empty array — it would misleadingly suggest
   * "nothing was pruned" instead of "nothing could have been pruned because
   * this was a preview". Matches the shape in the 2026-04-11 design.
   */
  pruned?: PrunePruned[];
  /**
   * `handleList` entries that failed structural validation (missing
   * `featureId`, `workflowType`, `phase`, or a parsable
   * `_checkpoint.lastActivityTimestamp`). Present when at least one entry
   * was rejected. Malformed entries are NEVER considered candidates or
   * pruned — this is fail-closed behavior: if `handleList` regresses, we
   * refuse to guess at identity/staleness rather than silently cancelling
   * active workflows. Operators should see this field and fix the upstream
   * shape.
   */
  malformed?: PruneMalformedEntry[];
}

/** Default branch-name reader: reads the state JSON and returns a top-level
 *  `branchName` field if present. Workflows without one get `undefined`,
 *  which short-circuits both safeguards in the handler. */
async function defaultReadBranchName(
  featureId: string,
  stateDir: string,
): Promise<string | undefined> {
  try {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const raw = await fs.readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const branchName = parsed.branchName;
    return typeof branchName === 'string' && branchName.length > 0 ? branchName : undefined;
  } catch {
    return undefined;
  }
}

/** Production dep bundle — real `handleList`/`handleCancel` + default safeguards. */
function productionDeps(_ctx?: DispatchContext): PruneHandlerDeps {
  return {
    handleList: (stateDir) => handleList({}, stateDir),
    handleCancel: (args, stateDir) =>
      handleCancel(
        { featureId: args.featureId, reason: args.reason ?? 'stale-prune' },
        stateDir,
        _ctx?.eventStore ?? null,
      ),
    readBranchName: defaultReadBranchName,
    safeguards: defaultSafeguards(),
  };
}

/**
 * Narrow `handleList`'s opaque payload to the entry shape this module needs.
 *
 * Fail-closed validation (F1, shepherd iter 2): every entry must supply a
 * non-empty `featureId`, non-empty `workflowType`, string `phase`, and a
 * parsable `_checkpoint.lastActivityTimestamp`. Entries missing any of
 * those fields are moved to a separate `malformed` bucket and excluded
 * from selection entirely.
 *
 * Earlier revisions coerced missing fields with defaults (`new Date(0)`,
 * `'feature'`, `'unknown'`). That meant a single upstream regression in
 * `handleList` — which already happened once, see the T15 integration
 * test — could silently classify every active workflow as "maximally
 * stale" and bulk-cancel them in apply mode. We now refuse to guess.
 */
function extractListEntries(result: ToolResult): {
  entries: WorkflowListEntry[];
  malformed: PruneMalformedEntry[];
} {
  if (!result.success || !Array.isArray(result.data)) {
    return { entries: [], malformed: [] };
  }

  const entries: WorkflowListEntry[] = [];
  const malformed: PruneMalformedEntry[] = [];

  for (const raw of result.data) {
    if (typeof raw !== 'object' || raw === null) {
      malformed.push({ reason: 'entry is not an object' });
      continue;
    }
    const obj = raw as Record<string, unknown>;

    // Capture featureId eagerly (even if invalid) so malformed reports can
    // reference *which* entry failed — critical for operators debugging
    // handleList regressions.
    const featureIdRaw = obj.featureId;
    const featureIdForReport =
      typeof featureIdRaw === 'string' && featureIdRaw.length > 0 ? featureIdRaw : undefined;

    if (typeof featureIdRaw !== 'string' || featureIdRaw.length === 0) {
      malformed.push({ reason: 'missing or empty featureId' });
      continue;
    }

    const workflowTypeRaw = obj.workflowType;
    if (typeof workflowTypeRaw !== 'string' || workflowTypeRaw.length === 0) {
      malformed.push({
        featureId: featureIdForReport,
        reason: 'missing or empty workflowType',
      });
      continue;
    }

    const phaseRaw = obj.phase;
    if (typeof phaseRaw !== 'string') {
      malformed.push({
        featureId: featureIdForReport,
        reason: 'missing or non-string phase',
      });
      continue;
    }

    const checkpointRaw = obj._checkpoint;
    if (typeof checkpointRaw !== 'object' || checkpointRaw === null) {
      malformed.push({
        featureId: featureIdForReport,
        reason: 'missing _checkpoint',
      });
      continue;
    }
    const checkpoint = checkpointRaw as Record<string, unknown>;

    const lastActivityTimestampRaw = checkpoint.lastActivityTimestamp;
    if (typeof lastActivityTimestampRaw !== 'string') {
      malformed.push({
        featureId: featureIdForReport,
        reason: 'missing _checkpoint.lastActivityTimestamp',
      });
      continue;
    }
    // Reject unparsable ISO strings — `new Date("not-a-date").valueOf()`
    // is NaN. If we accepted these, `minutesSince()` would return 0 via
    // its own NaN guard and the entry would be classified as fresh, which
    // is silent misclassification, not fail-closed.
    if (Number.isNaN(new Date(lastActivityTimestampRaw).valueOf())) {
      malformed.push({
        featureId: featureIdForReport,
        reason: 'unparsable _checkpoint.lastActivityTimestamp',
      });
      continue;
    }

    const stateFile = typeof obj.stateFile === 'string' ? obj.stateFile : '';

    entries.push({
      featureId: featureIdRaw,
      workflowType: workflowTypeRaw,
      phase: phaseRaw,
      stateFile,
      _checkpoint: { lastActivityTimestamp: lastActivityTimestampRaw },
    });
  }

  return { entries, malformed };
}

/**
 * Orchestrate-action handler for `prune_stale_workflows`.
 *
 * Pipeline:
 *   1. `handleList` → flatten entries
 *   2. `selectPruneCandidates` (pure) → candidates
 *   3. If dryRun → return candidates only (pruned field omitted)
 *   4. Otherwise, for each candidate:
 *      a. Read branchName from state (undefined skips safeguards)
 *      b. Unless `force`, evaluate `hasOpenPR` → `hasRecentCommits` in order
 *      c. On approval, invoke `handleCancel`
 *      d. On successful cancel, emit `workflow.pruned` via `ctx.eventStore`
 *   5. Return `{ candidates, skipped, pruned }`
 *
 * Deps are injected (4th arg) for testability; production callers omit it
 * and get `productionDeps(ctx)` with real `handleList`, `handleCancel`, and
 * `gh`/`git`-backed safeguards.
 */
// All safeguards, in evaluation order, echoed on the audit event when
// `force` bypasses them. The names here are the user-facing reason keys
// (matching the `prune-workflows` skill and design doc); internal backends
// may use different names (e.g. `hasRecentCommits` is the git-backed
// implementation for `active-branch`).
const ALL_SKIPPED_SAFEGUARDS = ['open-pr', 'active-branch'] as const;

/**
 * Per-candidate classification returned by {@link prunePruneCandidate}. The
 * main loop consumes this into `skipped` / `pruned` result arrays; the shape
 * mirrors the union so double-accounting is structurally impossible.
 */
type CandidateOutcome =
  | { kind: 'skipped'; entry: PruneSkipped }
  | { kind: 'pruned'; entry: PrunePruned };

/**
 * Apply-mode body for a single prune candidate. Evaluates safeguards, calls
 * cancel, and emits the `workflow.pruned` audit event. Returns exactly one
 * `CandidateOutcome` — either `skipped` (with a reason) or `pruned`. HIGH-2
 * fix: event-append failure records a distinct `event-append-failed` reason
 * and does NOT also push onto `pruned`.
 */
async function prunePruneCandidate(
  candidate: PruneCandidate,
  deps: PruneHandlerDeps,
  eventStore: NonNullable<DispatchContext['eventStore']>,
  force: boolean,
  stateDir: string,
): Promise<CandidateOutcome> {
  const branchName = await deps.readBranchName(candidate.featureId, stateDir);

  // Safeguard evaluation. `force` bypasses them entirely but records the
  // marker list on the emitted event for audit. A missing branchName also
  // short-circuits both checks (nothing to look up).
  if (!force && branchName !== undefined) {
    if (await deps.safeguards.hasOpenPR(candidate.featureId, branchName)) {
      return { kind: 'skipped', entry: { featureId: candidate.featureId, reason: 'open-pr' } };
    }
    if (await deps.safeguards.hasRecentCommits(branchName, RECENT_COMMITS_WINDOW_HOURS)) {
      return {
        kind: 'skipped',
        entry: { featureId: candidate.featureId, reason: 'active-branch' },
      };
    }
  }

  // Cancel. On failure, record in `skipped` and move on — partial batches
  // are acceptable per design (risk #4 in the plan).
  const cancelResult = await deps.handleCancel(
    { featureId: candidate.featureId, reason: 'stale-prune' },
    stateDir,
  );
  if (!cancelResult.success) {
    return {
      kind: 'skipped',
      entry: {
        featureId: candidate.featureId,
        reason: 'cancel-failed',
        ...(cancelResult.error?.message ? { message: cancelResult.error.message } : {}),
      },
    };
  }

  // Emit workflow.pruned audit event. If this throws, the cancel already
  // landed on disk but the audit trail is incomplete — we classify the
  // feature as `event-append-failed` and do NOT record it in `pruned`.
  // Previously we did both, which meant a single feature could appear in
  // two result arrays with contradictory semantics (HIGH-2).
  try {
    await eventStore.append(candidate.featureId, {
      type: 'workflow.pruned' as EventType,
      data: {
        featureId: candidate.featureId,
        stalenessMinutes: candidate.stalenessMinutes,
        triggeredBy: 'manual',
        ...(force ? { skippedSafeguards: [...ALL_SKIPPED_SAFEGUARDS] } : {}),
      },
    });
  } catch (err) {
    return {
      kind: 'skipped',
      entry: {
        featureId: candidate.featureId,
        reason: 'event-append-failed',
        message: `Pruned but event append failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  return {
    kind: 'pruned',
    entry: {
      featureId: candidate.featureId,
      stalenessMinutes: candidate.stalenessMinutes,
      ...(force ? { skippedSafeguards: [...ALL_SKIPPED_SAFEGUARDS] } : {}),
    },
  };
}

export async function handlePruneStaleWorkflows(
  args: PruneHandlerArgs,
  stateDir: string,
  ctx?: DispatchContext,
  deps: PruneHandlerDeps = productionDeps(ctx),
): Promise<ToolResult> {
  // ─── F2: up-front input validation ──────────────────────────────────────
  // We reject invalid inputs BEFORE touching `handleList`, cancel, or the
  // event store. A negative/NaN/Infinity `thresholdMinutes` or unparsable
  // `now` would otherwise skew selection semantics — in apply mode, a
  // `thresholdMinutes: -1` would classify every workflow as stale and
  // bulk-cancel them. Fail closed with a structured error instead.
  if (args.thresholdMinutes !== undefined) {
    const t = args.thresholdMinutes;
    if (
      typeof t !== 'number' ||
      !Number.isFinite(t) ||
      !Number.isInteger(t) ||
      t <= 0
    ) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `thresholdMinutes must be a positive integer (got: ${String(t)})`,
        },
      };
    }
  }
  if (args.now !== undefined) {
    if (typeof args.now !== 'string' || Number.isNaN(new Date(args.now).valueOf())) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `now must be a valid ISO datetime string (got: ${String(args.now)})`,
        },
      };
    }
  }

  // Apply validated/defaulted values. `thresholdMinutes` defaults to the
  // v1 spec default (7 days) when absent; `now` defaults to `new Date()`.
  const thresholdMinutes = args.thresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES;
  const includeOneShot = args.includeOneShot;
  const dryRun = args.dryRun ?? true;
  const force = args.force ?? false;
  const now = args.now ? new Date(args.now) : new Date();

  // Apply-mode precondition: we MUST have an eventStore to emit the
  // `workflow.pruned` audit event. Silently no-opping on the append (the
  // previous behavior via `ctx?.eventStore.append(...)`) would let the
  // cancel land on disk while the audit trail stayed blank — a contract
  // break. Return a structured error instead. (MEDIUM-1)
  if (!dryRun && !ctx?.eventStore) {
    return {
      success: false,
      error: {
        code: 'MISSING_CONTEXT',
        message:
          'prune-stale-workflows: ctx.eventStore is required in apply mode; refusing to cancel workflows without an audit trail',
      },
    };
  }

  // 1. Fetch the full workflow list.
  const listResult = await deps.handleList(stateDir);
  if (!listResult.success) {
    return {
      success: false,
      error: {
        code: 'PRUNE_LIST_FAILED',
        message: listResult.error?.message ?? 'handleList failed',
      },
    };
  }
  const { entries, malformed } = extractListEntries(listResult);

  // Loud warning when malformed entries are present: operators need to
  // see this in logs, not just in the return shape. Failing closed means
  // these entries won't be pruned — but if it's a systemic regression in
  // `handleList`, *every* entry may be malformed and nothing will be
  // pruned, which looks the same as "nothing to prune" unless we log.
  if (malformed.length > 0) {
    orchestrateLogger.warn(
      {
        action: 'prune_stale_workflows',
        malformedCount: malformed.length,
        firstMalformed: malformed[0],
      },
      'malformed handleList entries excluded from prune consideration',
    );
  }

  // 2. Pure selection.
  const { candidates } = selectPruneCandidates(
    entries,
    {
      thresholdMinutes,
      ...(includeOneShot !== undefined ? { includeOneShot } : {}),
    },
    now,
  );

  // 3. Dry run short-circuit. Intentionally omit `pruned` — see type
  // comment on PruneHandlerResult. Callers can distinguish dry-run from
  // apply mode by the presence/absence of the field.
  if (dryRun) {
    const result: PruneHandlerResult = {
      candidates,
      skipped: [],
      ...(malformed.length > 0 ? { malformed } : {}),
    };
    return { success: true, data: result };
  }

  // 4. Apply mode: classify each candidate via the per-candidate helper.
  const skipped: PruneSkipped[] = [];
  const pruned: PrunePruned[] = [];
  // Narrowed above — the early return guarantees `ctx.eventStore` exists.
  const eventStore = ctx!.eventStore!;

  for (const candidate of candidates) {
    const outcome = await prunePruneCandidate(candidate, deps, eventStore, force, stateDir);
    if (outcome.kind === 'skipped') {
      skipped.push(outcome.entry);
    } else {
      pruned.push(outcome.entry);
    }
  }

  const result: PruneHandlerResult = {
    candidates,
    skipped,
    pruned,
    ...(malformed.length > 0 ? { malformed } : {}),
  };
  return { success: true, data: result };
}
