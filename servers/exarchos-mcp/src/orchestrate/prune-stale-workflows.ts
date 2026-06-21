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

import * as path from 'node:path';
import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { EventType } from '../event-store/schemas.js';
import { handleList } from '../workflow/tools.js';
import { handleCancel } from '../workflow/cancel.js';
import { readStateFile } from '../workflow/state-store.js';
import { isTerminalPhase as baseIsTerminalPhase } from '../workflow/terminal-phases.js';
import { orchestrateLogger } from '../logger.js';
import { defaultSafeguards, type PruneSafeguards } from './prune-safeguards.js';
import { getTopology } from '../topology/loader.js';
import type { Topology } from '../topology/phase-contract.js';
import { scoreEntryThroughTopology } from '../pruner/coordinator.js';
import type { StalenessState } from '../pruner/score.js';
export type { PruneSafeguards } from './prune-safeguards.js';

// 14 days in minutes — matches ResolvedProjectConfig.prune.staleAfterDays default.
const DEFAULT_THRESHOLD_MINUTES = 20_160;

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
  /**
   * C8 (#1117) — secondary staleness signal: ISO timestamp of the most-recent
   * `workflow.transition` event for the workflow. Captures "stuck in phase X
   * for N days" even when reads keep `lastActivityTimestamp` fresh. Optional
   * for backward compatibility; legacy entries fall back to single-signal
   * scoring on `_checkpoint.lastActivityTimestamp`.
   */
  phaseTransitionTimestamp?: string;
  /**
   * C8 (#1117) — secondary staleness signal: ISO timestamp of the latest
   * commit on the workflow's tracked branch (UTC seconds from
   * `git log -1 --format=%ct`, converted to ISO). Absence of activity within
   * the threshold window contributes a stale signal. Optional — workflows
   * without a tracked branch (and absent-branch readers) leave this
   * undefined; the selector treats undefined as "no evidence of branch
   * progress" rather than penalising the workflow.
   */
  branchActivityTimestamp?: string;
}

