/**
 * The `ps` lifecycle verb lists what is running or tracked now. It holds no fold logic. It routes by
 * scope and shapes the sections that three folds return.
 *
 * `scope` uses the shared `scopeField` shape from `schema-fields.ts`, so `pipeline` and `ps` declare one
 * `scope` definition on `exarchos_view`. Two different enum value sets make `buildRegistrationSchema`
 * throw. `ps` validates its own subset and rejects `repo`.
 *
 * Every scope is a pure read. The reclaim and reconcile writes are `exarchos_orchestrate.reconcile_worktrees`.
 */

import type { DispatchContext } from '../../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../../format.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import type {
  StorageBackend,
  WorkflowLifecycleStatus,
  WorkflowSummaryFilter,
} from '../../../storage/backend.js';
import {
  handleWorktreeScopePs,
  type WorktreeViewDeps,
} from '../../../verbs/worktree/handlers.js';
import {
  foldWorkflowSummaries,
  type WorkflowFoldRow,
} from './workflow-fold.js';
import {
  foldInFlightOperations,
  type InFlightOperation,
  type OperationEventLike,
} from './operations-fold.js';
import {
  LIVENESS_DESCRIPTORS,
  everyExecutingStartedType,
} from '../../../events/liveness-registry.js';
import { scopeField } from './schema-fields.js';

/** The `ps` scopes: the shared `scopeField` union without the `pipeline`-only `repo`. */
export type PsScope = 'workflow' | 'worktree' | 'all';

const PS_SCOPES: readonly PsScope[] = ['workflow', 'worktree', 'all'];

/** The workflow lifecycle statuses that a `ps --status` filter accepts. */
const WORKFLOW_STATUSES: readonly WorkflowLifecycleStatus[] = [
  'active',
  'completed',
  'cancelled',
  'blocked',
];

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Parse a positive-int `limit` from a number or numeric string (coerced flags). */
function optionalPosInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return n >= 1 ? n : undefined;
  }
  return undefined;
}

function invalidInput(
  message: string,
  extra?: {
    expectedShape?: Record<string, unknown>;
    validTargets?: readonly string[];
    suggestedFix?: { tool: string; params: Record<string, unknown> };
  },
): ToolResult {
  return {
    success: false,
    error: {
      code: 'INVALID_INPUT',
      message,
      ...(extra?.expectedShape ? { expectedShape: extra.expectedShape } : {}),
      ...(extra?.validTargets ? { validTargets: extra.validTargets } : {}),
      ...(extra?.suggestedFix ? { suggestedFix: extra.suggestedFix } : {}),
    },
  };
}

/**
 * Resolves the `ps` scope, with `all` as the default, or returns an error result.
 * `repo` gets an explicit error that points to `pipeline`, not a silent default.
 */
function resolveScope(raw: unknown): { scope: PsScope } | { error: ToolResult } {
  const s = optionalString(raw);
  if (s === undefined) return { scope: 'all' };
  if (s === 'repo') {
    return {
      error: invalidInput(
        "ps: scope 'repo' is a pipeline-only axis — use pipeline for repo scoping. ps scopes are 'workflow' | 'worktree' | 'all'.",
        {
          validTargets: PS_SCOPES,
          suggestedFix: { tool: 'exarchos_view', params: { action: 'pipeline', scope: 'repo' } },
        },
      ),
    };
  }
  if ((PS_SCOPES as readonly string[]).includes(s)) {
    return { scope: s as PsScope };
  }
  return {
    error: invalidInput(
      `ps: unknown scope '${s}' — expected 'workflow' | 'worktree' | 'all'.`,
      { validTargets: PS_SCOPES },
    ),
  };
}

/** The workflows-section payload: the folded rows + their count. */
interface WorkflowsSection {
  readonly workflows: readonly WorkflowFoldRow[];
  readonly workflowCount: number;
}

/** The `_meta.warning` when no storage backend is wired and the workflows section cannot be read. */
const NO_STORAGE_WARNING =
  'workflows section unavailable: no storage backend wired to this context — ' +
  'the operations section (event-store-backed) is unaffected';

/**
 * Folds the workflows section for the `workflow` and `all` scopes with `foldWorkflowSummaries`.
 * It applies the `status`, `phase`, `workflowType`, `all`, and `limit` arguments. With no storage backend,
 * the section is empty and the result holds a warning, so the empty section does not read as "no workflows".
 */
