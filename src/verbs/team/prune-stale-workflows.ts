/**
 * Prunes stale workflows. `selectPruneCandidates` is pure: it takes the entry list and an injected
 * `now`, and returns candidates and exclusions. `handlePruneStaleWorkflows` composes it with real IO:
 * `handleList`, `handleCancel`, the event store for `workflow.pruned`, and the safeguards in
 * `prune-safeguards.ts`. The IO seams sit in a `PruneHandlerDeps` bundle, so tests can pass stubs.
 */

import * as path from 'node:path';
import type { ToolResult } from '../../format.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { EventType } from '../../events/schemas.js';
import { handleList } from '../../workflow/tools.js';
import { handleCancel } from '../../workflow/cancel.js';
import { readStateFile } from '../../workflow/state-store.js';
import { isTerminalPhase as baseIsTerminalPhase } from '../../workflow/terminal-phases.js';
import { orchestrateLogger } from '../../logger.js';
import { defaultSafeguards, type PruneSafeguards } from './prune-safeguards.js';
import { resolveStalenessTopology, type StalenessScope } from '../../workflow/topology/builtin.js';
import type { Topology } from '../../workflow/topology/phase-contract.js';
import { scoreEntryThroughTopology } from '../../pruner/coordinator.js';
import type { StalenessState } from '../../pruner/score.js';
export type { PruneSafeguards } from './prune-safeguards.js';

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
   * A second staleness signal: the ISO time of the latest `workflow.transition` event. It shows a
   * workflow stuck in one phase while reads keep `lastActivityTimestamp` fresh. An entry without it
   * uses only `_checkpoint.lastActivityTimestamp`.
   */
  phaseTransitionTimestamp?: string;
  /**
   * A second staleness signal: the ISO time of the latest commit on the tracked branch, from
   * `git log -1 --format=%ct`. It is undefined for a workflow with no tracked branch, and the selector
   * then does not count it against the workflow.
   */
  branchActivityTimestamp?: string;
}

export interface PruneConfig {
  /** When false, oneshot workflows are excluded from candidates. Default true. */
  includeOneShot?: boolean;
  /** Phases to exclude from prune candidates. Entries in these phases are excluded with reason 'phase-excluded'. */
  phaseExclusions?: readonly string[];
  /**
   * The workflow types the topology covers. When set, an entry of any other
   * type is excluded with reason 'workflow-type-not-in-topology'. When
   * absent, every workflow type is scored.
   */
  coveredWorkflowTypes?: ReadonlySet<string>;
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
   * Why the selector excluded the entry:
   * - `terminal`: the phase is terminal (completed or cancelled).
   * - `fresh`: the staleness contract says fresh.
   * - `oneshot-excluded`: `includeOneShot` is false and the entry is a oneshot.
   * - `phase-excluded`: the phase is in `phaseExclusions`.
   * - `workflow-type-not-in-topology`: the topology does not cover the workflow type.
   * - `phase-not-in-topology`: the topology has no contract for the phase. The selector skips the
   *   entry, because the scorer throws on it and that throw stops the batch.
   */
  reason:
    | 'terminal'
    | 'fresh'
    | 'oneshot-excluded'
    | 'phase-excluded'
    | 'workflow-type-not-in-topology'
    | 'phase-not-in-topology';
}

export interface PruneSelection {
  candidates: PruneCandidate[];
  excluded: PruneExclusion[];
}

/**
 * A `handleList` entry that failed structural validation. The selector does not see it. Outside the
 * `include` mode, the handler does not prune it, so a changed `handleList` shape cannot cancel active
 * work in bulk. `featureId` is optional, because the entry can lack it.
 */
export interface PruneMalformedEntry {
  featureId?: string | undefined;
  reason: string;
}

/** Minutes from a timestamp to `now`, with `now` injected for tests. A timestamp that does not parse gives 0. */
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
 * Partitions workflow entries into prune candidates and exclusions with reasons. The exclusion order
 * is `terminal`, `phase-excluded`, `oneshot-excluded`, `workflow-type-not-in-topology`,
 * `phase-not-in-topology`, then `fresh`.
 * The staleness verdict comes from the typed `PhaseContract` of the topology, through
 * `scoreEntryThroughTopology`. Per-phase thresholds come from the topology, not from this selector.
 * The handler adds the second signal timestamps, and the selector converts each one to minutes.
 *
 * @param entries  Workflow summaries, usually from `handleList`.
 * @param topology The loaded topology with per-phase staleness contracts.
 * @param config   The phase exclusions and the oneshot switch. All fields are optional.
 * @param now      An injectable clock for tests. The default is `new Date()`.
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

    if (config.coveredWorkflowTypes !== undefined && !config.coveredWorkflowTypes.has(entry.workflowType)) {
      excluded.push({ featureId: entry.featureId, reason: 'workflow-type-not-in-topology' });
      continue;
    }

    if (topology.phases[entry.phase] === undefined) {
      excluded.push({ featureId: entry.featureId, reason: 'phase-not-in-topology' });
      continue;
    }

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

