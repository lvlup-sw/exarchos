import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { pickFields, type ToolResult } from '../format.js';
import { logger } from '../logger.js';
import { TERMINAL_PHASES } from '../workflow/terminal-phases.js';
import { isFeatureStream } from '../core/infra-streams.js';
import { getDispatchContext } from '../dispatch/dispatch-context.js';
// DR-6 — explicit-`repoRoot` normalization routes through the same memoized
// key derivation the composite layer uses for the caller key.
import { deriveRepoKey } from '../utils/paths.js';
import type { NextAction } from '../next-action.js';
import { ViewMaterializer } from './materializer.js';
import { SnapshotStore, isSnapshotSafeId } from './snapshot-store.js';
// #1555 — shared `asOf` bounded-fold seam (dispatch-core, INV-2).
import { resolveAsOfEvents, type AsOfParam } from '../projections/cursor.js';
import {
  workflowStatusProjection,
  WORKFLOW_STATUS_VIEW,
} from './workflow-status-view.js';
import type { WorkflowStatusViewState } from './workflow-status-view.js';
import {
  taskDetailProjection,
  TASK_DETAIL_VIEW,
} from './task-detail-view.js';
import type { TaskDetailViewState, TaskDetail } from './task-detail-view.js';
import {
  pipelineProjection,
  PIPELINE_VIEW,
  PIPELINE_SNAPSHOT_NAME,
} from './pipeline-view.js';
import type { PipelineViewState } from './pipeline-view.js';
import {
  PIPELINE_DEFAULT_ITEM_CAP,
  SUMMARY_FIRST_PAGE_ITEMS,
  estimateOutputTokens,
  resolveOutputTokenThreshold,
  countBy,
  narrowAffordance,
} from './output-cap.js';
import type { QualityHintsConfig } from '../capabilities/resolver.js';
import {
  stackViewProjection,
  STACK_VIEW,
} from './stack-view.js';
import {
  telemetryProjection,
  TELEMETRY_VIEW,
} from '../telemetry/telemetry-projection.js';
import {
  teamPerformanceProjection,
  TEAM_PERFORMANCE_VIEW,
} from './team-performance-view.js';
import type { TeamPerformanceViewState } from './team-performance-view.js';
import {
  delegationTimelineProjection,
  DELEGATION_TIMELINE_VIEW,
} from './delegation-timeline-view.js';
import type { DelegationTimelineViewState } from './delegation-timeline-view.js';
import {
  codeQualityProjection,
  CODE_QUALITY_VIEW,
} from './code-quality-view.js';
import type { CodeQualityViewState } from './code-quality-view.js';
import {
  evalResultsProjection,
  EVAL_RESULTS_VIEW,
} from './eval-results-view.js';
import type { EvalResultsViewState } from './eval-results-view.js';
import { correlateQualityAndEvals } from '../quality/quality-correlation.js';
import {
  workflowStateProjection,
  WORKFLOW_STATE_VIEW,
} from './workflow-state-projection.js';
import {
  delegationReadinessProjection,
  DELEGATION_READINESS_VIEW,
} from './delegation-readiness-view.js';
import type { DelegationReadinessState } from './delegation-readiness-view.js';
import {
  synthesisReadinessProjection,
  SYNTHESIS_READINESS_VIEW,
} from './synthesis-readiness-view.js';
import type { SynthesisReadinessState } from './synthesis-readiness-view.js';
import {
  shepherdStatusProjection,
  SHEPHERD_STATUS_VIEW,
} from './shepherd-status-view.js';
import type { ShepherdStatusState } from './shepherd-status-view.js';
import {
  provenanceProjection,
  PROVENANCE_VIEW,
} from './provenance-view.js';
import type { ProvenanceViewState } from './provenance-view.js';
import {
  convergenceProjection,
  CONVERGENCE_VIEW,
} from './convergence-view.js';
import type { ConvergenceViewState } from './convergence-view.js';
import { detectRegressions, emitRegressionEvents } from '../quality/regression-detector.js';
import type { FailureTracker } from '../quality/regression-detector.js';
import { computeAttribution, isValidDimension } from '../quality/attribution.js';
import type { AttributionDimension } from '../quality/attribution.js';
import { PROJECTION_LAG_THRESHOLD_MS } from '../projections/index.js';

// ─── Helper: create a materializer with all projections registered ─────────


// #1555 — shared `asOf` bounded-fold seam (dispatch-core, INV-2).
// ─── Helper: create a materializer with all projections registered ─────────

function createMaterializer(stateDir: string): ViewMaterializer {
  // DR-5/DR-6 snapshot-lineage registration: the pipeline view's snapshots move
  // to a versioned filename (`pipeline-v2`) so pre-upgrade v1 snapshots are
  // ignored and the stream re-folds to pick up `repoRoot`. The projection is
  // still registered under `PIPELINE_VIEW` below — only the on-disk lineage moves.
  const snapshotStore = new SnapshotStore(stateDir, {
    [PIPELINE_VIEW]: PIPELINE_SNAPSHOT_NAME,
  });
  const materializer = new ViewMaterializer({ snapshotStore });
  materializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);
  materializer.register(TASK_DETAIL_VIEW, taskDetailProjection);
  materializer.register(PIPELINE_VIEW, pipelineProjection);
  materializer.register(STACK_VIEW, stackViewProjection);
  materializer.register(TELEMETRY_VIEW, telemetryProjection);
  materializer.register(TEAM_PERFORMANCE_VIEW, teamPerformanceProjection);
  materializer.register(DELEGATION_TIMELINE_VIEW, delegationTimelineProjection);
  materializer.register(CODE_QUALITY_VIEW, codeQualityProjection);
  materializer.register(EVAL_RESULTS_VIEW, evalResultsProjection);
  materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
  materializer.register(DELEGATION_READINESS_VIEW, delegationReadinessProjection);
  materializer.register(SYNTHESIS_READINESS_VIEW, synthesisReadinessProjection);
  materializer.register(SHEPHERD_STATUS_VIEW, shepherdStatusProjection);
  materializer.register(PROVENANCE_VIEW, provenanceProjection);
  materializer.register(CONVERGENCE_VIEW, convergenceProjection);
  return materializer;
}

// EventStore is no longer obtained through this module. After the
// constructor-injection refactor (#1182), every consumer receives the
// EventStore via DispatchContext. The previous registry/lazy-fallback
// pattern was eliminated to avoid the DIM-1 recurrence trap — see
// docs/rca/2026-04-26-v29-event-projection-cluster.md.

// ─── Cached Materializer ─────────────────────────────────────────────────────

let cachedMaterializer: ViewMaterializer | null = null;
let cachedStateDir: string | null = null;

/** @internal Exported for testing only */
export function getOrCreateMaterializer(stateDir: string): ViewMaterializer {
  if (cachedMaterializer && cachedStateDir === stateDir) {
    return cachedMaterializer;
  }
  cachedMaterializer = createMaterializer(stateDir);
  cachedStateDir = stateDir;
  return cachedMaterializer;
}

