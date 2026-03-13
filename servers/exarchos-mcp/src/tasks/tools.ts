// ─── Task MCP Tool Handlers ─────────────────────────────────────────────────

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'node:path';
import { EventStore, SequenceConflictError } from '../event-store/store.js';
import { validateAgentEvent } from '../event-store/schemas.js';
import { formatResult, toEventAck, type ToolResult } from '../format.js';
import { getOrCreateMaterializer, getOrCreateEventStore } from '../views/tools.js';
import { TASK_DETAIL_VIEW } from '../views/task-detail-view.js';
import type { TaskDetailViewState } from '../views/task-detail-view.js';
import { readStateFile, writeStateFile, VersionConflictError } from '../workflow/state-store.js';
import type { WorkflowState } from '../workflow/types.js';
import { logger } from '../logger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const CLAIM_BASE_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function alreadyClaimedResult(taskId: string): ToolResult {
  return {
    success: false,
    error: {
      code: 'ALREADY_CLAIMED',
      message: `Task '${taskId}' is already claimed`,
    },
  };
}

// ─── resetModuleEventStore (kept for backward compat with existing tests) ───

/** For testing: reset task module state. Now delegates to the shared singleton cache. */
export function resetModuleEventStore(): void {
  // No module-level state to reset; the shared singleton in views/tools.ts
  // is reset via resetMaterializerCache(). This export is kept so existing
  // test files that call resetModuleEventStore() continue to compile.
}

// ─── handleTaskClaim ──────────────────────────────────────────────────────

const MAX_CLAIM_RETRIES = 3;

export async function handleTaskClaim(
  args: {
    taskId: string;
    agentId: string;
    streamId: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!args.agentId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'agentId is required' },
    };
  }

  if (!args.streamId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'streamId is required' },
    };
  }

  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    try {
      return await attemptTaskClaim(args, stateDir);
    } catch (err) {
      if (err instanceof SequenceConflictError) {
        // Exponential backoff: baseDelay * 2^attempt + jitter
        const delay = CLAIM_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * CLAIM_BASE_DELAY_MS;
        await sleep(delay);
        continue; // Retry: re-query and re-check
      }
      return {
        success: false,
        error: {
          code: 'CLAIM_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    success: false,
    error: {
      code: 'CLAIM_FAILED',
      message: `Task claim failed after ${MAX_CLAIM_RETRIES} retries due to concurrent modifications`,
    },
  };
}

/** Attempt a single claim with optimistic concurrency via expectedSequence. */
async function attemptTaskClaim(
  args: { taskId: string; agentId: string; streamId: string },
  stateDir: string,
): Promise<ToolResult> {
  const materializer = getOrCreateMaterializer(stateDir);
  const store = getOrCreateEventStore(stateDir);

  // Load snapshot (if any) and query all events for the stream
  await materializer.loadFromSnapshot(args.streamId, TASK_DETAIL_VIEW);
  const events = await store.query(args.streamId);
  const currentSequence = events.length;

  // Materialize the task-detail view to check claim status
  const view = materializer.materialize<TaskDetailViewState>(
    args.streamId,
    TASK_DETAIL_VIEW,
    events,
  );

  // Check materialized view first (handles tasks with prior task.assigned event)
  const task = view.tasks[args.taskId];
  if (task && (task.status === 'claimed' || task.status === 'completed' || task.status === 'failed')) {
    return alreadyClaimedResult(args.taskId);
  }

  // Fallback: check raw events for terminal task states without prior task.assigned
  // (the view projection ignores claims for unassigned tasks)
  if (!task) {
    const isTerminal = events.some(
      (e) =>
        (e.type === 'task.claimed' || e.type === 'task.completed' || e.type === 'task.failed') &&
        (e.data as Record<string, unknown>)?.taskId === args.taskId,
    );
    if (isTerminal) {
      return alreadyClaimedResult(args.taskId);
    }
  }

  const claimEvent = {
    type: 'task.claimed' as const,
    data: {
      taskId: args.taskId,
      agentId: args.agentId,
      claimedAt: new Date().toISOString(),
    },
    agentId: args.agentId,
    source: 'exarchos-mcp',
  };

  // Validate agent event metadata before appending
  validateAgentEvent(claimEvent);

  const event = await store.append(
    args.streamId,
    claimEvent,
    { expectedSequence: currentSequence },
  );

  return { success: true, data: toEventAck(event) };
}

// ─── handleTaskComplete ───────────────────────────────────────────────────

export async function handleTaskComplete(
  args: {
    taskId: string;
    result?: Record<string, unknown>;
    evidence?: {
      type: 'test' | 'build' | 'typecheck' | 'manual';
      output: string;
      passed: boolean;
    };
    streamId: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!args.streamId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'streamId is required' },
    };
  }

  const store = getOrCreateEventStore(stateDir);

  // Manual evidence bypass: docs-only or non-code tasks can skip gate checks
  const manualBypass = args.evidence?.type === 'manual' && args.evidence.passed === true;

  // Gate enforcement: verify D1 (TDD compliance) and D2 (static analysis) gates passed for this task
  const gateEvents = await store.query(args.streamId, { type: 'gate.executed' });

  const hasPassingGate = (gateName: string): boolean =>
    gateEvents.some((e) => {
      const d = e.data as Record<string, unknown> | undefined;
      if (!d) return false;
      const details = d.details as Record<string, unknown> | undefined;
      return d.gateName === gateName && d.passed === true &&
        (details != null && (!details.taskId || details.taskId === args.taskId));
    });

  const unmetGates: string[] = [];
  if (!manualBypass && !hasPassingGate('tdd-compliance')) unmetGates.push('tdd-compliance');
  if (!manualBypass && !hasPassingGate('static-analysis')) unmetGates.push('static-analysis');
  if (unmetGates.length > 0) {
    return {
      success: false,
      error: {
        code: 'GATE_NOT_PASSED',
        message: `Required gates not passed: ${unmetGates.join(', ')}. Run these checks first.`,
        unmetGates,
      },
    };
  }

  const data: Record<string, unknown> = { taskId: args.taskId };
  if (args.result) {
    if (args.result.artifacts) {
      data.artifacts = args.result.artifacts;
    }
    if (args.result.duration !== undefined) {
      data.duration = args.result.duration;
    }
    if (args.result.implements) {
      data.implements = args.result.implements;
    }
    if (args.result.tests) {
      data.tests = args.result.tests;
    }
    if (args.result.files) {
      data.files = args.result.files;
    }
  }

  // Evidence storage: include evidence and set verified flag
  if (args.evidence) {
    data.evidence = args.evidence;
    data.verified = true;
  } else {
    data.verified = false;
  }

  try {
    const event = await store.append(args.streamId, {
      type: 'task.completed',
      data,
    }, { idempotencyKey: `${args.streamId}:task.completed:${args.taskId}` });

    // Sync task status to workflow state file so guards (e.g. allTasksComplete) pass.
    // Uses CAS (compare-and-swap) with retry to prevent lost updates under parallel delegation.
    const stateFile = path.join(stateDir, `${args.streamId}.state.json`);
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const state = await readStateFile(stateFile);
        if (!Array.isArray(state.tasks)) break;
        const tasks = state.tasks as Array<{ id: string; status: string }>;
        const task = tasks.find((t) => t.id === args.taskId);
        if (!task) break;
        task.status = 'complete';
        const version = (state as Record<string, unknown>)._version as number | undefined;
        (state as Record<string, unknown>).updatedAt = new Date().toISOString();
        await writeStateFile(stateFile, state, {
          expectedVersion: version,
          skipValidation: true,
        });
        break;
      } catch (syncErr) {
        if (syncErr instanceof VersionConflictError && attempt < maxAttempts) {
          continue; // Re-read and retry
        }
        logger.warn(
          { streamId: args.streamId, taskId: args.taskId, attempt, err: syncErr instanceof Error ? syncErr.message : String(syncErr) },
          'task_complete state sync failed',
        );
        break;
      }
    }

    return { success: true, data: toEventAck(event) };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'COMPLETE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── handleTaskFail ───────────────────────────────────────────────────────