export interface PruneConfig {
  /** When false, oneshot workflows are excluded from candidates. Default true. */
  includeOneShot?: boolean;
  /** Phases to exclude from prune candidates. Entries in these phases are excluded with reason 'phase-excluded'. */
  phaseExclusions?: readonly string[];
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
  /**
   * Why the entry was excluded from prune candidates.
   * - `terminal`             — phase is a terminal node (completed/cancelled)
   * - `fresh`                — staleness contract verdict was "fresh"
   * - `oneshot-excluded`     — `config.includeOneShot === false` and entry is oneshot
   * - `phase-excluded`       — caller-supplied `config.phaseExclusions` matched
   * - `phase-not-in-topology` — entry's recorded phase is absent from the loaded
   *                            topology (e.g. topology.yaml renamed/removed the
   *                            phase after the workflow started). DIM-7
   *                            resilience: skip this entry rather than crashing
   *                            the batch on the scorer's throw.
   */
  reason: 'terminal' | 'fresh' | 'oneshot-excluded' | 'phase-excluded' | 'phase-not-in-topology';
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

function isTerminalPhase(phase: string): boolean {
  return baseIsTerminalPhase(phase);
}

/**
 * Pure function: given a list of workflow entries, a typed `Topology`,
 * and a config, partition entries into prune candidates and exclusions
 * (with reasons).
 *
 * Exclusion precedence (highest first):
 *   1. terminal phase  → reason: 'terminal'
 *   2. phase exclusion → reason: 'phase-excluded'
 *   3. oneshot filter  → reason: 'oneshot-excluded' (only when `includeOneShot === false`)
 *   4. freshness       → reason: 'fresh'
 *
 * #1334 (β-07, v2.10.0-preview.1): the multi-signal staleness verdict is
 * now read off the typed `PhaseContract` declared on the topology, via
 * `scoreEntryThroughTopology`. The orchestrator-side
 * `phaseStale && (lastActivityStale || branchInactive)` heuristic was
 * not expressible by the typed contract's `freshnessRequires:
 * 'all' | 'any'` reducer, so DR-7 (#1332) hard-cut the untyped scorer
 * path and this layer now delegates verdicts to the contract instead.
 * Per-phase policy lives in `topology.yaml`, not in this selector.
 *
 * @param entries  Workflow summaries (typically from `handleList`).
 * @param topology Loaded topology with per-phase staleness contracts.
 * @param config   Phase-exclusion + oneshot toggle; all fields optional. Per-phase
 *                 staleness thresholds live in `topology.yaml` (`staleness` blocks
 *                 with `freshnessRequires`) — the selector reads them via
 *                 `scoreEntryThroughTopology` and does not accept a global
 *                 `thresholdMinutes` override.
 * @param now      Injectable clock for deterministic tests. Defaults to `new Date()`.
 */
export function selectPruneCandidates(
  entries: WorkflowListEntry[],
  topology: Topology,
  config: PruneConfig = {},
  now: Date = new Date(),
): PruneSelection {
  const includeOneShot = config.includeOneShot ?? true;
  const phaseExclusionSet = config.phaseExclusions
    ? new Set(config.phaseExclusions)
    : undefined;

  const candidates: PruneCandidate[] = [];
  const excluded: PruneExclusion[] = [];

  for (const entry of entries) {
    if (isTerminalPhase(entry.phase)) {
      excluded.push({ featureId: entry.featureId, reason: 'terminal' });
      continue;
    }

    if (phaseExclusionSet?.has(entry.phase)) {
      excluded.push({ featureId: entry.featureId, reason: 'phase-excluded' });
      continue;
    }

    if (!includeOneShot && entry.workflowType === 'oneshot') {
      excluded.push({ featureId: entry.featureId, reason: 'oneshot-excluded' });
      continue;
    }

    // Sentry #1338 (HIGH): topology.yaml can rename or drop phases while
    // active workflows still reference the old name; without this guard,
    // `scoreEntryThroughTopology` throws on the first orphan-phase entry
    // and crashes the entire batch. Pre-check the phase so we can return
    // a structured `phase-not-in-topology` exclusion and continue with
    // the rest of the workflows. DIM-7 resilience; INV-5b spec-aligned
    // output contract (agent callers get structured results, not throws).
    if (topology.phases[entry.phase] === undefined) {
      excluded.push({ featureId: entry.featureId, reason: 'phase-not-in-topology' });
      continue;
    }

    // #1334 (β-07): score through the typed phase contract. The handler
    // pre-enriches entries with secondary signal timestamps so this layer
    // only needs to convert each ISO timestamp into minutes-since-now and
    // hand the resulting `StalenessState` to the contract reducer.
    const state: StalenessState = {
      lastActivityMinutes: minutesSince(
        entry._checkpoint.lastActivityTimestamp,
        now,
      ),
      ...(entry.phaseTransitionTimestamp !== undefined &&
      !Number.isNaN(new Date(entry.phaseTransitionTimestamp).valueOf())
        ? {
            phaseTransitionMinutes: minutesSince(
              entry.phaseTransitionTimestamp,
              now,
            ),
          }
        : {}),
      ...(entry.branchActivityTimestamp !== undefined &&
      !Number.isNaN(new Date(entry.branchActivityTimestamp).valueOf())
        ? {
            branchActivityMinutes: minutesSince(
              entry.branchActivityTimestamp,
              now,
            ),
          }
        : {}),
    };

    const { isStale } = scoreEntryThroughTopology(topology, entry.phase, state);

    if (!isStale) {
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
 *   thresholdMinutes → deprecated since #1334 (v2.10.0-preview.1); ignored.
 *                     Configure per-phase staleness in `topology.yaml`
 *                     `staleness` blocks. Still validated for shape so
 *                     legacy `-1` callers fail closed instead of silently
 *                     accepting an ignored value.
 *   dryRun           → true   (refuses to mutate unless explicitly disabled)
 *   force            → false  (bypass safeguards)
 *   includeOneShot   → true
 *   now              → current time (injectable as ISO string for tests)
 */
export interface PruneHandlerArgs {
  /**
   * @deprecated since #1334 (v2.10.0-preview.1). Per-phase staleness now lives
   * in `topology.yaml` `staleness` blocks; supplying this field emits a
   * deprecation warn and has no effect on candidate selection.
   */
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
  /**
   * C8 (#1117) — read the most-recent `workflow.transition` event timestamp
   * for a workflow. Returns `undefined` when the event store has no transition
   * events on that stream (or when querying fails). The handler enriches
   * `WorkflowListEntry`s with this value so `selectPruneCandidates` can apply
   * multi-signal staleness scoring without doing IO itself.
   */
  readPhaseTransitionTimestamp: (featureId: string) => Promise<string | undefined>;
  /**
   * C8 (#1117) — read the latest commit timestamp on a workflow's tracked
   * branch as an ISO string. Returns `undefined` when:
   *   - the workflow has no tracked branch
   *   - `git log` fails (no remote, branch missing, git not installed)
   * Workflows without a branch are not penalised: the selector treats
   * `undefined` as "no evidence of branch progress" but the phase-transition
   * gate prevents that from forcing a stale verdict on its own.
   */
  readBranchActivityTimestamp: (
    branchName: string | undefined,
  ) => Promise<string | undefined>;
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

/**
 * Per-entry diagnostic for a malformed handleList entry. Groups all validation
 * failures for a single entry into a `reasons` array so operators can fix
 * upstream regressions without round-tripping through repeated prune runs.
 */
export interface PruneDiagnosticEntry {
  featureId?: string;
  reasons: string[];
}

/**
 * Diagnostics payload attached to every prune response (DR-3, DR-10).
 * Always present — `malformedCount === 0` when all entries are valid.
 */
export interface PruneDiagnostics {
  malformedCount: number;
  malformedEntries: PruneDiagnosticEntry[];
  candidateCount: number;
  advisory?: string;
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
  /**
   * Diagnostics payload (DR-3, DR-10). Present in 'report' (default) and
   * 'include' modes. Omitted in 'skip' mode. When present,
   * `malformedCount === 0` when all entries pass validation. Includes
   * per-entry reasons and an advisory string when malformed entries exist.
   */
  diagnostics?: PruneDiagnostics;
  /** Present when candidates were truncated by maxBatchSize. */
  truncated?: boolean;
  /** Total candidate count before truncation. Present when `truncated === true`. */
  totalCandidates?: number;
}

/** Default branch-name reader: reads the state JSON and returns a top-level
 *  `branchName` field if present. Workflows without one get `undefined`,
 *  which short-circuits both safeguards in the handler. */
async function defaultReadBranchName(
  featureId: string,
  stateDir: string,
): Promise<string | undefined> {
  try {
    // Read via readStateFile (#1504): backend (SoT) in production, on-disk file
    // only on the no-backend (test/legacy) path. `branchName` rides the
    // passthrough state schema, so it survives both reads.
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const state = (await readStateFile(stateFile)) as unknown as Record<string, unknown>;
    const branchName = state.branchName;
    return typeof branchName === 'string' && branchName.length > 0 ? branchName : undefined;
  } catch {
    return undefined;
  }
}

/**
 * C8 (#1117) — production reader for the latest `workflow.transition` event
 * timestamp on a stream. Returns `undefined` when the stream has no
 * transition events or when the query throws (a query failure is treated as
 * "no signal", matching the safeguard convention elsewhere in this module).
 *
 * The `EventStore.query` filter accepts a `type` and a `limit`; we ask only
 * for the most recent transition rather than scanning the full history. The
 * store returns events in stream order, so the last element is the newest.
 */
function makeReadPhaseTransitionTimestamp(
  ctx?: DispatchContext,
): (featureId: string) => Promise<string | undefined> {
  if (!ctx?.eventStore) {
    return async () => undefined;
  }
  const eventStore = ctx.eventStore;
  return async (featureId: string) => {
    try {
      const events = await eventStore.query(featureId, {
        type: 'workflow.transition',
      });
      if (!Array.isArray(events) || events.length === 0) return undefined;
      const newest = events[events.length - 1];
      const ts = newest?.timestamp;
      return typeof ts === 'string' ? ts : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * C8 (#1117) — production reader for the latest commit timestamp on a
 * workflow's tracked branch. Reuses the `git log` shell-out pattern from
 * {@link defaultHasRecentCommits} in `prune-safeguards.ts` rather than
 * introducing a new VCS dependency. `--format=%ct` returns UTC seconds since
 * epoch, which we convert to an ISO timestamp so it composes with the other
 * signals.
 *
 * Returns `undefined` when:
 *   - `branchName` is absent or contains characters outside the safe
 *     git-ref alphabet
 *   - `git log` fails (unknown ref, git not installed, timeout)
 */
async function defaultReadBranchActivityTimestamp(
  branchName: string | undefined,
): Promise<string | undefined> {
  if (!branchName) return undefined;
  // Same allowed-character guard `prune-safeguards.ts` uses before
  // embedding the branch name in a shell argument. Refuse to run git
  // against suspicious refs rather than passing them through.
  if (!/^[A-Za-z0-9/_.\-]+$/.test(branchName) || branchName.includes('..')) {
    return undefined;
  }
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    // execFile (not execSync) so that handlePruneStaleWorkflows's
    // Promise.all over per-workflow readers does not block the event loop.
    // Args are passed as an array — branchName is regex-validated above so
    // shell metacharacters can't reach the spawned process either way.
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%ct', `refs/heads/${branchName}`],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const output = stdout.trim();
    if (!output) return undefined;
    const epochSeconds = Number.parseInt(output, 10);
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return undefined;
    return new Date(epochSeconds * 1000).toISOString();
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
    readPhaseTransitionTimestamp: makeReadPhaseTransitionTimestamp(_ctx),
    readBranchActivityTimestamp: defaultReadBranchActivityTimestamp,
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

  // Per-phase staleness thresholds are now sourced from `topology.yaml`
  // (`staleness` blocks with `freshnessRequires`) — #1334 made the typed
  // PhaseContract the single source of staleness policy. The legacy
  // `args.thresholdMinutes` / `ctx.projectConfig.prune.staleAfterDays`
  // overrides are still validated above (to reject -1, NaN, etc.) but
  // are no longer threaded into the selector. Emit a deprecation warn
  // when an explicit caller-side override is supplied so operators see
  // why their tuning is ignored and can migrate the threshold into
  // `topology.yaml`. DIM-1: single source of truth; INV-5b: honest contract.
  const pruneConfig = ctx?.projectConfig?.prune;
  if (args.thresholdMinutes !== undefined || pruneConfig?.staleAfterDays !== undefined) {
    orchestrateLogger.warn(
      {
        action: 'prune_stale_workflows',
        argsThresholdMinutes: args.thresholdMinutes,
        configStaleAfterDays: pruneConfig?.staleAfterDays,
      },
      'prune-stale-workflows: `thresholdMinutes` / `prune.staleAfterDays` are deprecated and ignored since #1334 (v2.10.0-preview.1); per-phase staleness now lives in topology.yaml `staleness` blocks',
    );
  }
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

  // requireDryRun enforcement (DR-4): when config requires a prior dry-run
  // before apply mode, check the event store for a recent prune.diagnostics
  // event. If none found, reject with a structured error. Skip enforcement
  // when eventStore is unavailable (already guarded above) or when the
  // eventStore lacks a `query` method (e.g., minimal test stubs).
  if (
    !dryRun &&
    pruneConfig?.requireDryRun === true &&
    ctx?.eventStore &&
    typeof (ctx.eventStore as unknown as Record<string, unknown>).query === 'function'
  ) {
    try {
      const recentDiagnostics = await (
        ctx.eventStore as unknown as {
          query: (
            streamId: string,
            filters: { type: string; limit: number },
          ) => Promise<unknown[]>;
        }
      ).query('_prune', { type: 'prune.diagnostics', limit: 1 });
      if (!Array.isArray(recentDiagnostics) || recentDiagnostics.length === 0) {
        return {
          success: false,
          error: {
            code: 'DRY_RUN_REQUIRED',
            message:
              'Apply mode requires a prior dry-run. Run with dryRun: true first.',
          },
        };
      }
    } catch {
      // If querying the event store fails, skip enforcement rather than
      // blocking prune operations. The enforcement is best-effort.
    }
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

  // Build diagnostics from the malformed entries (DR-3, DR-10). Each
  // PruneMalformedEntry maps 1:1 to a PruneDiagnosticEntry — the per-entry
  // reason string becomes the single element in a `reasons` array so the
  // shape supports future multi-reason grouping without a breaking change.
  const diagnosticEntries: PruneDiagnosticEntry[] = malformed.map((m) => ({
    ...(m.featureId !== undefined ? { featureId: m.featureId } : {}),
    reasons: [m.reason],
  }));

  // malformedHandling mode (DR-4). Controls how malformed entries interact
  // with the candidate pipeline and response shape:
  //   - 'report' (default): diagnostics surfaced, malformed excluded from candidates
  //   - 'include': malformed entries promoted to candidates with stalenessMinutes=Infinity
  //   - 'skip': malformed silently excluded, diagnostics omitted from response
  const malformedHandling = pruneConfig?.malformedHandling ?? 'report';

  // #1334 (β-07/β-08): load the typed topology for staleness scoring.
  // The selector now reads per-phase `PhaseContract`s off the topology
  // and delegates verdicts to `scoreEntryThroughTopology`. The CLI fast
  // path (e.g. running `prune` outside a fully-bootstrapped MCP server)
  // may invoke this handler before the lifecycle has called
  // `loadTopology()`. Rather than letting the loader's "Topology not
  // loaded" throw escape and surface as an unhandled rejection, return
  // a structured `{ aborted: true, reason: 'topology_not_loaded' }`
  // envelope and emit a warning log so operators see why the prune ran
  // produced no candidates. Field is `aborted` (not `skipped`) so it
  // doesn't collide with `PruneHandlerResult.skipped: PruneSkipped[]` —
  // INV-5b spec-aligned output contract.
  let topologyForSelection: Topology;
  try {
    topologyForSelection = getTopology();
  } catch (err) {
    const reason = 'topology_not_loaded';
    orchestrateLogger.warn(
      {
        action: 'prune_stale_workflows',
        reason,
        message: err instanceof Error ? err.message : String(err),
      },
      'prune skipped: topology not loaded',
    );
    return {
      success: true,
      data: {
        aborted: true,
        reason,
      },
    };
  }

  // 1a. C8 (#1117): enrich each entry with secondary staleness signals
  // BEFORE pure selection. The selector stays IO-free; the handler is the
  // only layer that touches the event store / git. Failures on individual
  // entries fall back to `undefined`, which the selector treats as "no
  // evidence of progress" without bypassing the phase-stale gate.
  const enrichedEntries: WorkflowListEntry[] = await Promise.all(
    entries.map(async (entry) => {
      const [phaseTransitionTimestamp, branchName] = await Promise.all([
        deps.readPhaseTransitionTimestamp(entry.featureId),
        deps.readBranchName(entry.featureId, stateDir),
      ]);
      const branchActivityTimestamp = await deps.readBranchActivityTimestamp(
        branchName,
      );
      return {
        ...entry,
        ...(phaseTransitionTimestamp !== undefined
          ? { phaseTransitionTimestamp }
          : {}),
        ...(branchActivityTimestamp !== undefined
          ? { branchActivityTimestamp }
          : {}),
      };
    }),
  );

  // 2. Pure selection. #1334 (β-07): topology now drives staleness verdicts
  // through the typed `PhaseContract`. The handler retrieves the loaded
  // topology via `getTopology()`; if the loader has not run, the
  // accessor throws and β-08 turns that into a structured skip envelope.
  const topology = topologyForSelection;
  const { candidates: selectedCandidates } = selectPruneCandidates(
    enrichedEntries,
    topology,
    {
      ...(includeOneShot !== undefined ? { includeOneShot } : {}),
      ...(pruneConfig?.phaseExclusions ? { phaseExclusions: pruneConfig.phaseExclusions } : {}),
    },
    now,
  );

  // 2a. malformedHandling='include': promote malformed entries to candidates
  let rawCandidates = selectedCandidates;
  if (malformedHandling === 'include' && malformed.length > 0) {
    const malformedCandidates: PruneCandidate[] = malformed
      .filter((m) => m.featureId !== undefined)
      .map((m) => ({
        featureId: m.featureId!,
        workflowType: 'unknown',
        phase: 'unknown',
        stalenessMinutes: Infinity,
      }));
    rawCandidates = [...selectedCandidates, ...malformedCandidates];
  }

  // 2b. maxBatchSize cap — sort by staleness descending (oldest first)
  // and truncate to the configured limit. When truncated, add markers
  // to the response so callers know the full scope.
  const maxBatchSize = pruneConfig?.maxBatchSize;
  const totalCandidates = rawCandidates.length;
  let candidates = rawCandidates;
  let truncated = false;

  if (maxBatchSize !== undefined && rawCandidates.length > maxBatchSize) {
    truncated = true;
    // Sort descending by stalenessMinutes (oldest/most stale first)
    candidates = [...rawCandidates]
      .sort((a, b) => b.stalenessMinutes - a.stalenessMinutes)
      .slice(0, maxBatchSize);
  }

  // Build the diagnostics object — present in 'report' and 'include' modes,
  // omitted in 'skip' mode.
  const diagnostics: PruneDiagnostics | undefined =
    malformedHandling === 'skip'
      ? undefined
      : {
          malformedCount: malformed.length,
          malformedEntries: diagnosticEntries,
          candidateCount: candidates.length,
          ...(malformed.length > 0
            ? {
                advisory: malformedHandling === 'include'
                  ? `${malformed.length} handleList entries failed structural validation and were promoted into candidates. Inspect the malformedEntries for details.`
                  : `${malformed.length} handleList entries failed structural validation and were excluded from prune consideration. Inspect the malformedEntries for details.`,
              }
            : {}),
        };

  // Emit prune.diagnostics event (fire-and-forget). Always emitted when
  // an eventStore is available and diagnostics are not suppressed — even
  // when malformedCount is 0, so dashboards and audit queries can track
  // that a prune evaluation ran.
  if (ctx?.eventStore && diagnostics) {
    ctx.eventStore
      .append('_prune', {
        type: 'prune.diagnostics' as EventType,
        data: {
          malformedCount: diagnostics.malformedCount,
          candidateCount: diagnostics.candidateCount,
          malformedEntries: diagnostics.malformedEntries,
          ...(diagnostics.advisory ? { advisory: diagnostics.advisory } : {}),
        },
      })
      .catch(() => {
        // Fire-and-forget: diagnostics event emission failure must not
        // affect the prune pipeline outcome.
      });
  }

  // 3. Dry run short-circuit. Intentionally omit `pruned` — see type
  // comment on PruneHandlerResult. Callers can distinguish dry-run from
  // apply mode by the presence/absence of the field.
  if (dryRun) {
    const result = {
      candidates,
      skipped: [],
      ...(diagnostics ? { diagnostics } : {}),
      ...(truncated ? { truncated: true, totalCandidates } : {}),
      ...(malformed.length > 0 && malformedHandling !== 'skip' ? { malformed } : {}),
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

  const result = {
    candidates,
    skipped,
    pruned,
    ...(diagnostics ? { diagnostics } : {}),
    ...(truncated ? { truncated: true, totalCandidates } : {}),
    ...(malformed.length > 0 && malformedHandling !== 'skip' ? { malformed } : {}),
  };
  return { success: true, data: result };
}