/** For testing: reset the singleton materializer cache. */
export function resetMaterializerCache(): void {
  cachedMaterializer = null;
  cachedStateDir = null;
}

// ─── Helper: query delta events using materializer high-water mark ──────────

/**
 * Wave 5 (#1437) — view-action correlation filter passthrough.
 *
 * Telemetry view callers can pass `operationId / correlationId / causationId`
 * down to the underlying `EventStore.query` so the projection folds only the
 * slice that matches a dispatch-boundary tuple. The filter handle is the
 * indexed correlation columns on the SQLite substrate (a post-fetch JS
 * filter on the in-memory backend); INV-1 keeps the value of truth on the
 * payload, mirrored to the indexed columns.
 *
 * Cache semantics: a filtered query MUST bypass the materializer LRU cache.
 * The cached `view` baked in the unfiltered roll-up of every event past the
 * high-water mark; folding only a filtered subset on top of that base would
 * silently contaminate the cache (e.g. a `correlationId: cor-X` query would
 * leave the cache reading "everything except cor-Y"). Callers route through
 * `materializeFiltered` below when filters are present so the fold runs
 * from `projection.init()` against the filtered event list and the cache
 * is never written.
 */
export interface ViewQueryFilters {
  readonly operationId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

/**
 * @internal Returns true when any correlation filter field is present, so the
 * handler must take the cache-bypass branch.
 */
export function hasCorrelationFilters(filters?: ViewQueryFilters): boolean {
  if (!filters) return false;
  return (
    filters.operationId !== undefined ||
    filters.correlationId !== undefined ||
    filters.causationId !== undefined
  );
}

/**
 * Wave 2 (#1448) — AsyncLocalStorage-aware default for correlation filters.
 *
 * Returns the explicit args verbatim if any are supplied (explicit-wins).
 * Otherwise, if a dispatch context is active, defaults `correlationId` to
 * the active dispatch's correlationId — the chain-stable anchor for the
 * current workflow scope. If no args AND no active context, returns empty.
 *
 * The default makes "show me telemetry for the workflow I'm in" Just Work
 * inside an agent dispatch without requiring the agent to thread the
 * correlation tuple back into every telemetry call.
 */
export function deriveCorrelationFilters(args: {
  operationId?: string;
  correlationId?: string;
  causationId?: string;
}): ViewQueryFilters {
  const explicit: ViewQueryFilters = {
    ...(args.operationId !== undefined ? { operationId: args.operationId } : {}),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
    ...(args.causationId !== undefined ? { causationId: args.causationId } : {}),
  };
  if (Object.keys(explicit).length > 0) {
    return explicit;
  }
  const ctx = getDispatchContext();
  if (ctx) {
    logger.debug(
      { source: 'ctx-default', correlationId: ctx.correlationId },
      'deriveCorrelationFilters: defaulted correlationId from active dispatch context',
    );
    return { correlationId: ctx.correlationId };
  }
  return {};
}

/** @internal Exported for CLI commands and testing */
export async function queryDeltaEvents(
  store: EventStore,
  materializer: ViewMaterializer,
  streamId: string,
  viewName: string,
  filters?: ViewQueryFilters,
): Promise<WorkflowEvent[]> {
  // Wave 5 (#1437) — filtered queries bypass the cache entirely so the
  // hwm-relative incremental path can't bleed an unfiltered base into a
  // filtered fold. See ViewQueryFilters doc for the contamination scenario.
  if (hasCorrelationFilters(filters)) {
    return store.query(streamId, filters);
  }
  const cachedState = materializer.getState(streamId, viewName);
  if (cachedState) {
    // Warm call: only fetch events past the high-water mark
    const hwm = cachedState.highWaterMark;
    return hwm > 0
      ? store.query(streamId, { sinceSequence: hwm })
      : store.query(streamId);
  }
  // Cold call: load snapshot then query all events
  await materializer.loadFromSnapshot(streamId, viewName);
  return store.query(streamId);
}

/**
 * Cache-bypassing fold for correlation-filtered queries (Wave 5 / #1437).
 *
 * Reads the registered projection for `viewName`, builds a fresh
 * `projection.init()` base, and applies every event in the input list in
 * order. Never reads or writes the materializer LRU cache, so an unfiltered
 * call before or after retains the full roll-up untouched.
 */
export function materializeFiltered<T>(
  materializer: ViewMaterializer,
  viewName: string,
  events: WorkflowEvent[],
): T {
  // Delegates to the shared cache-bypassing fresh fold (#1555 consolidation).
  // `materializeFresh` records the bypass on every successful call so the
  // correlation-filtered traffic is visible alongside the LRU hit/miss stats —
  // without it, a healthy hitRate can mask thousands of cache-skipping calls
  // (PR #1447 DIM-2 audit) — and never touches the LRU cache.
  return materializer.materializeFresh<T>(viewName, events);
}

// ─── Helper: discover all event stream files ───────────────────────────────

async function discoverStreams(stateDir: string, store?: EventStore): Promise<string[]> {
  // v2.11 Phase 3 (substrate-cut): SQLite is the only substrate, so
  // stream discovery always flows through `EventStore.listStreams()`
  // (a SELECT DISTINCT streamId FROM events on the SqliteBackend).
  // The legacy JSONL `fs.readdir` fallback was removed alongside the
  // JSONL writer.
  if (store) {
    return store.listStreams();
  }
  // No store wired (synthetic test fixtures only) — return empty.
  void stateDir;
  return [];
}

// ─── Helper: read state.json (Fix 2 / #1184) ───────────────────────────────
//
// Several view handlers must consult `<id>.state.json` for plan-state facts
// that the event projection cannot derive (review status, declared task
// count, declared task list, dimension findings). The handlers stay
// best-effort: a missing/corrupt state file falls back to the projection-
// derived value rather than failing the view query, because state.json is
// the planner's stamp and not all callers (CLI tools, tests, in-flight
// workflows) will have one yet.
async function readWorkflowStateJson(
  stateDir: string,
  workflowId: string,
): Promise<Record<string, unknown> | null> {
  const file = path.join(stateDir, `${workflowId}.state.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    // ENOENT is the legitimate "no plan-state stamp yet" case (CLI tools,
    // tests, in-flight workflows before first `workflow set`) — fall back
    // silently to projection-derived values. Other I/O errors are NOT
    // expected and would mask real corruption if treated as a clean miss.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), file },
      'readWorkflowStateJson: I/O error reading state.json — falling back to projection',
    );
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logger.warn(
      { file, type: Array.isArray(parsed) ? 'array' : typeof parsed },
      'readWorkflowStateJson: state.json is not an object — falling back to projection',
    );
    return null;
  } catch (err) {
    // Corrupt JSON: surface a warning so the corruption is observable in
    // logs even though we keep serving views from the projection. Without
    // this, a long-lived bad state.json would silently disagree with
    // workflow_status / synthesis_readiness / convergence forever.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), file },
      'readWorkflowStateJson: failed to parse state.json — falling back to projection',
    );
    return null;
  }
}

// ─── View Workflow Status Handler ──────────────────────────────────────────

export async function handleViewWorkflowStatus(
  args: { workflowId?: string; asOf?: AsOfParam },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    // #1555 — an `asOf` (bounded-fold) read MUST bypass the hwm cache: fetch
    // ALL events for the stream, bound to `events[0..N]` via the shared
    // `resolveAsOfEvents` seam, and fold fresh from `projection.init()`
    // (`materializeFresh`). Mirrors the correlation-filter precedent so a warm
    // unbounded cache can never bleed into the bounded fold, and the bounded
    // read never contaminates the cache. The live path keeps the cached
    // `queryDeltaEvents` → `materialize`. Behavior lives here in the dispatch
    // core; CLI/MCP adapters only thread `asOf` through (INV-2).
    const view = args.asOf !== undefined
      ? materializer.materializeFresh<WorkflowStatusViewState>(
          WORKFLOW_STATUS_VIEW,
          resolveAsOfEvents(await store.query(streamId), args.asOf),
        )
      : materializer.materialize<WorkflowStatusViewState>(
          streamId,
          WORKFLOW_STATUS_VIEW,
          await queryDeltaEvents(store, materializer, streamId, WORKFLOW_STATUS_VIEW),
        );

    // Fix 2 (#1184) — `tasksTotal` is a plan-state fact: the planner stamps
    // the full task list via `workflow set` (state.patched events), and
    // `task.assigned` only fires for tasks that get dispatched. Sourcing the
    // count from state.tasks.length avoids under-reporting when the planner
    // has declared work that hasn't been kicked off yet.
    //
    // #1555 — but ONLY for a LIVE read. state.json carries the CURRENT tip task
    // list, so folding it into a bounded `asOf` response would leak tip-state
    // counts into a historical projection (INV-1: a bounded read is a pure fold
    // of `events[0..N]`). For a bounded read the fold's own `view.tasksTotal` is
    // the as-of-correct count.
    let tasksTotal = view.tasksTotal;
    if (args.asOf === undefined) {
      const state = await readWorkflowStateJson(stateDir, streamId);
      const stateTasks = state?.['tasks'];
      if (Array.isArray(stateTasks)) {
        tasksTotal = stateTasks.length;
      }
    }

    // C4 (#1226) — strip projection-internal dedup bookkeeping from the
    // public envelope. The `_seen*TaskIds` arrays are needed for replay
    // correctness but must not leak into the response shape.
    const {
      _seenAssignedTaskIds: _ignoredAssigned,
      _seenCompletedTaskIds: _ignoredCompleted,
      ...publicView
    } = view;

    return { success: true, data: { ...publicView, tasksTotal } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Tasks Handler ────────────────────────────────────────────────────

export async function handleViewTasks(
  args: {
    workflowId?: string;
    filter?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    fields?: string[];
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, TASK_DETAIL_VIEW);
    const view = materializer.materialize<TaskDetailViewState>(
      streamId,
      TASK_DETAIL_VIEW,
      events,
    );

    // Fix 2 (#1184) — the task-detail projection is event-sourced and only
    // populates entries that have a `task.assigned` event. The planner often
    // stamps the full task list via `workflow set` before any dispatch, so
    // we merge state.tasks into the projection: event-sourced detail wins
    // (it has assignee, status, tddPhase, etc.); state-sourced entries fill
    // in the gaps so plan-declared pending tasks appear.
    const state = await readWorkflowStateJson(stateDir, streamId);
    const stateTasksRaw = state?.['tasks'];
    const merged: Record<string, TaskDetail> = { ...view.tasks };
    if (Array.isArray(stateTasksRaw)) {
      for (const entry of stateTasksRaw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        const id = typeof e['id'] === 'string' ? (e['id'] as string) : undefined;
        if (!id || merged[id]) continue;
        // Map TaskSchema status (`pending|in_progress|complete|failed`) onto
        // the TaskDetail status union. The schema preprocesses 'completed' →
        // 'complete' so handle both spellings defensively. Plan-state
        // 'pending' must surface as 'pending' so a not-yet-dispatched task
        // is never reported as 'assigned' (which means dispatched to a
        // teammate) — see #1184 / CR feedback on PR #1185.
        const rawStatus = e['status'];
        const status: TaskDetail['status'] =
          rawStatus === 'failed'
            ? 'failed'
            : rawStatus === 'complete' || rawStatus === 'completed'
              ? 'completed'
              : rawStatus === 'in_progress'
                ? 'in-progress'
                : 'pending';
        merged[id] = {
          taskId: id,
          title: typeof e['title'] === 'string' ? (e['title'] as string) : '',
          status,
          ...(typeof e['branch'] === 'string' ? { branch: e['branch'] as string } : {}),
          ...(typeof e['worktreePath'] === 'string'
            ? { worktree: e['worktreePath'] as string }
            : {}),
          ...(typeof e['teammateName'] === 'string'
            ? { assignee: e['teammateName'] as string }
            : {}),
        };
      }
    }
    let tasks: TaskDetail[] = Object.values(merged);

    // Apply optional filter
    if (args.filter) {
      tasks = tasks.filter((task) => {
        for (const [key, value] of Object.entries(args.filter!)) {
          if ((task as unknown as Record<string, unknown>)[key] !== value) {
            return false;
          }
        }
        return true;
      });
    }

    // Apply optional offset (before limit)
    if (args.offset !== undefined) {
      tasks = tasks.slice(args.offset);
    }

    // Apply optional limit (after filter and offset)
    if (args.limit !== undefined) {
      tasks = tasks.slice(0, args.limit);
    }

    // Apply optional fields projection
    if (args.fields) {
      const projected = tasks.map(
        (t) => pickFields(t as unknown as Record<string, unknown>, args.fields!),
      );
      return { success: true, data: projected };
    }

    return { success: true, data: tasks };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Pipeline Handler ─────────────────────────────────────────────────

// DR-1 — compact pipeline entry. Default pipeline rows omit the unbounded
// per-task `tasksById` map (redundant with the counters beside it) and carry
// only summary fields. The per-entry `hasMore` here is the stack-position
// EVICTION flag (unrelated to page-level paging) and is deliberately retained.
// `detail: true` restores the full {@link PipelineViewState} row. The type is
// declared locally in `views/tools.ts` on purpose — the exported
// `PipelineViewState`/`PipelineSummary` declarations stay in
// `views/pipeline-view.ts` (chain-A territory).
interface CompactPipelineEntry {
  readonly featureId: string;
  readonly workflowType: string;
  readonly phase: string;
  readonly taskCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly stackPositions: PipelineViewState['stackPositions'];
  readonly hasMore: boolean;
  readonly _asOf: string;
  readonly repoRoot?: string;
}

/**
 * Compacted counterpart of `PipelineSummary`: identical group-count rollups,
 * but its `firstPage` rows are compacted the same way the detail branch
 * compacts entries (DR-1). Local so chain A's exported `PipelineSummary` shape
 * is untouched.
 */
interface CompactPipelineSummary {
  readonly total: number;
  readonly byPhase: Record<string, number>;
  readonly byWorkflowType: Record<string, number>;
  readonly firstPage: CompactPipelineEntry[];
}

/**
 * Strip a full projection row down to the DR-1 compact entry. `repoRoot` is
 * read defensively (`w as { repoRoot? }`) so this stays forward-compatible with
 * chain A adding `repoRoot` to `PipelineViewState` (task 003) — the field flows
 * through with no merge conflict on this helper once it exists.
 */
function toCompactEntry(w: PipelineViewState): CompactPipelineEntry {
  const repoRoot = (w as { repoRoot?: string }).repoRoot;
  return {
    featureId: w.featureId,
    workflowType: w.workflowType,
    phase: w.phase,
    taskCount: w.taskCount,
    completedCount: w.completedCount,
    failedCount: w.failedCount,
    stackPositions: w.stackPositions,
    hasMore: w.hasMore,
    _asOf: w._asOf,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
  };
}

/** Paging metadata shared by the detail and summary-fallback branches (DR-3). */
interface PipelinePage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/**
 * Build the DR-3 `page` envelope. Both branches derive `hasMore` from the same
 * offset-aware invariant — `offset + shownRows < total` — so a caller paged to
 * the last window never sees a spurious "more rows" signal (the summary branch
 * previously compared `total > firstPage.length`, ignoring `offset`).
 */
function buildPage(total: number, offset: number, limit: number, shownRows: number): PipelinePage {
  return { total, offset, limit, hasMore: offset + shownRows < total };
}

/**
 * DR-3 deterministic pipeline order: `_asOf` DESCENDING (most-recent activity
 * first), ties broken by `featureId` ASCENDING. A total order (no equal-rank
 * ambiguity for distinct featureIds) so two consecutive offset windows always
 * partition ONE stable sequence. `_asOf` is an ISO-8601 string, so lexical
 * comparison is chronological.
 */
function comparePipelineRows(a: PipelineViewState, b: PipelineViewState): number {
  if (a._asOf !== b._asOf) return a._asOf < b._asOf ? 1 : -1;
  if (a.featureId !== b.featureId) return a.featureId < b.featureId ? -1 : 1;
  return 0;
}

/**
 * DR-7 always-on perceivability: the scope-all escape-hatch affordance. Surfaced
 * on `next_actions` whenever repo scoping hid rows (`unscopedTotal > page.total`)
 * — scoped-empty AND mixed steady state alike. Carries the exact `hiddenCount`
 * (`unscopedTotal - page.total`) so the agent can perceive precisely how many
 * workflows the default repo scope elided, and the `--scope all` CLI hint that
 * reveals them. In `scope: "all"` mode nothing is hidden (`unscopedTotal ===
 * page.total`), so this never fires there. Verb is the view's own name so it
 * validates against the catch-all `NextActionSchema`.
 */
function scopeAllAffordance(hiddenCount: number): NextAction {
  return {
    verb: 'pipeline',
    reason: `${hiddenCount} workflow${hiddenCount === 1 ? '' : 's'} in other repos ${hiddenCount === 1 ? 'is' : 'are'} hidden by the default repo scope — use scope: "all" to include ${hiddenCount === 1 ? 'it' : 'them'}.`,
    hint: 'exarchos vw ls --scope all',
  };
}

export async function handleViewPipeline(
  args: {
    limit?: number;
    offset?: number;
    includeCompleted?: boolean;
    detail?: boolean;
    // DR-6 — explicit scope inputs (schema-declared in `registry.ts` so the CLI
    // flags auto-emit). `repoRoot` scopes to an arbitrary repo (normalized before
    // compare); `scope` forces `"all"` (unfiltered) or `"repo"` (requires a key).
    repoRoot?: string;
    scope?: 'repo' | 'all';
  },
  stateDir: string,
  eventStore: EventStore,
  // DR-3 — the resolved `.exarchos.yml` slice threaded from `views/composite.ts`
  // so `qualityHints.outputTokenThreshold` drives the measured-size summary.
  // Optional so existing internal callers (and tests) that omit it keep the
  // item-cap-only behavior (fail-open: no config ⇒ default threshold).
  config?: QualityHintsConfig,
  // DR-6 — the memoized CALLER repo key, computed once per server process and
  // threaded by `views/composite.ts` (`deriveRepoKey(ctx.cwd ?? process.cwd())`).
  // Absent for direct handler calls (tests/internal), which therefore stay
  // UNSCOPED by construction — preserving today's semantics without a per-suite
  // edit. See the pinned scope-resolution precedence below.
  callerRepoKey?: string,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);

    // Materialize all streams to get phase info for filtering. Infrastructure
    // streams (exarchos-init, exarchos-doctor, telemetry) are excluded — they
    // never emit workflow.started so they would surface as phantom rows with
    // empty featureId/workflowType/phase (#1187).
    //
    // Enumeration tolerance (RCA 2026-05-30-state-source-integrity): the event
    // store legitimately contains streams whose ids are not snapshot-safe —
    // `__`-prefixed sentinels (`__migration__`) and two-segment slash ids
    // (`elicitation/<uuid>`, `workflow-state/<id>`) that the write-side
    // `validateStreamId` accepts but `SnapshotStore.getSnapshotPath` rejects.
    // Exclude them at discovery so iterating the store never forwards an
    // unprojectable id into `materialize` and crashes the view. Explicit
    // single-id queries are unaffected — they still validate their `workflowId`
    // argument via the `materialize`/`getSnapshotPath` throw (closing #1434
    // generically: that fix only skipped `__`-prefixed ids).
    const streamIds = (await discoverStreams(stateDir, store))
      .filter(isFeatureStream)
      .filter(isSnapshotSafeId);
    const allWorkflows: PipelineViewState[] = [];

    for (const streamId of streamIds) {
      const events = await queryDeltaEvents(store, materializer, streamId, PIPELINE_VIEW);
      const view = materializer.materialize<PipelineViewState>(
        streamId,
        PIPELINE_VIEW,
        events,
      );
      allWorkflows.push(view);
    }

    // DR-4 — phantom exclusion. A discovered feature stream that folded no
    // `workflow.started` event yields a degenerate row (empty featureId, no
    // phase, no timestamp). Exclude these BEFORE the terminal filter and BEFORE
    // any total is computed, so a phantom never appears in the page and never
    // inflates `page.total`/`unscopedTotal` — in any scope mode. Infra streams
    // are already dropped at discovery (isFeatureStream); this closes the gap
    // for feature-named streams that carry events but never a `workflow.started`
    // foundation (#1187 covered only the reserved infra ids).
    const real = allWorkflows.filter((w) => w.featureId !== '');

    // Filter out terminal-state workflows unless explicitly requested
    const filtered = args.includeCompleted
      ? real
      : real.filter((w) => !(TERMINAL_PHASES as readonly string[]).includes(w.phase));

    // DR-7 seam — `unscopedTotal` is the post-phantom, post-terminal-filter,
    // PRE-scope-filter count. Pinned here so the scope escape hatch (chain A /
    // task 007) can never mis-attribute `includeCompleted`-hidden rows to repo
    // scoping.
    const unscopedTotal = filtered.length;

    // DR-6 — repo-scope resolution seam (between `unscopedTotal` and
    // `page.total`). PINNED precedence:
    //   1. explicit scope:'all'            → unfiltered              (effective 'all')
    //   2. explicit repoRoot arg           → filter to deriveRepoKey(repoRoot),
    //                                         normalized before compare (effective 'repo')
    //   3. composite-supplied caller key   → filter to it            (effective 'repo')
    //   4. explicit scope:'repo' w/ no key → STRUCTURED ERROR (never silent unscoped)
    //   5. else (direct call, no key)      → unscoped                (effective 'all')
    // Legacy rows (`repoRoot === undefined`) match ONLY the unscoped/'all' modes,
    // because an explicit/caller key is always a defined string and `undefined`
    // never equals it.
    let scoped: PipelineViewState[];
    let effectiveScope: 'repo' | 'all';
    if (args.scope === 'all') {
      scoped = filtered;
      effectiveScope = 'all';
    } else if (args.repoRoot !== undefined) {
      // Normalize the caller-supplied path through the SAME derivation as the
      // recorded key so worktree- and Windows-form inputs match by construction.
      const key = deriveRepoKey(args.repoRoot);
      scoped = filtered.filter((w) => w.repoRoot === key);
      effectiveScope = 'repo';
    } else if (callerRepoKey !== undefined) {
      scoped = filtered.filter((w) => w.repoRoot === callerRepoKey);
      effectiveScope = 'repo';
    } else if (args.scope === 'repo') {
      // scope:'repo' explicitly requested but no repoRoot arg and no caller key —
      // there is no repo identity to filter against. Fail with a structured,
      // self-correcting error rather than silently returning an unscoped result.
      return {
        success: false,
        error: {
          code: 'SCOPE_UNRESOLVABLE',
          message:
            'scope: "repo" requested but no repo identity is resolvable ' +
            '(no explicit repoRoot argument and no caller repo key). Pass an ' +
            'explicit repoRoot, or use scope: "all" to view the full ' +
            'cross-repo inventory.',
          suggestedFix: {
            tool: 'exarchos_view',
            params: { action: 'pipeline', scope: 'all' },
          },
        },
      };
    } else {
      // Direct handler call with no key and no explicit scope — UNSCOPED by
      // construction so existing direct-call suites keep today's semantics.
      scoped = filtered;
      effectiveScope = 'all';
    }

    // DR-3 — deterministic order so consecutive offset windows partition ONE
    // stable sequence: `_asOf` descending, ties broken by `featureId` ascending.
    const sorted = [...scoped].sort(comparePipelineRows);

    // DR-3 — `page.total` reflects the filtered, scoped set.
    const total = sorted.length;

    // DR-2 — pipeline-specific SMALL default window. When the caller omits
    // `limit`, cap at PIPELINE_DEFAULT_ITEM_CAP (10) — deliberately NOT the
    // shared DEFAULT_VIEW_ITEM_CAP (50), which the worktrees view keeps. An
    // explicit `limit` is honored verbatim.
    const start = args.offset ?? 0;
    const explicitLimit = args.limit !== undefined;
    const effectiveLimit = explicitLimit ? (args.limit as number) : PIPELINE_DEFAULT_ITEM_CAP;
    const end = start + effectiveLimit;
    const windowed = sorted.slice(start, end);
    // DR-1 — default rows are compacted (unbounded `tasksById` stripped);
    // `detail: true` returns the full projection rows verbatim.
    const workflows: Array<PipelineViewState | CompactPipelineEntry> = args.detail
      ? windowed
      : windowed.map(toCompactEntry);

    // DR-3 — explicit paging metadata, namespaced under `page` so `page.hasMore`
    // never collides with the per-entry stack-eviction `hasMore` on each row.
    // Detail-branch semantics: more rows exist beyond this window.
    const page = buildPage(total, start, effectiveLimit, windowed.length);

    // #1359 / PR4 T14 + T15 — derive `projectionAsOf` from the maximum
    // `_asOf` timestamp across the materialized workflows (the most
    // recent event observed across the union of streams). Surface
    // `_meta.projectionLag` when the projection is stale beyond
    // PROJECTION_LAG_THRESHOLD_MS. The field is sparse: a fresh
    // projection omits it entirely so agents have a clear "no lag"
    // signal vs. an explicit numeric delta.
    let projectionAsOf: string | undefined;
    for (const w of allWorkflows) {
      if (w._asOf && (!projectionAsOf || w._asOf > projectionAsOf)) {
        projectionAsOf = w._asOf;
      }
    }
    let meta: Record<string, unknown> | undefined;
    if (projectionAsOf !== undefined) {
      meta = { projectionAsOf };
      const asOfMs = Date.parse(projectionAsOf);
      if (Number.isFinite(asOfMs)) {
        const lag = Date.now() - asOfMs;
        if (lag > PROJECTION_LAG_THRESHOLD_MS) {
          meta = { ...meta, projectionLag: lag };
        }
      }
    }

    // DR-3 measured-size summary guard. If the capped per-item payload would
    // STILL exceed the resolved output-token threshold, return a counts-by-group
    // summary + a small first page INSTEAD of per-item detail. Fail-open: an
    // unresolvable threshold (`null`) degrades to the plain capped detail — never
    // an unbounded dump nor an inventory-hiding error.
    // DR-3 — `data.total` is retained as a LEGACY ALIAS of `page.total` for one
    // release; new consumers should read `data.page`.
    // DR-7 — `data.scope` reports the EFFECTIVE mode ('repo' | 'all') and
    // `data.unscopedTotal` the pre-scope count, on EVERY response, so hidden
    // rows are always perceivable.
    const detailData = { workflows, total, unscopedTotal, page, scope: effectiveScope };
    const threshold = resolveOutputTokenThreshold(config);
    const narrowHint = 'exarchos vw ls --limit 20 --offset 0';
    if (threshold !== null && estimateOutputTokens(detailData) > threshold) {
      // DR-1 — the summary's `firstPage` rows are compacted identically to the
      // detail branch, regardless of `detail:true` (a summary fallback exists
      // precisely because the payload was too large — never re-inline tasksById).
      const firstPage = windowed.slice(0, SUMMARY_FIRST_PAGE_ITEMS).map(toCompactEntry);
      const summary: CompactPipelineSummary = {
        total,
        byPhase: countBy(sorted, (w) => w.phase),
        byWorkflowType: countBy(sorted, (w) => w.workflowType),
        firstPage,
      };
      // DR-3 — the SUMMARY branch carries the SAME `page` shape as the detail
      // branch, so `hasMore` is derived from the full offset/limit `windowed`
      // slice — NOT the capped `firstPage` preview. `page.offset`/`page.limit`
      // describe the window; `firstPage` is only a display truncation of it, so
      // keying `hasMore` off `firstPage.length` would spuriously report more
      // pages whenever the window holds more rows than the preview cap (e.g. 15
      // rows, limit 25 → window covers all 15 but firstPage caps at 10).
      // Using `windowed.length` makes summary and detail `page.hasMore` identical
      // for the same query. Namespaced so it never collides with the per-entry
      // eviction `hasMore`.
      const summaryPage = buildPage(total, start, effectiveLimit, windowed.length);
      // DR-7 — the scope-all escape hatch rides alongside the narrow affordance
      // whenever repo scoping hid rows, so the summary branch is perceivable too.
      const summaryNextActions: NextAction[] = [
        narrowAffordance('pipeline', firstPage.length, total, narrowHint),
      ];
      if (unscopedTotal > total) {
        summaryNextActions.push(scopeAllAffordance(unscopedTotal - total));
      }
      return {
        success: true,
        data: { summary, total, unscopedTotal, page: summaryPage, scope: effectiveScope, truncated: true },
        next_actions: summaryNextActions,
        ...(meta ? { _meta: meta } : {}),
      };
    }

    // Per-item detail. Two independent affordances ride `next_actions`:
    //   • the narrow paging affordance whenever `page.hasMore` (more rows exist
    //     beyond the current window — default small cap OR explicit limit/offset
    //     short of the tail);
    //   • DR-7 — the scope-all escape hatch whenever repo scoping hid rows
    //     (`unscopedTotal > total`), independent of paging, so a single-page
    //     scoped result with hidden other-repo rows is still perceivable.
    const nextActions: NextAction[] = [];
    if (page.hasMore) {
      nextActions.push(narrowAffordance('pipeline', windowed.length, total, narrowHint));
    }
    if (unscopedTotal > total) {
      nextActions.push(scopeAllAffordance(unscopedTotal - total));
    }
    return {
      success: true,
      data: detailData,
      ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
      ...(meta ? { _meta: meta } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Team Performance Handler ──────────────────────────────────────────

export async function handleViewTeamPerformance(
  args: { workflowId?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, TEAM_PERFORMANCE_VIEW);
    const view = materializer.materialize<TeamPerformanceViewState>(
      streamId,
      TEAM_PERFORMANCE_VIEW,
      events,
    );

    return { success: true, data: view };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Delegation Timeline Handler ───────────────────────────────────────

export async function handleViewDelegationTimeline(
  args: {
    workflowId?: string;
    // Wave 5 (#1437) — correlation filters scope the projection fold.
    operationId?: string;
    correlationId?: string;
    causationId?: string;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const correlationFilters = deriveCorrelationFilters(args);
    const filtered = hasCorrelationFilters(correlationFilters);
    const events = await queryDeltaEvents(store, materializer, streamId, DELEGATION_TIMELINE_VIEW, correlationFilters);
    // Wave 5 (#1437) — under a correlation filter, fold a fresh projection
    // off `init()` so the materializer cache stays the unfiltered truth.
    const view = filtered
      ? materializeFiltered<DelegationTimelineViewState>(materializer, DELEGATION_TIMELINE_VIEW, events)
      : materializer.materialize<DelegationTimelineViewState>(
          streamId,
          DELEGATION_TIMELINE_VIEW,
          events,
        );

    return { success: true, data: view };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Code Quality Handler ──────────────────────────────────────────────

export async function handleViewCodeQuality(
  args: {
    workflowId?: string;
    skill?: string;
    gate?: string;
    limit?: number;
    // Wave 5 (#1437) — correlation tuple filters scope the underlying
    // EventStore.query, so the projection folds only the slice that matches
    // the dispatch boundary. Threaded into queryDeltaEvents below.
    operationId?: string;
    correlationId?: string;
    causationId?: string;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const correlationFilters = deriveCorrelationFilters(args);
    const correlationFiltered = hasCorrelationFilters(correlationFilters);
    const events = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW, correlationFilters);
    // Wave 5 (#1437) — under a correlation filter, fold a fresh projection
    // off `init()` so the materializer cache stays the unfiltered truth.
    const view = correlationFiltered
      ? materializeFiltered<CodeQualityViewState>(materializer, CODE_QUALITY_VIEW, events)
      : materializer.materialize<CodeQualityViewState>(
          streamId,
          CODE_QUALITY_VIEW,
          events,
        );

    // Detect and emit quality regressions with deduplication.
    // _failureTrackers is a non-enumerable property set by code-quality-view.ts.
    //
    // Wave 5 (#1437) — skip regression detection/emission when a
    // correlation filter is active. Regressions are a global SDLC signal
    // derived from the unfiltered fold; detecting them on a filtered slice
    // would (a) produce false negatives (gates that failed outside the
    // slice look healthy) and (b) emit phantom `quality.regression` events
    // that bake a filtered view into the unfiltered truth.
    if (!correlationFiltered) {
      const regressions = detectRegressions(view as CodeQualityViewState & { _failureTrackers?: Record<string, FailureTracker> });
      if (regressions.length > 0) {
        const existingEvents = await store.query(streamId);
        const existingRegressions = existingEvents
          .filter(e => e.type === 'quality.regression')
          .map(e => e.data as { gate: string; skill: string; firstFailureCommit: string });

        const newRegressions = regressions.filter(r =>
          !existingRegressions.some(er =>
            er.gate === r.gate && er.skill === r.skill && er.firstFailureCommit === r.firstFailureCommit
          )
        );

        if (newRegressions.length > 0) {
          try {
            await emitRegressionEvents(newRegressions, streamId, store);
          } catch (err) {
            // Fire-and-forget: emission failure must not break the view
            // query, but swallowing silently hides write-path failures.
            // Log so the failure is observable in operator logs.
            logger.warn(
              {
                streamId,
                regressions: newRegressions.length,
                err: err instanceof Error ? err.message : String(err),
              },
              'handleViewCodeQuality: failed to emit quality.regression events',
            );
          }
        }
      }
    }

    // Apply optional filters
    let filtered: CodeQualityViewState = { ...view };

    if (args.skill) {
      const skillName = args.skill;
      const matchingSkill = filtered.skills[skillName];
      filtered = {
        ...filtered,
        skills: matchingSkill ? { [skillName]: matchingSkill } : {},
      };
    }

    if (args.gate) {
      const gateName = args.gate;
      const matchingGate = filtered.gates[gateName];
      filtered = {
        ...filtered,
        gates: matchingGate ? { [gateName]: matchingGate } : {},
      };
    }

    if (args.limit !== undefined) {
      filtered = {
        ...filtered,
        benchmarks: filtered.benchmarks.slice(0, args.limit),
        regressions: filtered.regressions.slice(0, args.limit),
      };
    }

    return { success: true, data: filtered };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Eval Results Handler ──────────────────────────────────────────────

export async function handleViewEvalResults(
  args: {
    workflowId?: string;
    skill?: string;
    limit?: number;
    // Wave 5 (#1437) — correlation filters scope the projection fold to
    // a single dispatch boundary.
    operationId?: string;
    correlationId?: string;
    causationId?: string;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const correlationFilters = deriveCorrelationFilters(args);
    const correlationFiltered = hasCorrelationFilters(correlationFilters);
    const events = await queryDeltaEvents(store, materializer, streamId, EVAL_RESULTS_VIEW, correlationFilters);
    // Wave 5 (#1437) — under a correlation filter, fold a fresh projection
    // off `init()` so the materializer cache stays the unfiltered truth.
    const view = correlationFiltered
      ? materializeFiltered<EvalResultsViewState>(materializer, EVAL_RESULTS_VIEW, events)
      : materializer.materialize<EvalResultsViewState>(
          streamId,
          EVAL_RESULTS_VIEW,
          events,
        );

    // Apply optional filters
    let filtered: EvalResultsViewState = { ...view };

    if (args.skill) {
      const matchingSkill = filtered.skills[args.skill];
      filtered = {
        ...filtered,
        skills: matchingSkill ? { [args.skill]: matchingSkill } : {},
      };
    }

    if (args.limit !== undefined) {
      filtered = {
        ...filtered,
        runs: filtered.runs.slice(0, args.limit),
        regressions: filtered.regressions.slice(0, args.limit),
      };
    }

    return { success: true, data: filtered };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Quality Hints Handler ─────────────────────────────────────────────

export async function handleViewQualityHints(
  args: { workflowId?: string; skill?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW);
    const view = materializer.materialize<CodeQualityViewState>(
      streamId,
      CODE_QUALITY_VIEW,
      events,
    );

    const { generateQualityHints } = await import('../quality/hints.js');
    const hints = generateQualityHints(view, args.skill);

    return {
      success: true,
      data: { hints, generatedAt: new Date().toISOString() },
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Quality Correlation Handler ────────────────────────────────────────

export async function handleViewQualityCorrelation(
  args: {
    workflowId?: string;
    // Wave 5 (#1437) — correlation filters scope both underlying projections
    // (CQ + ER) to the same dispatch boundary so the joined view stays
    // internally consistent.
    operationId?: string;
    correlationId?: string;
    causationId?: string;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const correlationFilters = deriveCorrelationFilters(args);
    const correlationFiltered = hasCorrelationFilters(correlationFilters);

    // Under a correlation filter, `queryDeltaEvents` short-circuits the
    // cache and returns `store.query(streamId, filters)` regardless of
    // `viewName` — so both calls would fetch an identical event list.
    // Fetch once and fold the same list into both projections (each
    // projection's `apply` ignores event types it doesn't care about).
    const cqEvents = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW, correlationFilters);
    const cqView = correlationFiltered
      ? materializeFiltered<CodeQualityViewState>(materializer, CODE_QUALITY_VIEW, cqEvents)
      : materializer.materialize<CodeQualityViewState>(
          streamId,
          CODE_QUALITY_VIEW,
          cqEvents,
        );

    const erEvents = correlationFiltered
      ? cqEvents
      : await queryDeltaEvents(store, materializer, streamId, EVAL_RESULTS_VIEW);
    const erView = correlationFiltered
      ? materializeFiltered<EvalResultsViewState>(materializer, EVAL_RESULTS_VIEW, erEvents)
      : materializer.materialize<EvalResultsViewState>(
          streamId,
          EVAL_RESULTS_VIEW,
          erEvents,
        );

    const correlation = correlateQualityAndEvals(cqView, erView);
    return { success: true, data: correlation };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Quality Attribution Handler ─────────────────────────────────────────

export async function handleViewQualityAttribution(
  args: {
    workflowId?: string;
    dimension?: string;
    skill?: string;
    timeRange?: { start: string; end: string };
    // Wave 5 (#1437) — correlation filters scope both underlying projections
    // (CQ + ER) to the same dispatch boundary so the attribution roll-up
    // stays internally consistent.
    operationId?: string;
    correlationId?: string;
    causationId?: string;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const dimension = args.dimension;
  if (!dimension || !isValidDimension(dimension)) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: `Invalid attribution dimension: ${String(dimension)}`,
      },
    };
  }

  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const correlationFilters = deriveCorrelationFilters(args);
    const correlationFiltered = hasCorrelationFilters(correlationFilters);

    // See handleViewQualityCorrelation above — under a correlation filter
    // both projections fold from the same backend payload, so fetch once.
    const cqEvents = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW, correlationFilters);
    const cqView = correlationFiltered
      ? materializeFiltered<CodeQualityViewState>(materializer, CODE_QUALITY_VIEW, cqEvents)
      : materializer.materialize<CodeQualityViewState>(
          streamId,
          CODE_QUALITY_VIEW,
          cqEvents,
        );

    const erEvents = correlationFiltered
      ? cqEvents
      : await queryDeltaEvents(store, materializer, streamId, EVAL_RESULTS_VIEW);
    const erView = correlationFiltered
      ? materializeFiltered<EvalResultsViewState>(materializer, EVAL_RESULTS_VIEW, erEvents)
      : materializer.materialize<EvalResultsViewState>(
          streamId,
          EVAL_RESULTS_VIEW,
          erEvents,
        );

    // AttributionQuery.timeRange expects ISO 8601 duration string (e.g., 'P7D'),
    // but the MCP handler receives { start, end } — compute duration from the range
    let timeRange: string | undefined;
    if (args.timeRange) {
      const startMs = Date.parse(args.timeRange.start);
      const endMs = Date.parse(args.timeRange.end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        return {
          success: false,
          error: {
            code: 'VIEW_ERROR',
            message: 'Invalid timeRange: expected ISO timestamps with end >= start',
          },
        };
      }
      const diffDays = Math.max(1, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)));
      timeRange = `P${diffDays}D`;
    }
    const query = {
      dimension: dimension as AttributionDimension,
      skill: args.skill,
      timeRange,
    };
    const attribution = computeAttribution(query, cqView, erView);
    return { success: true, data: attribution };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Session Provenance Handler ─────────────────────────────────────────

export async function handleViewSessionProvenance(
  args: { sessionId?: string; workflowId?: string; metric?: string },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.sessionId && !args.workflowId) {
    return {
      success: false,
      error: {
        code: 'INVALID_QUERY',
        message: 'Either sessionId or workflowId is required',
      },
    };
  }

  if (args.sessionId && args.workflowId) {
    return {
      success: false,
      error: {
        code: 'INVALID_QUERY',
        message: 'Provide sessionId or workflowId, not both',
      },
    };
  }

  const validMetrics = new Set(['cost', 'attribution']);
  const metric = args.metric && validMetrics.has(args.metric)
    ? (args.metric as 'cost' | 'attribution')
    : undefined;

  try {
    const { materializeSessionProvenance } = await import(
      '../session/session-provenance-projection.js'
    );
    const result = await materializeSessionProvenance(stateDir, {
      sessionId: args.sessionId,
      workflowId: args.workflowId,
      metric,
    });
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Delegation Readiness Handler ──────────────────────────────────────

export async function handleViewDelegationReadiness(
  args: { workflowId?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, DELEGATION_READINESS_VIEW);
    const view = materializer.materialize<DelegationReadinessState>(
      streamId,
      DELEGATION_READINESS_VIEW,
      events,
    );

    return { success: true, data: view };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Synthesis Readiness Handler ────────────────────────────────────────

export async function handleViewSynthesisReadiness(
  args: { workflowId?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, SYNTHESIS_READINESS_VIEW);
    const view = materializer.materialize<SynthesisReadinessState>(
      streamId,
      SYNTHESIS_READINESS_VIEW,
      events,
    );

    // Fix 2 (#1184) — review status is plan-state stamped via `workflow set`
    // (state.reviews); the synthesis-readiness projection only watches
    // `gate.executed`, so reviews recorded directly into state.json never
    // surface as passed. state.json is the planner's source of truth — when
    // an entry exists there, prefer it; otherwise fall back to the projection.
    // This avoids a stale projection-derived `true` sticking after the
    // planner re-stamps a review back to a non-passed status.
    const state = await readWorkflowStateJson(stateDir, streamId);
    const reviews = (state?.['reviews'] as Record<string, unknown> | undefined) ?? {};
    const reviewStatus = (
      key: string,
    ): { present: boolean; passed: boolean } => {
      const r = reviews[key];
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        return { present: false, passed: false };
      }
      return {
        present: true,
        passed: (r as Record<string, unknown>)['status'] === 'passed',
      };
    };
    const review = reviewStatus('review');
    const reviewPassed = review.present ? review.passed : view.review.reviewPassed;

    // Fix 2 (#1184) — task counts: the projection counts events; state.json
    // is the planner's stamp. Both `total` AND `completed` need the
    // state.json fallback — projection-derived completed count is
    // event-driven, so in the missing-event flows this PR is fixing it
    // would underreport (state.tasks shows complete but no task.completed
    // event ever fired). CR review 4178067854.
    const stateTasks = state?.['tasks'];
    const tasksTotal = Array.isArray(stateTasks) ? stateTasks.length : view.tasks.total;
    const tasksCompleted = Array.isArray(stateTasks)
      ? stateTasks.filter((t) => {
          if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
          const status = (t as Record<string, unknown>)['status'];
          return status === 'complete' || status === 'completed';
        }).length
      : view.tasks.completed;

    // Fix 2 (T2.6) — distinguish null (not measured) from false (failed) when
    // generating blocker text. The projection's tests.* fields initialize to
    // null; only `test.result` / `typecheck.result` events flip them to a
    // boolean. Saying "tests not passing" when no test ever ran is misleading.
    const blockers: string[] = [];
    if (tasksTotal === 0) {
      blockers.push('no tasks tracked');
    } else if (tasksCompleted !== tasksTotal) {
      blockers.push(
        `tasks incomplete: ${tasksCompleted}/${tasksTotal} completed`,
      );
    }
    if (!reviewPassed) blockers.push('review not passed');
    if (view.tests.lastRunPassed === null) {
      blockers.push('tests not measured');
    } else if (view.tests.lastRunPassed !== true) {
      blockers.push('tests not passing');
    }
    if (view.tests.typecheckPassed === null) {
      blockers.push('typecheck not measured');
    } else if (view.tests.typecheckPassed !== true) {
      blockers.push('typecheck not passing');
    }
    if (view.stack.conflicts) blockers.push('stack has unresolved conflicts');

    const ready = blockers.length === 0;
    const data: SynthesisReadinessState = {
      ...view,
      ready,
      blockers,
      tasks: { ...view.tasks, total: tasksTotal, completed: tasksCompleted },
      review: { ...view.review, reviewPassed },
    };

    return { success: true, data };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Shepherd Status Handler ────────────────────────────────────────────

export async function handleViewShepherdStatus(
  args: { workflowId?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, SHEPHERD_STATUS_VIEW);
    const view = materializer.materialize<ShepherdStatusState>(
      streamId,
      SHEPHERD_STATUS_VIEW,
      events,
    );

    return { success: true, data: view };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Provenance Handler ──────────────────────────────────────────────

export async function handleViewProvenance(
  args: { workflowId?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, PROVENANCE_VIEW);
    const view = materializer.materialize<ProvenanceViewState>(
      streamId,
      PROVENANCE_VIEW,
      events,
    );

    return { success: true, data: view };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── View Convergence Handler ──────────────────────────────────────────────

export async function handleViewConvergence(
  args: { workflowId?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, CONVERGENCE_VIEW);
    const view = materializer.materialize<ConvergenceViewState>(
      streamId,
      CONVERGENCE_VIEW,
      events,
    );

    // Fix 2 (#1184) — when `gate.executed` events don't cover all dimensions,
    // fall back to `state.reviews.findingsByDimension`. The reviewer stamps
    // findings into state.json via `workflow set` even when the gate harness
    // didn't run, so an unchecked dimension here may still have ground-truth
    // data that should mark it as covered. We don't synthesize gate results
    // (we lack pass/fail timestamps), but we DO remove the dimension from
    // `uncheckedDimensions` so consumers stop blocking on a phantom gap.
    const state = await readWorkflowStateJson(stateDir, streamId);
    const reviews = state?.['reviews'];
    const findingsByDimension =
      reviews && typeof reviews === 'object' && !Array.isArray(reviews)
        ? (reviews as Record<string, unknown>)['findingsByDimension']
        : undefined;
    if (
      findingsByDimension &&
      typeof findingsByDimension === 'object' &&
      !Array.isArray(findingsByDimension) &&
      view.uncheckedDimensions.length > 0
    ) {
      const covered = new Set(Object.keys(findingsByDimension as Record<string, unknown>));
      const remaining = view.uncheckedDimensions.filter((d) => !covered.has(d));
      if (remaining.length !== view.uncheckedDimensions.length) {
        return {
          success: true,
          data: { ...view, uncheckedDimensions: remaining },
        };
      }
    }

    return { success: true, data: view };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