/** The commit window, in hours, for `hasRecentCommits`. The handler args cannot change it. */
const RECENT_COMMITS_WINDOW_HOURS = 24;

/**
 * The handler args. Each field is optional: `dryRun` defaults to true, `force` (skip the safeguards)
 * to false, `includeOneShot` to true, and `now` to the current time.
 * The `prune_stale_workflows` schema rejects a `thresholdMinutes` arg, because per-phase staleness
 * lives in `topology.yaml`.
 */
export interface PruneHandlerArgs {
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
   * Reads the time of the latest `workflow.transition` event of a workflow. It returns `undefined`
   * when the stream has no transition event or the query fails.
   */
  readPhaseTransitionTimestamp: (featureId: string) => Promise<string | undefined>;
  /**
   * Reads the time of the latest commit on the tracked branch as an ISO string. It returns
   * `undefined` when the workflow has no tracked branch or `git log` fails.
   */
  readBranchActivityTimestamp: (
    branchName: string | undefined,
  ) => Promise<string | undefined>;
}

export interface PruneSkipped {
  featureId: string;
  /**
   * Why the handler skipped the candidate:
   * - `open-pr`: a safeguard found an open PR for the branch.
   * - `active-branch`: a safeguard found commits on the branch in the recency window.
   * - `cancel-failed`: `handleCancel` returned `success: false`.
   * - `event-append-failed`: the cancel succeeded, but the `workflow.pruned` append threw. The
   *   workflow is cancelled but not counted as pruned, because the audit trail is incomplete.
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

/** The diagnostics payload of a prune response. `malformedCount` is 0 when each entry is valid. */
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
   * Present only in apply mode. A dry run omits it, because an empty array reads as "nothing was
   * pruned" and not as "this was a preview".
   */
  pruned?: PrunePruned[];
  /**
   * The `handleList` entries that failed structural validation: a missing `featureId`, `workflowType`,
   * or `phase`, or a `_checkpoint.lastActivityTimestamp` that does not parse. It is present when the
   * handler rejected at least one entry and the mode is not `skip`.
   */
  malformed?: PruneMalformedEntry[];
  /**
   * The diagnostics payload. It is present in the `report` (default) and `include` modes, and absent
   * in the `skip` mode. It holds per-entry reasons, and an advisory when malformed entries exist.
   */
  diagnostics?: PruneDiagnostics;
  /** Present when candidates were truncated by maxBatchSize. */
  truncated?: boolean;
  /** Total candidate count before truncation. Present when `truncated === true`. */
  totalCandidates?: number;
}

/**
 * Reads the top-level `branchName` of a workflow through `readStateFile`. It returns `undefined` when
 * the field is absent or the read fails, and the handler then skips both safeguards.
 */
