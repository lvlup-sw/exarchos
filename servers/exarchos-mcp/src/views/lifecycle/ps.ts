// ─── Lifecycle verb: `ps` — scope-parameterized process-plane lister (DR-3) ───
//
// The one lifecycle verb that answers "what is RUNNING / TRACKED right now?".
// It is a scope-parameterized COMPOSITION of three folds — it carries no fold
// logic of its own (INV-2), only the scope routing + section shaping:
//
//   • scope: 'workflow'  → the WORKFLOWS section: task 005's `foldWorkflowSummaries`
//                          over the storage backend (every tracked workflow, one
//                          row: featureId / workflowType / phase / status / ageMs),
//                          filterable by status / phase / workflowType / all.
//   • scope: 'worktree'  → the WLM-6 worktree liveness fold, CONSUMED not
//                          duplicated: delegates to `handleWorktreeScopePs`
//                          (`orchestrate/worktree/handlers.ts`) so the
//                          inFlightMerges / launches / inFlightPrunes columns AND
//                          the `probe: true` reclaim/reconcile write path are
//                          preserved byte-for-byte.
//   • scope: 'all'       → DEFAULT. BOTH the workflows section (005) AND an
//                          OPERATIONS section: task 006's `foldInFlightOperations`
//                          over every liveness surface (merge / launch / mutation /
//                          prune — surface-generic, registry-driven), gathered
//                          across every stream.
//
// ## Scope collision resolution (task 007, honoring task 019's discovery)
//
// The `scope` field is the SHARED `schema-fields.ts` shape — widened by task 007
// to the union `['repo','all','workflow','worktree']` so `pipeline` (`repo`/`all`)
// and `ps` (`workflow`/`worktree`/`all`) declare ONE `scope` definition on the
// `exarchos_view` tool (a divergent enum value set would make
// `buildRegistrationSchema` THROW). `ps` validates its OWN subset here — it
// REJECTS `repo` (a pipeline-only member) — and `pipeline` ignores the ps-only
// members at its handler. The flattener only requires the value SET to match
// across the two actions, which the single shared shape guarantees.
//
// ## Probe gating (DR-3)
//
// `probe: true` is a WORKTREE-scope-only capability (it runs the DR-5 process
// probe and emits reclaim/reconcile writes). Passing it with any non-worktree
// scope is a structured `INVALID_INPUT` — probe has no meaning over a workflows
// or operations fold, both of which are pure reads.
// ─────────────────────────────────────────────────────────────────────────────

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type {
  StorageBackend,
  WorkflowLifecycleStatus,
  WorkflowSummaryFilter,
} from '../../storage/backend.js';
import {
  handleWorktreeScopePs,
  type WorktreeViewDeps,
} from '../../orchestrate/worktree/handlers.js';
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
} from '../../event-store/liveness-registry.js';
import { scopeField } from './schema-fields.js';

// ─── Scope vocabulary ─────────────────────────────────────────────────────────

/** The `ps`-plane scopes. A SUBSET of the shared `scopeField` union — `repo` is
 *  a `pipeline`-only member `ps` rejects. */
export type PsScope = 'workflow' | 'worktree' | 'all';

const PS_SCOPES: readonly PsScope[] = ['workflow', 'worktree', 'all'];

/** The workflow lifecycle statuses a `ps --status` filter may request. */
const WORKFLOW_STATUSES: readonly WorkflowLifecycleStatus[] = [
  'active',
  'completed',
  'cancelled',
  'blocked',
];

// ─── Local input helpers (kept private — never user-facing flags) ─────────────

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

