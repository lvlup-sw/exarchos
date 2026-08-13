// ─── Task MCP Tool Handlers ─────────────────────────────────────────────────

import * as path from 'node:path';
import { EventStore, SequenceConflictError } from '../events/store.js';
import { validateAgentEvent } from '../events/schemas.js';
import { toEventAck, type ToolResult } from '../format.js';
import { getOrCreateMaterializer, resetMaterializerCache } from '../projections/views/tools.js';
import { TASK_DETAIL_VIEW } from '../projections/views/task-detail-view.js';
import type { TaskDetailViewState } from '../projections/views/task-detail-view.js';
import { readStateFile, writeStateFile, VersionConflictError } from '../workflow/state-store.js';
import type { WorkflowState } from '../workflow/types.js';
import { logger } from '../logger.js';
import { getFullRegistry } from '../registry.js';
import { getDispatchContext } from '../dispatch/dispatch-context.js';

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

// ─── streamId ⇄ featureId ────────────────────────────────────────────────────
//
// The workflow event stream id IS the bare featureId — asserted across the
// codebase (`next-actions-computer.ts` derives `const streamId =
// state.featureId`; `operations-fold.ts` documents "surfaces where `streamId`
// IS the featureId"). The task verbs nonetheless took `streamId` as a REQUIRED
// parameter and did not accept `featureId` at all.
//
// The cost of that was not a wrong answer, it was a wrong QUESTION: an agent
// holding the featureId — which is what every workflow surface, prompt and
// playbook names — had no way to satisfy a schema asking for `streamId`, so it
// asked the operator for a value it already had under another name. A required
// parameter that the caller can only supply by knowing an internal identity
// equation is a parameter that gets asked about.
//
// Both spellings are now accepted and exactly one is required. `streamId` still
// wins when both are given, so no existing caller changes behaviour. This is
// deliberately ONE resolver rather than a copy per verb — three copies of an
// identity equation is the multiply-owned-representation defect DR-6 exists to
// detect, and it is how the spellings would drift apart later.
export interface StreamIdentityArgs {
  readonly streamId?: string;
  readonly featureId?: string;
}

export type StreamIdentity =
  | { readonly ok: true; readonly streamId: string }
  | { readonly ok: false; readonly error: ToolResult };

export function resolveStreamIdentity(args: StreamIdentityArgs): StreamIdentity {
  const streamId = args.streamId ?? args.featureId;
  if (!streamId) {
    return {
      ok: false,
      error: {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          // Names BOTH accepted spellings and the equation between them, so the
          // remedy is readable off the error rather than inferred from source.
          message:
            'streamId is required (featureId is accepted as an alias — the ' +
            'workflow stream id is the bare featureId)',
        },
      },
    };
  }
  return { ok: true, streamId };
}

// ─── Gate blocking-ness (DR-2) ──────────────────────────────────────────────

/**
 * Is `gateName` a BLOCKING gate?
 *
 * Single source of truth: the tool registry's existing `action.gate` metadata,
 * keyed by the shared mechanical `gate.gateClass` (e.g. `check_static_analysis`
 * declares `{ blocking: true, dimension: 'D2', gateClass: 'static-analysis' }`).
 * Reading the declared model — rather than restating "which gates are
 * blocking" here — means a registry edit that flips a gate to advisory is
 * honoured automatically, and no parallel notion of blocking can drift.
 *
 * FAILS CLOSED: a gate class with no registration, or a registration that
 * omits `gate`, is treated as blocking. An unrecognised gate is the case where
 * we know least, so it gets the strongest protection.
 */
export function isBlockingGate(gateName: string): boolean {
  for (const tool of getFullRegistry()) {
    for (const action of tool.actions) {
      if (action.gate?.gateClass === gateName) return action.gate.blocking;
    }
  }
  return true;
}

// ─── resetModuleEventStore (delegates to the shared materializer cache) ──────

