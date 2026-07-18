/**
 * DR-14 (#1647, v2-12-bundle task 013) — context-rot counter with rehydrate
 * gating at the dispatch seam.
 *
 * "Context is a view, the log is the state." Self-conditioning is the
 * strongest-evidenced LLM failure mode: per-step error rises with the model's
 * own errors in context. The runtime already externalizes state
 * (`next_actions`, `rehydrate`); this interceptor makes staleness measurable
 * and re-grounding enforceable — server-side, no harness cooperation.
 *
 * ## The counter is a pure fold (INV-1)
 *
 * Rot = the number of events that have landed on the workflow stream since
 * the last *freshness anchor*. Two event types anchor freshness:
 *
 *   - `workflow.rehydrated` — the session just consumed a freshly-folded
 *     rehydration document; the anchor is the event's own store sequence
 *     (same convention as `session-machinery.ts` / T-12: `event.sequence`,
 *     NOT the embedded `data.projectionSequence`).
 *   - `worktree.created` (DR-13 launcher variant, #1644) — the spawn
 *     envelope's `data.projectionSequence` records the fold position the
 *     session's rehydration doc was compiled at. Events between that
 *     position and the spawn event are already rot at spawn time (see the
 *     launcher contract's field audit: DR-14 reads this field as the
 *     rehydration doc's staleness anchor). The task-worktree variant of
 *     `worktree.created` carries no `projectionSequence` and is a plain
 *     rot increment like any other event.
 *
 * The derivation is `foldContextRot(events)` — a deterministic reducer over
 * the ordered event list. No hidden mutable state, no clock reads, no I/O
 * inside the fold; the interceptor's only side effects are the two
 * event-store READS that fetch the fold's input.
 *
 * ## The hard gate is scoped to phase-mutating verbs only (INV-9)
 *
 * INV-9: the HSM is the sole phase authority and `workflow.transition` is
 * the ONLY phase mutator (`set({phase})` was removed in v2.11). The hard
 * gate therefore fires exclusively on `exarchos_workflow/transition` — and
 * only when rot ≥ the hard threshold. Every other verb — reads, views,
 * state patches, orchestration — is NEVER blocked at ANY rot level; the
 * reviewer condition on #1647 ("no friction in headed mode") is a contract,
 * and `context-rot.test.ts` pins it registry-wide.
 *
 * A block is a structured `ToolResult` error (code
 * {@link CONTEXT_ROT_ERROR_CODE}) naming the rehydrate affordance via
 * `error.suggestedFix` AND a first-class `next_actions` rehydrate entry —
 * never a throw-through.
 *
 * ## Soft signal
 *
 * At rot ≥ the soft threshold, successful dispatch responses get the
 * `rehydrate` affordance promoted to the TOP of `next_actions` (issue spec)
 * and the counter surfaced as a visible number on `_meta.contextRot` —
 * advisory, a visible number, not a nag.
 *
 * ## Failure posture: fail-open, logged
 *
 * Same posture as `session-machinery.ts`: a failure on the read path is
 * logged-and-swallowed (`workflowLogger.warn`) and the dispatch proceeds
 * un-gated. The counter is staleness observability layered over the HSM
 * transition guard (which still runs); a broken store read must not convert
 * into a phase-mutation outage.
 *
 * ## Thresholds
 *
 * Generous defaults, overridable per-call (tests) or via environment
 * (`EXARCHOS_CONTEXT_ROT_SOFT_THRESHOLD` / `EXARCHOS_CONTEXT_ROT_HARD_THRESHOLD`;
 * `0` or negative disables that signal). `.exarchos.yml` plumbing is
 * follow-on config-surface work — the dispatch-seam contract here is
 * threshold-source-agnostic.
 */

import type { EventStore } from '../../event-store/store.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { ToolResult } from '../../format.js';
import type { NextAction } from '../../next-action.js';
import { workflowLogger } from '../../logger.js';

// ─── Event-type + verb-set constants ───────────────────────────────────────

/** Freshness anchor: the session consumed a freshly-folded rehydration doc. */
export const WORKFLOW_REHYDRATED_EVENT = 'workflow.rehydrated';

/** Freshness anchor (DR-13 launcher variant only): spawn-boundary lifecycle event. */
export const WORKTREE_CREATED_EVENT = 'worktree.created';