/** Resolve the requested `ps` scope, defaulting to `all`, or an error result. */
function resolveScope(raw: unknown): { scope: PsScope } | { error: ToolResult } {
  const s = optionalString(raw);
  if (s === undefined) return { scope: 'all' };
  // `repo` is a valid shared-`scopeField` member but a `pipeline`-only axis — a
  // `ps --scope repo` request has no meaning here, so reject it explicitly
  // (INV-5b self-correcting error) rather than silently defaulting.
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

// ─── Workflows section (task 005) ─────────────────────────────────────────────

/** The workflows-section payload: the folded rows + their count. */
interface WorkflowsSection {
  readonly workflows: readonly WorkflowFoldRow[];
  readonly workflowCount: number;
}

/** `_meta.warning` surfaced when the workflows section can't be read (no backend). */
const NO_STORAGE_WARNING =
  'workflows section unavailable: no storage backend wired to this context — ' +
  'the operations section (event-store-backed) is unaffected';

/**
 * Fold the WORKFLOWS section for the `workflow` / `all` scopes: task 005's
 * `foldWorkflowSummaries` over `ctx.storage`, honoring the status / phase /
 * workflowType / all (includeTerminal) filters. When no storage backend is wired
 * (a test-context shape only — production always supplies a SqliteBackend), the
 * section degrades to empty AND surfaces a structured `_meta.warning` (rather
 * than a silent empty section that reads as "no workflows exist"); the
 * operations section (which rides `eventStore`, always present) is unaffected.
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

// ─── Operations section (task 006) ────────────────────────────────────────────

/**
 * The registry's liveness event types — every `<surface>.executing_started`
 * START plus every declared TERMINAL, deduplicated. Derived from the DR-2
 * registry (never hardcoded), so a fifth surface's types are picked up
 * automatically. This is the type-scoped pushdown set `gatherOperationEvents`
 * restricts its reads to.
 */
function livenessEventTypes(): readonly string[] {
  const types = new Set<string>(everyExecutingStartedType());
  for (const descriptor of LIVENESS_DESCRIPTORS) {
    for (const terminal of descriptor.terminalTypes) types.add(terminal);
  }
  return [...types];
}

/**
 * Gather the liveness events across every stream, globally ordered by
 * `(timestamp, sequence)`, so `foldInFlightOperations` can pair START/TERMINAL
 * across the feature streams (merge / mutation) AND the singleton `worktrees`
 * stream (launch / prune) in one pass. `WorkflowEvent` rows satisfy
 * {@link OperationEventLike} structurally (including `streamId`, load-bearing for
 * the DR-2 per-stream pairing) — no adapter needed.
 *
 * Perf (DR-3 + DR-12, #1691): rather than loading the FULL event log of every
 * stream and global-sorting it on each `ps --scope all`, this pushes the type
 * filter down to the backend — only the registry's liveness start/terminal
 * types are materialized. The whole type set rides ONE storage query per
 * stream via the DR-11 multi-type filter (`query(streamId, { types })`, SQL
 * `type IN (...)`, honored by both the SqliteBackend and the InMemoryBackend),
 * so the query count is pinned to the STREAM count — independent of how many
 * liveness types the registry declares (no per-type inner loop). The remaining
 * sort is over the small liveness slice, not the whole log.
 */
async function gatherOperationEvents(
  eventStore: DispatchContext['eventStore'],
): Promise<OperationEventLike[]> {
  const streams = eventStore.listStreams();
  const types = [...livenessEventTypes()];
  const all: WorkflowEvent[] = [];
  for (const streamId of streams) {
    const events = await eventStore.query(streamId, { types });
    for (const event of events) all.push(event);
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

/** Fold the OPERATIONS section for the `all` scope (task 006, surface-generic). */
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

// ─── Handler ────────────────────────────────────────────────────────────────────

/**
 * `ps` — the scope-parameterized process-plane lister (DR-3). Routes:
 *
 *   - `scope: 'worktree'` → the CONSUMED WLM-6 fold (`handleWorktreeScopePs`),
 *     the only scope where `probe: true` is valid;
 *   - `scope: 'workflow'` → the workflows section only;
 *   - `scope: 'all'` (default) → workflows section + operations section.
 *
 * `probe` on a non-worktree scope is a structured `INVALID_INPUT`. Every path is
 * a pure read except `scope: 'worktree'` + `probe: true` (the reclaim/reconcile
 * write path, unchanged from WLM-6).
 */
export async function handleViewPs(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: WorktreeViewDeps,
): Promise<ToolResult> {
  const resolved = resolveScope(args.scope);
  if ('error' in resolved) return resolved.error;
  const { scope } = resolved;

  // Probe is a worktree-scope-only capability (it runs the DR-5 process probe +
  // emits reclaim/reconcile writes). It has no meaning over the pure-read
  // workflows / operations folds → reject rather than silently ignore.
  if (args.probe !== undefined && scope !== 'worktree') {
    return invalidInput(
      `ps: probe is only valid for scope: 'worktree' (received scope: '${scope}') — the workflows/operations folds are pure reads with no process probe.`,
      {
        expectedShape: { scope: "'worktree'", probe: 'boolean' },
        validTargets: ['worktree'],
        suggestedFix: { tool: 'exarchos_view', params: { action: 'ps', scope: 'worktree', probe: true } },
      },
    );
  }

  // Worktree scope: delegate to the CONSUMED WLM-6 kernel unchanged — it owns the
  // inFlightMerges / launches / inFlightPrunes fold and the probe write path.
  if (scope === 'worktree') {
    return handleWorktreeScopePs(args, ctx, deps);
  }

  const nowMs = deps?.now?.();

  // Workflows section (both remaining scopes need it).
  const workflowsResult = foldWorkflowsSection(ctx.storage, args, nowMs);
  if ('error' in workflowsResult) return workflowsResult.error;
  const { section: workflows, warning } = workflowsResult;
  // Surface a degraded-read warning structurally instead of a silent empty
  // section (finding 6a). Only present when a section actually degraded.
  const metaField = warning !== undefined ? { _meta: { warning } } : {};

  if (scope === 'workflow') {
    return {
      success: true,
      data: { scope, ...workflows },
      ...metaField,
    };
  }

  // scope: 'all' → workflows + operations.
  const operations = await foldOperationsSection(ctx.eventStore, nowMs);
  return {
    success: true,
    data: { scope, ...workflows, ...operations },
    ...metaField,
  };
}
