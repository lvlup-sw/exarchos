/**
 * `merge-orchestrator@v1` projection reducer (Wave 2B.2 / #1304).
 *
 * Folds the `merge.*` event family on a feature stream into the
 * {@link MergeOrchestratorState} phase machine documented in `types.ts`.
 *
 * Replaces the in-memory side-database that pre-preview.2 `merge-orchestrate.ts`
 * carried (audit findings §F1.2). Mirrors Wave 2A's TaskStore-as-projection
 * substitution: every state transition is now an event, every state read is a
 * fold over the durable event log.
 *
 * ## Naming note (#1306 rename tracker)
 *
 * This worktree's `event-store/schemas.ts` ships `merge.rollback` as the
 * canonical recovery event (the rename to `merge.recovered` is tracked
 * separately by #1306). The reducer's dispatcher handles `merge.rollback`
 * here; if/when #1306 lands, the case label switches alongside the schema.
 * The reducer's external contract (the `recovering` phase, the
 * {@link MergeRecoveryContext} field shape) does not change with the rename.
 *
 * ## Purity contract
 *
 * Per DR-1: `apply` is pure, deterministic, side-effect-free, and never
 * mutates its `state` argument. The sibling `assertReducerImmutable` test
 * (Wave 2B.3) enforces this property over a representative event fixture.
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import {
  initialMergeOrchestratorState,
  type MergeActionMetadata,
  type MergeOrchestratorState,
  type MergePreflightMetadata,
  type MergeRecoveryContext,
} from './types.js';

// ─── Field extractors (typed reads over event.data) ─────────────────────────
//
// The event-store base schema types `data` as `Record<string, unknown> | undefined`;
// these extractors do the runtime checks the type system cannot. Mirrors the
// pattern in `projections/rehydration/reducer.ts`.

function extractString(
  data: WorkflowEvent['data'],
  key: string,
): string | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function extractBoolean(
  data: WorkflowEvent['data'],
  key: string,
): boolean | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'boolean' ? raw : undefined;
}

function extractNumber(
  data: WorkflowEvent['data'],
  key: string,
): number | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Narrowing reader for the closed `strategy` enum on `merge.requested` /
 * `merge.executed`. Returns `undefined` for missing / unrecognised values so
 * the reducer never widens the metadata field beyond the typed enum.
 */
function extractStrategy(
  data: WorkflowEvent['data'],
): MergeActionMetadata['strategy'] | undefined {
  const raw = extractString(data, 'strategy');
  if (raw === 'squash' || raw === 'rebase' || raw === 'merge') return raw;
  return undefined;
}

/**
 * Narrowing reader for the INV-14 `recoveryError` discriminator on
 * `merge.rollback`. Mirrors `extractStrategy` — unrecognised / missing
 * values yield `undefined` so the projection never carries a `recoveryError`
 * the enum doesn't sanction.
 */
function extractRecoveryError(
  data: WorkflowEvent['data'],
): MergeRecoveryContext['recoveryError'] | undefined {
  const raw = extractString(data, 'recoveryError');
  if (
    raw === 'reset-keep-blocked' ||
    raw === 'reset-failed' ||
    raw === 'unexpected-mid-merge-drift'
  )
    return raw;
  return undefined;
}

/**
 * Flatten the preflight failure surface into a single operator-facing string.
 *
 * The `merge.preflight` event carries `failureReasons: string[]` (per
 * `MergePreflightData` in `event-store/schemas.ts`); we collapse that into one
 * comma-joined string so the projection's `reason` field stays a simple
 * string — matching the audit/observability shape downstream tooling expects.
 * Returns `undefined` when no actionable reason is present.
 */
function extractPreflightReason(
  data: WorkflowEvent['data'],
): string | undefined {
  if (!data) return undefined;
  const reasons = data['failureReasons'];
  if (Array.isArray(reasons)) {
    const strs = reasons.filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    );
    if (strs.length > 0) return strs.join(', ');
  }
  // Fallback: an explicit `reason` field (some emitters use a flat string).
  return extractString(data, 'reason');
}

// ─── Per-event handlers ─────────────────────────────────────────────────────

/**
 * Handler for `merge.preflight` — captures the preflight gate outcome and
 * advances the phase to `preflight`. The `passed` flag MUST be present on the
 * event (per `MergePreflightData`); if it isn't, fall back to `false` so a
 * malformed event still records as a (failed) preflight rather than corrupting
 * the phase machine with an invented `true` verdict.
 */
function applyMergePreflight(
  state: MergeOrchestratorState,
  event: WorkflowEvent,
): MergeOrchestratorState {
  const passed = extractBoolean(event.data, 'passed') ?? false;
  const reason = passed ? undefined : extractPreflightReason(event.data);
  const preflight: MergePreflightMetadata = passed
    ? { passed: true }
    : reason !== undefined
      ? { passed: false, reason }
      : { passed: false };
  // Capture branch identifiers eagerly when present — they're useful for
  // observability even before merge.requested / merge.executed lands them
  // formally on the `merge` sub-record.
  const merge = mergeFromEvent(state.merge, event);
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'preflight',
    preflight,
    ...(merge !== state.merge ? { merge } : {}),
  };
}

/**
 * Handler for `merge.requested` — audit §F1.2's durable-intent event. Records
 * branches / strategy / prNumber / taskId on the `merge` sub-record and
 * advances the phase to `requested` (the new phase between `preflight` and
 * `executed`).
 */