/** Structured error code stamped on a hard-gate block. */
export const CONTEXT_ROT_ERROR_CODE = 'CONTEXT_ROT_EXCEEDED';

/**
 * The phase-mutating dispatch surface, as `"<tool>/<action>"` keys.
 *
 * INV-9: `workflow.transition` is the only phase mutator and it is reachable
 * exclusively through `exarchos_workflow/transition`. Growing this set is a
 * deliberate INV-9 decision, not a convenience — the registry-wide
 * never-blocked contract test enumerates every other action against it.
 */
export const PHASE_MUTATING_DISPATCHES: ReadonlySet<string> = new Set([
  'exarchos_workflow/transition',
]);

/** True when `tool`/`action` is a phase-mutating dispatch (INV-9 scope). */
export function isPhaseMutatingDispatch(tool: string, action: string): boolean {
  return PHASE_MUTATING_DISPATCHES.has(`${tool}/${action}`);
}

// ─── Thresholds ────────────────────────────────────────────────────────────

/** Soft default: promote the rehydrate affordance (advisory). */
export const DEFAULT_CONTEXT_ROT_SOFT_THRESHOLD = 25;

/** Hard default: refuse phase mutations until rehydrate runs. */
export const DEFAULT_CONTEXT_ROT_HARD_THRESHOLD = 50;

export interface ContextRotThresholds {
  /** Rot level at which the soft signal fires. `Infinity` = disabled. */
  readonly soft: number;
  /** Rot level at which phase mutations are refused. `Infinity` = disabled. */
  readonly hard: number;
}

/**
 * Resolve effective thresholds: explicit overrides > environment > defaults.
 * A non-positive or non-numeric value disables that signal (`Infinity`).
 * Environment reads happen HERE, at the interceptor boundary — never inside
 * the fold (INV-1: the fold's output is a function of the event list alone).
 */
export function resolveContextRotThresholds(
  overrides?: Partial<ContextRotThresholds>,
): ContextRotThresholds {
  const fromEnv = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return undefined;
    return parsed;
  };
  const normalize = (value: number): number =>
    Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
  return {
    soft: normalize(
      overrides?.soft ??
        fromEnv('EXARCHOS_CONTEXT_ROT_SOFT_THRESHOLD') ??
        DEFAULT_CONTEXT_ROT_SOFT_THRESHOLD,
    ),
    hard: normalize(
      overrides?.hard ??
        fromEnv('EXARCHOS_CONTEXT_ROT_HARD_THRESHOLD') ??
        DEFAULT_CONTEXT_ROT_HARD_THRESHOLD,
    ),
  };
}

// ─── Pure fold (INV-1) ─────────────────────────────────────────────────────

export interface ContextRotState {
  /**
   * Highest freshness anchor seen, in event-store sequence units
   * (`0` = no anchor yet — every event on the stream is rot).
   */
  readonly anchorSequence: number;
  /** Count of events that landed after the anchor. */
  readonly rot: number;
}

/** Identity element for the fold. */
export const CONTEXT_ROT_FOLD_INIT: ContextRotState = Object.freeze({
  anchorSequence: 0,
  rot: 0,
});

/** Narrow the DR-13 launcher-variant `projectionSequence` out of unknown data. */
function readProjectionSequence(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const ps = (data as Record<string, unknown>).projectionSequence;
  return typeof ps === 'number' && Number.isFinite(ps) && ps >= 0 ? ps : undefined;
}

/**
 * Pure reducer: fold one event into the rot state.
 *
 * - `workflow.rehydrated` → anchor at the event's own sequence, rot resets.
 * - `worktree.created` with a launcher-envelope `projectionSequence` that
 *   advances the anchor → anchor at that fold position; rot becomes the
 *   count of events between the anchor and the spawn event INCLUSIVE of the
 *   spawn event itself (`event.sequence - projectionSequence`, relying on
 *   the store's contiguous per-stream sequences — `(stream_id, sequence)`
 *   PRIMARY KEY). The doc the session spawned with was already that stale.
 * - Anything else (including task-shaped `worktree.created` and stale
 *   launcher anchors) → rot + 1.
 *
 * Never mutates `state` or `event`; no clock, no I/O (INV-1).
 */