export async function handleTaskFail(
  args: {
    taskId: string;
    error: string;
    diagnostics?: Record<string, unknown>;
    streamId: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  if (!args.error) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'error is required' },
    };
  }

  if (!args.streamId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'streamId is required' },
    };
  }

  const store = getOrCreateEventStore(stateDir);

  const data: Record<string, unknown> = {
    taskId: args.taskId,
    error: args.error,
  };

  if (args.diagnostics) {
    data.diagnostics = args.diagnostics;
  }

  try {
    const event = await store.append(args.streamId, {
      type: 'task.failed',
      data,
    }, { idempotencyKey: `${args.streamId}:task.failed:${args.taskId}` });

    return { success: true, data: toEventAck(event) };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'FAIL_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── Registration Function ──────────────────────────────────────────────────

export function registerTaskTools(server: McpServer, stateDir: string, _eventStore: EventStore): void {
  // eventStore parameter kept for backward compatibility but no longer used;
  // tasks now use the shared singleton from views/tools.ts
  server.tool(
    'exarchos_task_claim',
    'Claim a task for execution by an agent',
    {
      taskId: z.string().min(1),
      agentId: z.string().min(1),
      streamId: z.string().min(1),
    },
    async (args) => formatResult(await handleTaskClaim(args, stateDir)),
  );

  server.tool(
    'exarchos_task_complete',
    'Mark a task as complete with optional artifacts and evidence',
    {
      taskId: z.string().min(1),
      result: z.record(z.string(), z.unknown()).optional(),
      evidence: z.object({
        type: z.enum(['test', 'build', 'typecheck', 'manual']),
        output: z.string(),
        passed: z.boolean(),
      }).optional(),
      streamId: z.string().min(1),
    },
    async (args) => formatResult(await handleTaskComplete(args, stateDir)),
  );

  server.tool(
    'exarchos_task_fail',
    'Mark a task as failed with error details and optional diagnostics',
    {
      taskId: z.string().min(1),
      error: z.string().min(1),
      diagnostics: z.record(z.string(), z.unknown()).optional(),
      streamId: z.string().min(1),
    },
    async (args) => formatResult(await handleTaskFail(args, stateDir)),
  );
}
