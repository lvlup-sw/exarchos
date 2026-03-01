import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { formatResult, pickFields, type ToolResult } from '../format.js';
import { ViewMaterializer } from './materializer.js';
import { SnapshotStore } from './snapshot-store.js';
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
} from './pipeline-view.js';
import type { PipelineViewState } from './pipeline-view.js';
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
  ideateReadinessProjection,
  IDEATE_READINESS_VIEW,
} from './ideate-readiness-view.js';
import type { IdeateReadinessState } from './ideate-readiness-view.js';
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
import { detectRegressions, emitRegressionEvents } from '../quality/regression-detector.js';
import type { FailureTracker } from '../quality/regression-detector.js';
import { computeAttribution, isValidDimension } from '../quality/attribution.js';
import type { AttributionDimension } from '../quality/attribution.js';

// ─── Helper: create a materializer with all projections registered ─────────

function createMaterializer(stateDir: string): ViewMaterializer {
  const snapshotStore = new SnapshotStore(stateDir);
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
  materializer.register(IDEATE_READINESS_VIEW, ideateReadinessProjection);
  materializer.register(SYNTHESIS_READINESS_VIEW, synthesisReadinessProjection);
  materializer.register(SHEPHERD_STATUS_VIEW, shepherdStatusProjection);
  materializer.register(PROVENANCE_VIEW, provenanceProjection);
  return materializer;
}

// ─── Singleton Cache for ViewMaterializer and EventStore ──────────────────
//
// Design rationale: Module-level mutable state is appropriate here because
// the MCP server is single-threaded, processing one tool request at a time
// over stdio. There is no concurrent access, so no synchronization is needed.
// The cache avoids recreating EventStore and ViewMaterializer on every query,
// which would discard the materializer's high-water marks and force full
// event replay. Cache entries are only invalidated when stateDir changes,
// ensuring both instances remain valid for the active working directory.

// ─── Module-Level EventStore (injected via registerViewTools) ────────────────

let moduleEventStore: EventStore | null = null;

let cachedMaterializer: ViewMaterializer | null = null;
let cachedEventStore: EventStore | null = null;
let cachedStateDir: string | null = null;

/** @internal Exported for testing only */
export function getOrCreateMaterializer(stateDir: string): ViewMaterializer {
  if (cachedMaterializer && cachedStateDir === stateDir) {
    return cachedMaterializer;
  }
  // Only invalidate EventStore when stateDir actually changes
  if (cachedStateDir !== null && cachedStateDir !== stateDir) {
    cachedEventStore = null;
  }
  cachedMaterializer = createMaterializer(stateDir);
  cachedStateDir = stateDir;
  return cachedMaterializer;
}

/** @internal Exported for testing only */
export function getOrCreateEventStore(stateDir: string): EventStore {
  if (moduleEventStore) {
    return moduleEventStore;
  }
  if (cachedEventStore && cachedStateDir === stateDir) {
    return cachedEventStore;
  }
  // Only invalidate materializer when stateDir actually changes
  if (cachedStateDir !== null && cachedStateDir !== stateDir) {
    cachedMaterializer = null;
  }
  cachedEventStore = new EventStore(stateDir);
  cachedStateDir = stateDir;
  return cachedEventStore;
}

/** For testing: reset the singleton cache */
export function resetMaterializerCache(): void {
  cachedMaterializer = null;
  cachedEventStore = null;
  cachedStateDir = null;
  moduleEventStore = null;
}

// ─── Helper: query delta events using materializer high-water mark ──────────