export function applyContextRotEvent(
  state: ContextRotState,
  event: WorkflowEvent,
): ContextRotState {
  if (event.type === WORKFLOW_REHYDRATED_EVENT) {
    return { anchorSequence: event.sequence, rot: 0 };
  }
  if (event.type === WORKTREE_CREATED_EVENT) {
    const projectionSequence = readProjectionSequence(event.data);
    if (
      projectionSequence !== undefined &&
      projectionSequence >= state.anchorSequence
    ) {
      return {
        anchorSequence: projectionSequence,
        rot: Math.max(0, event.sequence - projectionSequence),
      };
    }
  }
  return { anchorSequence: state.anchorSequence, rot: state.rot + 1 };
}

/**
 * Fold an ordered (ascending-sequence) event list into a rot state.
 * `foldContextRot(all)` ≡ `foldContextRot(tail, foldContextRot(head))` —
 * the incremental-fold identity the interceptor's bounded read path relies
 * on, pinned by `RotCounter_EventFold_Pure`.
 */
export function foldContextRot(
  events: readonly WorkflowEvent[],
  seed: ContextRotState = CONTEXT_ROT_FOLD_INIT,
): ContextRotState {
  return events.reduce(applyContextRotEvent, seed);
}

// ─── Dispatch-seam assessment ──────────────────────────────────────────────

export interface ContextRotAssessment {
  readonly streamId: string;
  readonly rot: number;
  readonly anchorSequence: number;
  readonly thresholds: ContextRotThresholds;
  /**
   * Non-null ONLY when the dispatched verb is phase-mutating (INV-9 scope)
   * AND rot ≥ the hard threshold: the structured refusal envelope dispatch
   * returns instead of running the handler. Always null for every other
   * verb, at any rot level.
   */
  readonly blocked: ToolResult | null;
}

/** First-class rehydrate affordance (base `NextAction` shape, no new schema branch). */
function rehydrateAffordance(streamId: string, reason: string): NextAction {
  return {
    verb: 'rehydrate',
    reason,
    hint: `exarchos_workflow { action: "rehydrate", featureId: "${streamId}" }`,
  };
}

function buildBlockedResult(
  tool: string,
  actionVerb: string,
  streamId: string,
  rot: number,
  hardThreshold: number,
): ToolResult {
  const reason =
    `${rot} events have landed on stream "${streamId}" since the last ` +
    `rehydration anchor (hard threshold ${hardThreshold}); the session's ` +
    `context view is stale.`;
  return {
    success: false,
    error: {
      code: CONTEXT_ROT_ERROR_CODE,
      message:
        `Phase-mutating action "${tool}/${actionVerb}" refused: ${reason} ` +
        `Run rehydrate to re-ground, then retry. Reads are never gated (INV-9 ` +
        `hard gate applies to phase mutations only).`,
      tool,
      action: actionVerb,
      operationsSince: rot,
      threshold: hardThreshold,
      suggestedFix: {
        tool: 'exarchos_workflow',
        params: { action: 'rehydrate', featureId: streamId },
      },
    },
    next_actions: [
      rehydrateAffordance(streamId, `context rot ${rot} ≥ hard threshold ${hardThreshold}`),
    ],
  };
}

/**
 * Run the context-rot interceptor for one dispatch call.
 *
 * Wired by `dispatch()` AFTER schema validation + capability gates and
 * BEFORE the composite handler runs (directly after the T-12
 * session-machinery interceptor — the same seam). Returns:
 *
 * - `undefined` — assessment unavailable: no stream to meter (`streamId`
 *   absent), the verb IS the re-grounding affordance (`rehydrate` resets
 *   the counter by emitting `workflow.rehydrated`; metering it would gate
 *   the cure on the disease), or the read path failed (fail-open, logged).
 * - an assessment with `blocked` non-null — dispatch must return that
 *   envelope without running the handler (hard gate, INV-9 scope only).
 * - an assessment with `blocked: null` — dispatch proceeds; the soft
 *   signal (if any) is applied to the RESULT via
 *   {@link applyContextRotSoftSignal}.
 *
 * Read cost: two storage queries — a type-filtered anchor scan
 * (`types IN (workflow.rehydrated, worktree.created)`, DR-11 multi-type
 * filter) and a `sinceSequence` tail window from the anchor. The full
 * stream is never materialized; the tail fold seeded at the anchor equals
 * the whole-stream fold by the incremental-fold identity.
 */