function applyMergeRequested(
  state: MergeOrchestratorState,
  event: WorkflowEvent,
): MergeOrchestratorState {
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'requested',
    merge: mergeFromEvent(state.merge, event),
  };
}

/**
 * Handler for `merge.executed` — records the merge's outcome (mergeSha,
 * rollbackSha) and advances the phase to `executed`. Preserves earlier merge
 * fields (taskId, branches, strategy) so observability replay never loses
 * them across the requested → executed split.
 */
function applyMergeExecuted(
  state: MergeOrchestratorState,
  event: WorkflowEvent,
): MergeOrchestratorState {
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'executed',
    merge: mergeFromEvent(state.merge, event),
  };
}

/**
 * Handler for `merge.rollback` (or post-#1306 `merge.recovered`) — `any →
 * recovering`. Captures the rollback reason + any reset-side error. Does NOT
 * overwrite earlier merge metadata; the recovery context is additive, and
 * downstream observability needs both the original merge identifiers and the
 * rollback rationale.
 */
function applyMergeRollback(
  state: MergeOrchestratorState,
  event: WorkflowEvent,
): MergeOrchestratorState {
  const reason = extractString(event.data, 'reason');
  const error = extractString(event.data, 'rollbackError');
  const recoveryError = extractRecoveryError(event.data);
  const recovery: MergeRecoveryContext = {
    ...(reason !== undefined ? { reason } : {}),
    ...(recoveryError !== undefined ? { recoveryError } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'recovering',
    ...(Object.keys(recovery).length > 0 ? { recovery } : {}),
  };
}

/**
 * Handler for `merge.completed` — terminal transition; phase advances to
 * `completed`. Preserves all earlier metadata (preflight, merge, recovery)
 * so the final projection state is a full audit record of the lifecycle.
 */
function applyMergeCompleted(
  state: MergeOrchestratorState,
  _event: WorkflowEvent,
): MergeOrchestratorState {
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'completed',
  };
}

/**
 * Merge-field extractor — folds any of the merge.* events that carry merge
 * metadata into a fresh {@link MergeActionMetadata} record. New fields from the
 * event overwrite existing ones; absent fields preserve the prior value (so
 * `merge.executed` does NOT blank out the `strategy` recorded earlier on
 * `merge.requested`).
 *
 * Returns the existing `merge` reference when no field changed — lets callers
 * skip an unnecessary spread when the event carried no relevant fields.
 */
function mergeFromEvent(
  existing: MergeActionMetadata | undefined,
  event: WorkflowEvent,
): MergeActionMetadata | undefined {
  const taskId = extractString(event.data, 'taskId');
  const sourceBranch = extractString(event.data, 'sourceBranch');
  const targetBranch = extractString(event.data, 'targetBranch');
  const strategy = extractStrategy(event.data);
  const prNumber = extractNumber(event.data, 'prNumber');
  const mergeSha = extractString(event.data, 'mergeSha');
  const rollbackSha = extractString(event.data, 'rollbackSha');

  const anyPresent =
    taskId !== undefined ||
    sourceBranch !== undefined ||
    targetBranch !== undefined ||
    strategy !== undefined ||
    prNumber !== undefined ||
    mergeSha !== undefined ||
    rollbackSha !== undefined;
  if (!anyPresent) return existing;

  return {
    ...(existing ?? {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(sourceBranch !== undefined ? { sourceBranch } : {}),
    ...(targetBranch !== undefined ? { targetBranch } : {}),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(mergeSha !== undefined ? { mergeSha } : {}),
    ...(rollbackSha !== undefined ? { rollbackSha } : {}),
  };
}

// ─── Reducer (thin dispatcher) ──────────────────────────────────────────────

/**
 * Concrete `merge-orchestrator@v1` reducer value. Registered with
 * `defaultRegistry` by the sibling `./index.ts` barrel at module-import time
 * (DR-1 convention — concrete projections self-register; the registry is the
 * single source of truth for projection identity).
 */
export const mergeOrchestratorReducer: ProjectionReducer<
  MergeOrchestratorState,
  WorkflowEvent
> = {
  id: 'merge-orchestrator@v1',
  version: 1,
  scope: 'stream' as const,
  initial: initialMergeOrchestratorState,
  apply(state: MergeOrchestratorState, event: WorkflowEvent): MergeOrchestratorState {
    // Dispatch by event.type. Unknown event types short-circuit back to
    // `state` unchanged so projectionSequence only advances on handled events.
    switch (event.type) {
      case 'merge.preflight':
        return applyMergePreflight(state, event);
      case 'merge.requested':
        return applyMergeRequested(state, event);
      case 'merge.executed':
        return applyMergeExecuted(state, event);
      // #1306 deprecation window — the recovery path DUAL-EMITS the canonical
      // `merge.recovered` (emitted first) + the legacy `merge.rollback`. Fold
      // BOTH into the `any → recovering` transition so the projection advances
      // on whichever event lands. The two appends are NOT atomic: a concurrent
      // writer between them (or a lost sequence race on the second) can leave a
      // `merge.recovered`-only stream; keying the projection on the legacy
      // second event alone would strand it at `executing` (Sentry review,
      // #1571). Folding both is safe — `applyMergeRollback` sets
      // `phase: 'recovering'` from any prior phase and the recovery context is
      // identical across the pair. v2.12 (#1570) drops the `merge.rollback` case.
      case 'merge.recovered':
      case 'merge.rollback':
        return applyMergeRollback(state, event);
      case 'merge.completed':
        return applyMergeCompleted(state, event);
      default:
        return state;
    }
  },
};

export type { MergeOrchestratorState } from './types.js';
