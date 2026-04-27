// ─── Task MCP Tool Handlers ─────────────────────────────────────────────────

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'node:path';
import { EventStore, SequenceConflictError } from '../event-store/store.js';
import { validateAgentEvent } from '../event-store/schemas.js';
import { formatResult, toEventAck, type ToolResult } from '../format.js';
import { getOrCreateMaterializer, resetMaterializerCache } from '../views/tools.js';
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

// ─── resetModuleEventStore (delegates to the shared materializer cache) ──────

/**
 * Reset the shared materializer cache used by the task module. The
 * constructor-injection refactor (#1182) deleted the module-global
 * EventStore this used to also clear, but the materializer cache in
 * `views/tools.ts` is still shared across tests in the same process and
 * needs to be cleared between cases for proper isolation. Per CR review
 * 4178011813 — a no-op shim was misleading; do the actual reset.
 */
export function resetModuleEventStore(): void {
  resetMaterializerCache();
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
  eventStore: EventStore,
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
      return await attemptTaskClaim(args, stateDir, eventStore);
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
  eventStore: EventStore,
): Promise<ToolResult> {
  const materializer = getOrCreateMaterializer(stateDir);
  const store = eventStore;

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
  eventStore: EventStore,
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

  const store = eventStore;

  // Evidence-based bypass (#1189): orthogonal to evidence.type (SRP —
  // separate "what kind of proof" from "whether to skip prerequisites").
  // Any evidence with passed===true AND substantive (non-empty) output
  // asserts work succeeded; the type tag is metadata about the proof,
  // not the override mechanism. Preserves the original `type === 'manual'`
  // behavior (#940) since manual evidence will satisfy passed===true plus
  // a non-empty output.
  const evidenceBypass =
    args.evidence?.passed === true && (args.evidence.output ?? '').length > 0;

  // Gate enforcement: verify D1 (TDD compliance) and D2 (static analysis) gates passed for this task
  const gateEvents = await store.query(args.streamId, { type: 'gate.executed' });

  // Tolerant Reader (#1189): taskId may live at `data.details.taskId`
  // (canonical handler-emitted shape) or at `data.taskId` (operator-emitted
  // shape, e.g. when satisfying a gate manually via exarchos_event append).
  // Both shapes are valid per the GateExecutedData schema (which is not
  // .strict()). If a top-level taskId is present, it is authoritative;
  // otherwise fall back to the canonical details.taskId, with a missing
  // taskId on the canonical path indicating a project-wide gate.
  const hasPassingGate = (gateName: string): boolean =>
    gateEvents.some((e) => {
      const d = e.data as Record<string, unknown> | undefined;
      if (!d) return false;
      if (d.gateName !== gateName || d.passed !== true) return false;
      if (typeof d.taskId === 'string') {
        return d.taskId === args.taskId;
      }
      const details = d.details as Record<string, unknown> | undefined;
      return details != null && (!details.taskId || details.taskId === args.taskId);
    });

  const unmetGates: string[] = [];
  if (!evidenceBypass && !hasPassingGate('tdd-compliance')) unmetGates.push('tdd-compliance');
  if (!evidenceBypass && !hasPassingGate('static-analysis')) unmetGates.push('static-analysis');
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
        if (!Array.isArray(state.tasks)) {
          logger.warn(
            { streamId: args.streamId, taskId: args.taskId, attempt },
            'task_complete state sync skipped: state.tasks is not an array',
          );
          break;
        }
        const tasks = state.tasks as Array<{ id: string; status: string }>;
        const task = tasks.find((t) => t.id === args.taskId);
        if (!task) {
          logger.warn(
            { streamId: args.streamId, taskId: args.taskId, attempt },
            'task_complete state sync skipped: task not found in state.tasks',
          );
          break;
        }
        task.status = 'complete';
        const rawVersion = (state as Record<string, unknown>)._version;
        const version = typeof rawVersion === 'number' ? rawVersion : 1;
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
  _stateDir: string,
  eventStore: EventStore,
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

  const store = eventStore;

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

export function registerTaskTools(server: McpServer, stateDir: string, eventStore: EventStore): void {
  server.tool(
    'exarchos_task_claim',
    'Claim a task for execution by an agent',
    {
      taskId: z.string().min(1),
      agentId: z.string().min(1),
      streamId: z.string().min(1),
    },
    async (args) => formatResult(await handleTaskClaim(args, stateDir, eventStore)),
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
    async (args) => formatResult(await handleTaskComplete(args, stateDir, eventStore)),
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
    async (args) => formatResult(await handleTaskFail(args, stateDir, eventStore)),
  );
}