export async function runContextRotInterceptor(
  eventStore: EventStore,
  streamId: string | undefined,
  tool: string,
  actionVerb: string,
  thresholdOverrides?: Partial<ContextRotThresholds>,
): Promise<ContextRotAssessment | undefined> {
  if (!streamId) return undefined;
  if (actionVerb === 'rehydrate') return undefined;

  const thresholds = resolveContextRotThresholds(thresholdOverrides);
  if (thresholds.soft === Number.POSITIVE_INFINITY && thresholds.hard === Number.POSITIVE_INFINITY) {
    // Both signals disabled — skip the read cost entirely.
    return undefined;
  }

  try {
    // Anchor scan: only anchor-typed events can move `anchorSequence`, so
    // folding the type-filtered subset yields the same anchor as the full
    // fold (non-anchor events only ever increment rot).
    const anchorEvents = await eventStore.query(streamId, {
      types: [WORKFLOW_REHYDRATED_EVENT, WORKTREE_CREATED_EVENT],
    });
    const { anchorSequence } = foldContextRot(anchorEvents);

    // Tail window: events strictly after the anchor (`sinceSequence` is
    // exclusive in both backends). Seeding the fold at the anchor makes
    // this equal to folding the entire stream (incremental-fold identity).
    const tail = await eventStore.query(streamId, { sinceSequence: anchorSequence });
    const state = foldContextRot(tail, { anchorSequence, rot: 0 });

    const blocked =
      isPhaseMutatingDispatch(tool, actionVerb) && state.rot >= thresholds.hard
        ? buildBlockedResult(tool, actionVerb, streamId, state.rot, thresholds.hard)
        : null;

    return {
      streamId,
      rot: state.rot,
      anchorSequence: state.anchorSequence,
      thresholds,
      blocked,
    };
  } catch (err) {
    // Fail-open, logged — see header. The HSM transition guard still runs;
    // rot metering must not convert a store-read failure into an outage.
    workflowLogger.warn(
      {
        streamId,
        tool,
        actionVerb,
        err: err instanceof Error ? err.message : String(err),
      },
      'context-rot interceptor swallowed error (fail-open, dispatch proceeds un-gated)',
    );
    return undefined;
  }
}

// ─── Soft signal (post-handler result decoration) ──────────────────────────

/**
 * Apply the DR-14 soft signal to a dispatch result. Pure decoration:
 *
 * - no assessment / failed result / rot below the soft threshold → returned
 *   unchanged (same reference).
 * - otherwise the `rehydrate` affordance is promoted to the TOP of
 *   `next_actions` (issue spec: "promotes a rehydrate affordance to the top
 *   of next_actions") — a handler-authored rehydrate entry is hoisted
 *   rather than duplicated — and the counter is surfaced as a visible
 *   number on `_meta.contextRot`. `dispatch()`'s `attachMeta` merges the
 *   correlation block around `_meta` non-destructively, so the stamp
 *   survives to the wire.
 */
export function applyContextRotSoftSignal(
  result: ToolResult,
  assessment: ContextRotAssessment | undefined,
): ToolResult {
  if (assessment === undefined) return result;
  if (result.success !== true) return result;
  if (assessment.rot < assessment.thresholds.soft) return result;

  const existing: readonly NextAction[] = result.next_actions ?? [];
  const existingRehydrate = existing.find((a) => a.verb === 'rehydrate');
  const promoted: readonly NextAction[] = existingRehydrate
    ? [existingRehydrate, ...existing.filter((a) => a !== existingRehydrate)]
    : [
        rehydrateAffordance(
          assessment.streamId,
          `context rot ${assessment.rot} ≥ soft threshold ${assessment.thresholds.soft}; ` +
            `re-ground on the log before continuing`,
        ),
        ...existing,
      ];

  const existingMeta =
    typeof result._meta === 'object' && result._meta !== null
      ? (result._meta as Record<string, unknown>)
      : {};

  return {
    ...result,
    next_actions: promoted,
    _meta: { ...existingMeta, contextRot: assessment.rot },
  };
}
