import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import { formatResult, type ToolResult } from '../format.js';
import { ViewMaterializer } from './materializer.js';
import { SnapshotStore } from './snapshot-store.js';
import {
  workflowStatusProjection,
  WORKFLOW_STATUS_VIEW,
} from './workflow-status-view.js';
import type { WorkflowStatusViewState } from './workflow-status-view.js';
import {
  teamStatusProjection,
  TEAM_STATUS_VIEW,
} from './team-status-view.js';
import type { TeamStatusViewState } from './team-status-view.js';
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

// ─── Helper: create a materializer with all projections registered ─────────

function createMaterializer(stateDir: string): ViewMaterializer {
  const snapshotStore = new SnapshotStore(stateDir);
  const materializer = new ViewMaterializer({ snapshotStore });
  materializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);
  materializer.register(TEAM_STATUS_VIEW, teamStatusProjection);
  materializer.register(TASK_DETAIL_VIEW, taskDetailProjection);
  materializer.register(PIPELINE_VIEW, pipelineProjection);
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
}

// ─── Helper: discover all event stream files ───────────────────────────────

async function discoverStreams(stateDir: string): Promise<string[]> {
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

    await materializer.loadFromSnapshot(streamId, WORKFLOW_STATUS_VIEW);
    const events = await store.query(streamId);
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

// ─── View Team Status Handler ──────────────────────────────────────────────

export async function handleViewTeamStatus(
  args: { workflowId?: string },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    await materializer.loadFromSnapshot(streamId, TEAM_STATUS_VIEW);
    const events = await store.query(streamId);
    const view = materializer.materialize<TeamStatusViewState>(
      streamId,
      TEAM_STATUS_VIEW,
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
  args: { workflowId?: string; filter?: Record<string, unknown> },
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    await materializer.loadFromSnapshot(streamId, TASK_DETAIL_VIEW);
    const events = await store.query(streamId);
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
  args: Record<string, unknown>,
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);

    // Discover all streams and materialize pipeline view for each
    const streamIds = await discoverStreams(stateDir);
    const workflows: PipelineViewState[] = [];

    for (const streamId of streamIds) {
      await materializer.loadFromSnapshot(streamId, PIPELINE_VIEW);
      const events = await store.query(streamId);
      const view = materializer.materialize<PipelineViewState>(
        streamId,
        PIPELINE_VIEW,
        events,
      );
      workflows.push(view);
    }

    return { success: true, data: { workflows } };
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

export function registerViewTools(server: McpServer, stateDir: string): void {
  server.tool(
    'exarchos_view_pipeline',
    'Get CQRS pipeline view aggregating all workflows with stack positions and phase tracking',
    {},
    async (args) => formatResult(await handleViewPipeline(args, stateDir)),
  );

  server.tool(
    'exarchos_view_tasks',
    'Get CQRS task detail view with optional filtering by workflowId and task properties',
    {
      workflowId: z.string().optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => formatResult(await handleViewTasks(args, stateDir)),
  );

  server.tool(
    'exarchos_view_workflow_status',
    'Get CQRS workflow status view with phase, task counts, and feature metadata',
    { workflowId: z.string().optional() },
    async (args) => formatResult(await handleViewWorkflowStatus(args, stateDir)),
  );

  server.tool(
    'exarchos_view_team_status',
    'Get CQRS team status view with teammate composition and current task assignments',
    { workflowId: z.string().optional() },
    async (args) => formatResult(await handleViewTeamStatus(args, stateDir)),
  );
}