async function defaultReadBranchName(
  featureId: string,
  stateDir: string,
): Promise<string | undefined> {
  try {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const state = (await readStateFile(stateFile)) as unknown as Record<string, unknown>;
    const branchName = state.branchName;
    return typeof branchName === 'string' && branchName.length > 0 ? branchName : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the reader for the time of the latest `workflow.transition` event on a stream. It returns
 * `undefined` when the stream has no transition event or the query throws. The store returns
 * events in stream order, so the last event is the newest.
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
 * Reads the time of the latest commit on `refs/heads/<branchName>` with `git log -1 --format=%ct`, as
 * an ISO string. It uses `execFile`, so the parallel readers of the handler do not block the event loop.
 * It returns `undefined` for an absent branch name, a name outside the safe ref characters, or a git failure.
 */
async function defaultReadBranchActivityTimestamp(
  branchName: string | undefined,
): Promise<string | undefined> {
  if (!branchName) return undefined;
  if (!/^[A-Za-z0-9/_.\-]+$/.test(branchName) || branchName.includes('..')) {
    return undefined;
  }
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
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
 * Narrows the `handleList` payload to the entry shape of this module. Each entry must have a non-empty
 * `featureId` and `workflowType`, a string `phase`, and a `_checkpoint.lastActivityTimestamp` that parses.
 * Other entries go to the `malformed` list. The function does not fill defaults, because one
 * `handleList` change can then make each active workflow look stale and cancel it in apply mode.
 * A timestamp that does not parse is malformed, because `minutesSince` gives 0 for it and the entry looks fresh.
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
 * The safeguards in evaluation order, recorded on the audit event when `force` skips them. The names
 * are the user-facing reason keys. The backend for `active-branch` is `hasRecentCommits`.
 */
const ALL_SKIPPED_SAFEGUARDS = ['open-pr', 'active-branch'] as const;

/**
 * The outcome of one candidate from {@link prunePruneCandidate}: `skipped` or `pruned`. The union
 * makes it impossible to count one candidate in both result lists.
 */
type CandidateOutcome =
  | { kind: 'skipped'; entry: PruneSkipped }
  | { kind: 'pruned'; entry: PrunePruned };

/**
 * Runs the apply-mode steps for one candidate: the safeguards, the cancel, and the `workflow.pruned`
 * audit event. `force` skips the safeguards and records them on the event. A workflow with no branch
 * name skips both safeguards. A failed cancel gives `cancel-failed`, and the batch continues.
 * A failed append gives `event-append-failed` only, not `pruned`, because the audit trail is incomplete.
 */
async function prunePruneCandidate(
  candidate: PruneCandidate,
  deps: PruneHandlerDeps,
  eventStore: NonNullable<DispatchContext['eventStore']>,
  force: boolean,
  stateDir: string,
): Promise<CandidateOutcome> {
  const branchName = await deps.readBranchName(candidate.featureId, stateDir);

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

/**
 * The `prune_stale_workflows` handler. It lists workflows, adds the second staleness signals, selects
 * candidates, and caps them at `maxBatchSize`, most stale first. A dry run returns the candidates without `pruned`.
 * Apply mode runs the safeguards unless `force` is set, cancels each candidate that passes, and appends `workflow.pruned`.
 * Apply mode needs the event store, so no cancel happens without an audit trail. With `requireDryRun`,
 * it also needs a `prune.diagnostics` event on `_prune`, and a failed query skips that check.
 *
 * `malformedHandling` is `report` (the default), `include` (malformed entries with a `featureId` become
 * candidates with infinite staleness), or `skip` (no diagnostics). The handler logs a warning for malformed
 * entries, because all-malformed output looks the same as nothing to prune. With no loaded topology,
 * it returns `{ aborted: true, reason: 'topology_not_loaded' }`. The handler waits for the diagnostics append,
 * and a failed append does not fail the prune.
 */
export async function handlePruneStaleWorkflows(
  args: PruneHandlerArgs,
  stateDir: string,
  ctx?: DispatchContext,
  deps: PruneHandlerDeps = productionDeps(ctx),
): Promise<ToolResult> {
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
  const includeOneShot = args.includeOneShot;
  const dryRun = args.dryRun ?? true;
  const force = args.force ?? false;
  const now = args.now ? new Date(args.now) : new Date();
  const pruneConfig = ctx?.projectConfig?.prune;

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
    }
  }

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

  const diagnosticEntries: PruneDiagnosticEntry[] = malformed.map((m) => ({
    ...(m.featureId !== undefined ? { featureId: m.featureId } : {}),
    reasons: [m.reason],
  }));

  const malformedHandling = pruneConfig?.malformedHandling ?? 'report';

  let stalenessScope: StalenessScope;
  try {
    stalenessScope = resolveStalenessTopology();
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


  const { candidates: selectedCandidates } = selectPruneCandidates(
    enrichedEntries,
    stalenessScope.topology,
    {
      ...(includeOneShot !== undefined ? { includeOneShot } : {}),
      ...(pruneConfig?.phaseExclusions ? { phaseExclusions: pruneConfig.phaseExclusions } : {}),
      ...(stalenessScope.coveredWorkflowTypes !== undefined
        ? { coveredWorkflowTypes: stalenessScope.coveredWorkflowTypes }
        : {}),
    },
    now,
  );

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

  const maxBatchSize = pruneConfig?.maxBatchSize;
  const totalCandidates = rawCandidates.length;
  let candidates = rawCandidates;
  let truncated = false;

  if (maxBatchSize !== undefined && rawCandidates.length > maxBatchSize) {
    truncated = true;
    candidates = [...rawCandidates]
      .sort((a, b) => b.stalenessMinutes - a.stalenessMinutes)
      .slice(0, maxBatchSize);
  }

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


  if (ctx?.eventStore && diagnostics) {
    await ctx.eventStore
      .append('_prune', {
        type: 'prune.diagnostics',
        data: {
          malformedCount: diagnostics.malformedCount,
          candidateCount: diagnostics.candidateCount,
          malformedEntries: diagnostics.malformedEntries,
          ...(diagnostics.advisory ? { advisory: diagnostics.advisory } : {}),
        },
      })
      .catch(() => {
      });
  }

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

  const skipped: PruneSkipped[] = [];
  const pruned: PrunePruned[] = [];
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