/** @internal Exported for CLI commands and testing */
export async function queryDeltaEvents(
  store: EventStore,
  materializer: ViewMaterializer,
  streamId: string,
  viewName: string,
): Promise<WorkflowEvent[]> {
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

// ─── Helper: discover all event stream files ───────────────────────────────

async function discoverStreams(stateDir: string, store?: EventStore): Promise<string[]> {
  // When a storage backend is available, use it for stream discovery
  // (equivalent to SELECT DISTINCT streamId FROM events)
  if (store) {
    const backendStreams = store.listStreams();
    if (backendStreams !== null) {
      return backendStreams;
    }
  }

  // Fallback: scan directory for .events.jsonl files
  try {
    const files = await fs.readdir(stateDir);
    return files
      .filter((f) => f.endsWith('.events.jsonl'))
      .map((f) => f.replace('.events.jsonl', ''));
  } catch {
    return [];
  }
}

// ─── View Workflow Status Handler ──────────────────────────────────────────

export async function handleViewWorkflowStatus(
  args: { workflowId?: string },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, WORKFLOW_STATUS_VIEW);
    const view = materializer.materialize<WorkflowStatusViewState>(
      streamId,
      WORKFLOW_STATUS_VIEW,
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
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, TASK_DETAIL_VIEW);
    const view = materializer.materialize<TaskDetailViewState>(
      streamId,
      TASK_DETAIL_VIEW,
      events,
    );

    let tasks: TaskDetail[] = Object.values(view.tasks);

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

export async function handleViewPipeline(
  args: { limit?: number; offset?: number },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);

    // Discover all streams and paginate IDs before materialization
    const streamIds = await discoverStreams(stateDir, store);
    const total = streamIds.length;
    const start = args.offset ?? 0;
    const end = args.limit !== undefined ? start + args.limit : undefined;
    const paginatedIds = streamIds.slice(start, end);

    // Only materialize the paginated subset
    const workflows: PipelineViewState[] = [];

    for (const streamId of paginatedIds) {
      const events = await queryDeltaEvents(store, materializer, streamId, PIPELINE_VIEW);
      const view = materializer.materialize<PipelineViewState>(
        streamId,
        PIPELINE_VIEW,
        events,
      );
      workflows.push(view);
    }

    return { success: true, data: { workflows, total } };
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
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
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
  args: { workflowId?: string },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, DELEGATION_TIMELINE_VIEW);
    const view = materializer.materialize<DelegationTimelineViewState>(
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
  },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW);
    const view = materializer.materialize<CodeQualityViewState>(
      streamId,
      CODE_QUALITY_VIEW,
      events,
    );

    // Detect and emit quality regressions with deduplication
    // _failureTrackers is a non-enumerable property set by code-quality-view.ts
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
        } catch { /* fire-and-forget: emission failure must not break the view query */ }
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
  },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, EVAL_RESULTS_VIEW);
    const view = materializer.materialize<EvalResultsViewState>(
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
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
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
  args: { workflowId?: string },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const cqEvents = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW);
    const cqView = materializer.materialize<CodeQualityViewState>(
      streamId,
      CODE_QUALITY_VIEW,
      cqEvents,
    );

    const erEvents = await queryDeltaEvents(store, materializer, streamId, EVAL_RESULTS_VIEW);
    const erView = materializer.materialize<EvalResultsViewState>(
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
  },
  stateDir: string,
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
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const cqEvents = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW);
    const cqView = materializer.materialize<CodeQualityViewState>(
      streamId,
      CODE_QUALITY_VIEW,
      cqEvents,
    );

    const erEvents = await queryDeltaEvents(store, materializer, streamId, EVAL_RESULTS_VIEW);
    const erView = materializer.materialize<EvalResultsViewState>(
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
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
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
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, SYNTHESIS_READINESS_VIEW);
    const view = materializer.materialize<SynthesisReadinessState>(
      streamId,
      SYNTHESIS_READINESS_VIEW,
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

// ─── View Shepherd Status Handler ────────────────────────────────────────────

export async function handleViewShepherdStatus(
  args: { workflowId?: string },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
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
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
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

// ─── View Ideate Readiness Handler ────────────────────────────────────────

export async function handleViewIdeateReadiness(
  args: { workflowId?: string },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, IDEATE_READINESS_VIEW);
    const view = materializer.materialize<IdeateReadinessState>(
      streamId,
      IDEATE_READINESS_VIEW,
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

// ─── Registration Function ──────────────────────────────────────────────────

export function registerViewTools(server: McpServer, stateDir: string, eventStore: EventStore): void {
  moduleEventStore = eventStore;
  server.tool(
    'exarchos_view_pipeline',
    'Get CQRS pipeline view aggregating all workflows with stack positions and phase tracking',
    {
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (args) => formatResult(await handleViewPipeline(args, stateDir)),
  );

  server.tool(
    'exarchos_view_tasks',
    'Get CQRS task detail view with optional filtering by workflowId and task properties, pagination, and field projection',
    {
      workflowId: z.string().optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      fields: z.array(z.string()).optional(),
    },
    async (args) => formatResult(await handleViewTasks(args, stateDir)),
  );

  server.tool(
    'exarchos_view_workflow_status',
    'Get CQRS workflow status view with phase, task counts, and feature metadata',
    { workflowId: z.string().optional() },
    async (args) => formatResult(await handleViewWorkflowStatus(args, stateDir)),
  );

}