/**
 * Reset the shared materializer cache used by the task module. The
 * constructor-injection refactor (#1182) deleted the module-global
 * EventStore this used to also clear, but the materializer cache in
 * `projections/views/tools.ts` is still shared across tests in the same process and
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
    streamId?: string;
    featureId?: string;
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

  const identity = resolveStreamIdentity(args);
  if (!identity.ok) return identity.error;
  const streamId = identity.streamId;

  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    try {
      return await attemptTaskClaim({ ...args, streamId }, stateDir, eventStore);
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
  const { streamId } = args;
  const materializer = getOrCreateMaterializer(stateDir);
  const store = eventStore;

  // Load snapshot (if any) and query all events for the stream
  await materializer.loadFromSnapshot(streamId, TASK_DETAIL_VIEW);
  const events = await store.query(streamId);
  const currentSequence = events.length;

  // Materialize the task-detail view to check claim status
  const view = materializer.materialize<TaskDetailViewState>(
    streamId,
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
    streamId,
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
    streamId?: string;
    featureId?: string;
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

  const identity = resolveStreamIdentity(args);
  if (!identity.ok) return identity.error;
  const streamId = identity.streamId;

  const store = eventStore;

  // ─── DR-2: the governed cannot supply its own governance ─────────────────
  //
  // `evidence` has TWO distinct jobs, and only one of them is legitimate:
  //
  //   1. RECORD — provenance stamped onto `task.completed` (`data.evidence`
  //      plus the `verified` flag). Unchanged below; a caller may always
  //      describe how it verified its work.
  //   2. GATE SATISFACTION — standing in for a gate that was never run.
  //      This is the hole. `args.evidence` arrives FROM THE AGENT BEING
  //      GOVERNED, so honouring it lets the subject of governance mint its
  //      own proof of compliance.
  //
  // The rule: caller-supplied evidence can NEVER satisfy a BLOCKING gate, and
  // for a non-blocking (advisory) gate it requires an explicit OPERATOR
  // capability. Blocking-ness is read from the existing registry model
  // (`action.gate.blocking`, keyed by `gate.gateClass`) rather than a second,
  // drifting notion of "blocking" maintained here.
  const evidenceIsSubstantive =
    args.evidence?.passed === true && (args.evidence.output ?? '').trim().length > 0;

  // The operator capability, taken from the SAME trust-tier mechanism that
  // produces CAPABILITY_DENIED for shared-mutating actions: the ambient
  // DispatchContext authorization. `identity.role` is derived by the
  // transport (`deriveLocalOperatorIdentity` / `deriveMcpCallerIdentity`) and
  // can never be self-asserted by the caller, which is exactly the property
  // this check needs. A delegated agent is `role: 'agent'` and therefore
  // cannot clear this bar no matter what it puts in `args.evidence`.
  // Fails closed: no dispatch context (direct in-process call) ⇒ no operator.
  const authorization = getDispatchContext()?.authorization;
  const hasOperatorCapability =
    authorization !== undefined &&
    authorization.identity.role === 'operator' &&
    authorization.posture !== 'read-only';

  /**
   * May caller-supplied evidence stand in for `gateName`?
   *
   * Fails closed on every unknown: a gate absent from the registry, or one
   * whose registration omits `blocking`, is treated as BLOCKING.
   */
  const evidenceMaySatisfy = (gateName: string): boolean => {
    if (!evidenceIsSubstantive) return false;
    if (isBlockingGate(gateName)) return false;
    return hasOperatorCapability;
  };

  // Gate enforcement (DR-1): `gate.executed` is THE gate-executed signal, and
  // for every gate class the durable runner owns it has exactly ONE producer —
  // `verbs/gates/gate-runner.ts` (`appendGateExecutedSignal`), which mints the
  // row from the same persisted `admission.evidence-recorded` proof it just
  // wrote. Before that unification the migrated producers appended ONLY the
  // evidence record, so a legitimate `check_static_analysis` run could not be
  // seen by the `task_complete` that followed it. Read one event type, one
  // shape — do NOT teach this reader to also accept the proof record; the fix
  // belongs at the producer.
  const gateEvents = await store.query(streamId, { type: 'gate.executed' });

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
  // #1587: the retired test-FIRST `tdd-compliance` gate is no longer a hard
  // task_complete requirement. Per-task verification is now the TIER-SCALED
  // `check_test_adequacy` kill probe, enforced by the TASK_COMPLETION runbook
  // chain's `onFail:'stop'` ordering (it runs BEFORE task_complete and skips
  // by policy for low-tier tasks) — so it must NOT be a universal hard-gate
  // here, where the tier is unknown. `static-analysis` stays universal.
  if (!evidenceMaySatisfy('static-analysis') && !hasPassingGate('static-analysis')) {
    unmetGates.push('static-analysis');
  }
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
    // #1208 / DR-MO-1, DR-MO-2 — forward the worktree association so the
    // rehydration projection's merge-pending detour fires (the HSM
    // `mergePendingEntry` guard reads `data.worktree` / `data.worktreePath`
    // on the latest task.completed). Pre-fix these fields were silently
    // dropped here, so the auto-detour documented in
    // `content/delivery/skills/delegate/SKILL.md` § "Worktree-Bearing Tasks" never
    // triggered.
    if (typeof args.result.worktree === 'string' && args.result.worktree.length > 0) {
      data.worktree = args.result.worktree;
    }
    if (
      typeof args.result.worktreePath === 'string' &&
      args.result.worktreePath.length > 0
    ) {
      data.worktreePath = args.result.worktreePath;
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
    const event = await store.append(streamId, {
      type: 'task.completed',
      data,
    }, { idempotencyKey: `${streamId}:task.completed:${args.taskId}` });

    // Sync task status to workflow state file so guards (e.g. allTasksComplete) pass.
    // Uses CAS (compare-and-swap) with retry to prevent lost updates under parallel delegation.
    const stateFile = path.join(stateDir, `${streamId}.state.json`);
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const state = await readStateFile(stateFile);
        if (!Array.isArray(state.tasks)) {
          logger.warn(
            { streamId: streamId, taskId: args.taskId, attempt },
            'task_complete state sync skipped: state.tasks is not an array',
          );
          break;
        }
        const tasks = state.tasks as Array<{ id: string; status: string }>;
        const task = tasks.find((t) => t.id === args.taskId);
        if (!task) {
          logger.warn(
            { streamId: streamId, taskId: args.taskId, attempt },
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
          { streamId: streamId, taskId: args.taskId, attempt, err: syncErr instanceof Error ? syncErr.message : String(syncErr) },
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
    streamId?: string;
    featureId?: string;
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

  const identity = resolveStreamIdentity(args);
  if (!identity.ok) return identity.error;
  const streamId = identity.streamId;

  const store = eventStore;

  const data: Record<string, unknown> = {
    taskId: args.taskId,
    error: args.error,
  };

  if (args.diagnostics) {
    data.diagnostics = args.diagnostics;
  }

  try {
    const event = await store.append(streamId, {
      type: 'task.failed',
      data,
    }, { idempotencyKey: `${streamId}:task.failed:${args.taskId}` });

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