function foldWorkflowsSection(
  backend: StorageBackend | undefined,
  args: Record<string, unknown>,
  nowMs: number | undefined,
): { section: WorkflowsSection; warning?: string } | { error: ToolResult } {
  if (backend === undefined) {
    return { section: { workflows: [], workflowCount: 0 }, warning: NO_STORAGE_WARNING };
  }

  const filter: WorkflowSummaryFilter = {};
  const status = optionalString(args.status);
  if (status !== undefined) {
    if (!(WORKFLOW_STATUSES as readonly string[]).includes(status)) {
      return {
        error: invalidInput(
          `ps: unknown status '${status}' — expected one of ${WORKFLOW_STATUSES.join(', ')}.`,
          { validTargets: WORKFLOW_STATUSES },
        ),
      };
    }
    filter.status = status as WorkflowLifecycleStatus;
  }
  const phase = optionalString(args.phase);
  if (phase !== undefined) filter.phase = phase;
  const workflowType = optionalString(args.workflowType);
  if (workflowType !== undefined) filter.workflowType = workflowType;
  if (optionalBoolean(args.all) === true) filter.includeTerminal = true;

  let workflows = foldWorkflowSummaries(backend, {
    ...filter,
    ...(nowMs !== undefined ? { nowMs } : {}),
  });
  const limit = optionalPosInt(args.limit);
  if (limit !== undefined) workflows = workflows.slice(0, limit);

  return { section: { workflows, workflowCount: workflows.length } };
}

/**
 * Returns the liveness event types of the registry: each `<surface>.executing_started` type and each
 * terminal type, without duplicates. A new registry surface adds its types with no change here.
 */
function livenessEventTypes(): readonly string[] {
  const types = new Set<string>(everyExecutingStartedType());
  for (const descriptor of LIVENESS_DESCRIPTORS) {
    for (const terminal of descriptor.terminalTypes) types.add(terminal);
  }
  return [...types];
}

/**
 * Gathers the liveness events of every stream, sorted by `(timestamp, sequence)`. Thus
 * `foldInFlightOperations` can pair start and terminal events across the feature streams and the
 * `worktrees` stream in one pass. A `WorkflowEvent` satisfies {@link OperationEventLike} with no adapter.
 * Each query filters by type, so the read and the sort cover only the liveness events, not the full log.
 */
async function gatherOperationEvents(
  eventStore: DispatchContext['eventStore'],
): Promise<OperationEventLike[]> {
  const streams = eventStore.listStreams();
  const types = livenessEventTypes();
  const all: WorkflowEvent[] = [];
  for (const streamId of streams) {
    for (const type of types) {
      const events = await eventStore.query(streamId, { type });
      for (const event of events) all.push(event);
    }
  }
  all.sort((a, b) => {
    const byTs = a.timestamp.localeCompare(b.timestamp);
    return byTs !== 0 ? byTs : a.sequence - b.sequence;
  });
  return all;
}

/** The operations-section payload: the folded in-flight rows + their count. */
interface OperationsSection {
  readonly operations: readonly InFlightOperation[];
  readonly operationCount: number;
}

/** Folds the operations section for the `all` scope. */
async function foldOperationsSection(
  eventStore: DispatchContext['eventStore'],
  nowMs: number | undefined,
): Promise<OperationsSection> {
  const events = await gatherOperationEvents(eventStore);
  const operations = foldInFlightOperations(
    events,
    nowMs !== undefined ? { now: () => nowMs } : undefined,
  );
  return { operations, operationCount: operations.length };
}

/**
 * Lists processes by scope. `worktree` delegates to `handleWorktreeScopePs`, which owns the worktree
 * liveness fold. `workflow` returns the workflows section, and `all`, the default, adds the operations
 * section. A degraded workflows section adds `_meta.warning`.
 *
 * The handler does not check `probe`. The dispatch boundary refuses an undeclared parameter, and a
 * copy of that check here can drift from it after a rename.
 */
export async function handleViewPs(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: WorktreeViewDeps,
): Promise<ToolResult> {
  const resolved = resolveScope(args.scope);
  if ('error' in resolved) return resolved.error;
  const { scope } = resolved;

  if (scope === 'worktree') {
    return handleWorktreeScopePs(args, ctx, deps);
  }

  const nowMs = deps?.now?.();

  const workflowsResult = foldWorkflowsSection(ctx.storage, args, nowMs);
  if ('error' in workflowsResult) return workflowsResult.error;
  const { section: workflows, warning } = workflowsResult;
  const metaField = warning !== undefined ? { _meta: { warning } } : {};

  if (scope === 'workflow') {
    return {
      success: true,
      data: { scope, ...workflows },
      ...metaField,
    };
  }

  const operations = await foldOperationsSection(ctx.eventStore, nowMs);
  return {
    success: true,
    data: { scope, ...workflows, ...operations },
    ...metaField,
  };
}
