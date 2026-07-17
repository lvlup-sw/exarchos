import type { ViewProjection } from '../views/materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { percentile } from './percentile.js';
import {
  getQualityHintType,
  renderQualityHintReason,
  type QualityHintType,
} from './quality-hints.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const TELEMETRY_VIEW = 'telemetry';

// ─── Rolling Window Default ────────────────────────────────────────────────

const DEFAULT_WINDOW_SIZE = 1000;

// ─── Per-Tool Metrics ──────────────────────────────────────────────────────

export interface ToolMetrics {
  readonly invocations: number;
  readonly errors: number;
  readonly totalDurationMs: number;
  readonly totalBytes: number;
  readonly totalTokens: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  readonly p50Bytes: number;
  readonly p95Bytes: number;
  readonly p50Tokens: number;
  readonly p95Tokens: number;
  readonly durations: readonly number[];
  readonly sizes: readonly number[];
  readonly tokenEstimates: readonly number[];
  // PR3/T9 (#1364) — structured action-level failure counters. Split from
  // `errors` (which counts transport/protocol throws via tool.errored only).
  readonly actionErrors: number;
  readonly actionErrorBreakdown: Readonly<Record<string, number>>;
}

// ─── Per-Turn Output-Token Record (#1262) ──────────────────────────────────

/**
 * A single agent turn's output-token sum. The projection folds
 * `turn.completed` events into `view.turns` so quality-hint generators can
 * detect threshold crossings without scanning the raw event stream a second
 * time.
 */
export interface TurnRecord {
  readonly turnId: string;
  readonly outputTokens: number;
}

// ─── Telemetry View State ──────────────────────────────────────────────────

export interface TelemetryViewState {
  readonly tools: Record<string, ToolMetrics>;
  readonly sessionStart: string;
  readonly totalInvocations: number;
  readonly totalTokens: number;
  readonly windowSize: number;
  /**
   * Per-turn output-token records (#1262). Capped at `windowSize` like the
   * rolling per-tool arrays so a long-running session doesn't grow the view
   * state unbounded.
   */
  readonly turns: readonly TurnRecord[];
}

// ─── Factory for Empty ToolMetrics ─────────────────────────────────────────

export function initToolMetrics(): ToolMetrics {
  return {
    invocations: 0,
    errors: 0,
    totalDurationMs: 0,
    totalBytes: 0,
    totalTokens: 0,
    p50DurationMs: 0,
    p95DurationMs: 0,
    p50Bytes: 0,
    p95Bytes: 0,
    p50Tokens: 0,
    p95Tokens: 0,
    durations: [],
    sizes: [],
    tokenEstimates: [],
    // PR3/T9 (#1364)
    actionErrors: 0,
    actionErrorBreakdown: {},
  };
}

// ─── Rolling Window Helper ─────────────────────────────────────────────────

function appendWithCap(arr: readonly number[], value: number, cap: number): readonly number[] {
  const next = [...arr, value];
  if (next.length <= cap) return next;
  return next.slice(next.length - cap);
}

// ─── Projection ────────────────────────────────────────────────────────────

export const telemetryProjection: ViewProjection<TelemetryViewState> = {
  init: () => ({
    tools: {},
    sessionStart: new Date().toISOString(),
    totalInvocations: 0,
    totalTokens: 0,
    windowSize: DEFAULT_WINDOW_SIZE,
    turns: [],
  }),

  apply: (view, event) => {
    switch (event.type) {
      case 'tool.completed': {
        const data = event.data as { tool?: unknown; durationMs?: unknown; responseBytes?: unknown; tokenEstimate?: unknown } | undefined;
        if (!data || typeof data.tool !== 'string' || typeof data.durationMs !== 'number') return view;

        const toolName = data.tool;
        const durationMs = data.durationMs;
        const responseBytes = typeof data.responseBytes === 'number' ? data.responseBytes : 0;
        const tokenEstimate = typeof data.tokenEstimate === 'number' ? data.tokenEstimate : 0;

        const existing = view.tools[toolName] ?? initToolMetrics();

        const durations = appendWithCap(existing.durations, durationMs, view.windowSize);
        const sizes = appendWithCap(existing.sizes, responseBytes, view.windowSize);
        const tokenEstimates = appendWithCap(existing.tokenEstimates, tokenEstimate, view.windowSize);

        const updated: ToolMetrics = {
          invocations: existing.invocations + 1,
          errors: existing.errors,
          totalDurationMs: existing.totalDurationMs + durationMs,
          totalBytes: existing.totalBytes + responseBytes,
          totalTokens: existing.totalTokens + tokenEstimate,
          p50DurationMs: percentile(durations as number[], 0.5),
          p95DurationMs: percentile(durations as number[], 0.95),
          p50Bytes: percentile(sizes as number[], 0.5),
          p95Bytes: percentile(sizes as number[], 0.95),
          p50Tokens: percentile(tokenEstimates as number[], 0.5),
          p95Tokens: percentile(tokenEstimates as number[], 0.95),
          durations,
          sizes,
          tokenEstimates,
          // PR3/T9 (#1364) — preserve structured-failure counters across
          // tool.completed folds. Listed explicitly (rather than ...existing)
          // to keep the literal exhaustive in the type checker.
          actionErrors: existing.actionErrors,
          actionErrorBreakdown: existing.actionErrorBreakdown,
        };

        return {
          ...view,
          tools: { ...view.tools, [toolName]: updated },
          totalInvocations: view.totalInvocations + 1,
          totalTokens: view.totalTokens + tokenEstimate,
        };
      }

      case 'tool.errored': {
        const errData = event.data as { tool?: unknown } | undefined;
        if (!errData || typeof errData.tool !== 'string') return view;
        const toolName = errData.tool;

        const existing = view.tools[toolName] ?? initToolMetrics();

        const updated: ToolMetrics = {
          ...existing,
          errors: existing.errors + 1,
        };

        return {
          ...view,
          tools: { ...view.tools, [toolName]: updated },
        };
      }

      // PR3/T9 (#1364) — fold structured action-level failures.
      // `tool.errored` continues to track transport/protocol failures
      // (JS throws); `tool.action_errored` carries `errorCode` so the
      // projection can report `actionErrorBreakdown` per tool. See
      // [`docs/designs/archive/2026-05-15-wave2-wave3-polish.md`](../../docs/designs/archive/2026-05-15-wave2-wave3-polish.md).
      case 'tool.action_errored': {
        const aeData = event.data as {
          tool?: unknown;
          errorCode?: unknown;
        } | undefined;
        if (
          !aeData
          || typeof aeData.tool !== 'string'
          || typeof aeData.errorCode !== 'string'
        ) {
          return view;
        }
        const toolName = aeData.tool;
        const errorCode = aeData.errorCode;

        const existing = view.tools[toolName] ?? initToolMetrics();
        const breakdown: Record<string, number> = {
          ...existing.actionErrorBreakdown,
        };
        breakdown[errorCode] = (breakdown[errorCode] ?? 0) + 1;

        const updated: ToolMetrics = {
          ...existing,
          actionErrors: existing.actionErrors + 1,
          actionErrorBreakdown: breakdown,
        };

        return {
          ...view,
          tools: { ...view.tools, [toolName]: updated },
        };
      }

      // #1262 — per-turn output-token tracking. Folded into a capped
      // rolling list (`view.turns`) so quality-hint generators can detect
      // threshold crossings without re-scanning the raw event stream.
      // `turn.completed` payloads must carry a string `turnId` and a
      // numeric `outputTokens`; anything else is ignored (matches the
      // tool.completed/tool.errored guard pattern).
      case 'turn.completed': {
        const tcData = event.data as { turnId?: unknown; outputTokens?: unknown } | undefined;
        if (
          !tcData
          || typeof tcData.turnId !== 'string'
          || typeof tcData.outputTokens !== 'number'
        ) {
          return view;
        }
        const turnId = tcData.turnId;
        const outputTokens = tcData.outputTokens;

        const next = [...view.turns, { turnId, outputTokens }];
        // Retain `windowSize + 1` turns so `computeOutputTokenHints` can
        // walk one turn earlier than the visible window to distinguish a
        // streak that started inside the window from one that extends
        // beyond it (CodeRabbit MAJOR #1422 look-back fix).
        const turnHistoryCap = view.windowSize + 1;
        const turns = next.length <= turnHistoryCap
          ? next
          : next.slice(next.length - turnHistoryCap);

        return {
          ...view,
          turns,
        };
      }

      default:
        return view;
    }
  },
};

// ─── #1262 Quality-Hint Generation ─────────────────────────────────────────

/**
 * A NextAction-shaped hint surfaced when the current per-turn output-token
 * sum is above the configured threshold. The shape is intentionally a
 * subset of `NextAction` (verb + reason + idempotencyKey) so the envelope
 * formatter can lift it directly into `next_actions[]` without translation.
 *
 * `idempotencyKey` is derived from the upward-crossing turnId so downstream
 * consumers can dedupe across calls — the same active streak surfaces the
 * same key on every view request.
 */
export interface OutputTokenHint {
  readonly verb: string;
  readonly reason: string;
  readonly hintType: string;
  readonly idempotencyKey: string;
}

/**
 * Compute output-token quality hints for the current telemetry-view state.
 *
 * Returns **at most one** hint per call, reflecting whether the session is
 * *currently* above the configured threshold (the latest turn's
 * `outputTokens > thresholdTokens`). The hint carries an `idempotencyKey`
 * derived from the upward-crossing turnId so a single streak surfaces the
 * same key across every view request — downstream consumers can dedupe
 * across calls without losing the "still above" signal.
 *
 * Sentry MEDIUM #1422 + CodeRabbit MAJOR #1422: the previous implementation
 * walked the full `view.turns` from a clean `above=false` seed on every
 * call, so every past upward crossing in the buffer re-emitted on every
 * request — exactly the next_actions-flood the edge-triggered design was
 * supposed to prevent. The CodeRabbit look-back finding was a symptom of
 * the same root cause: dropping the predecessor turn while seeding from
 * scratch meant a streak extending out of the window registered as a
 * fresh crossing.
 *
 * The fix collapses both: only the *current* state matters. When latest
 * turn is above threshold we walk backwards within the visible buffer to
 * find the streak start (used for the idempotency key); when latest is
 * below or no turns exist, we emit nothing. Look-back trim is handled by
 * the reducer keeping `windowSize + 1` turns so the streak-start walk can
 * detect when the streak begins inside the window vs. extends beyond it.
 *
 * Returns `[]` when the catalog entry is missing, no turns exist, or the
 * latest turn is at or below the threshold.
 */
export function computeOutputTokenHints(
  view: TelemetryViewState,
  thresholdTokens: number,
): readonly OutputTokenHint[] {
  const hintType: QualityHintType | undefined = getQualityHintType('output_tokens_high');
  if (!hintType) return [];

  const turns = view.turns;
  if (turns.length === 0) return [];

  const latest = turns[turns.length - 1]!;
  if (latest.outputTokens <= thresholdTokens) return [];

  // Walk backwards within the visible buffer to find the upward crossing
  // (the earliest in-window turn of the current above-threshold streak).
  // If the streak extends beyond the buffer (every visible turn is above),
  // the crossing turnId falls back to the earliest in-window turn — the
  // idempotency key remains stable for the lifetime of the buffer window.
  let crossingIdx = turns.length - 1;
  while (crossingIdx > 0 && turns[crossingIdx - 1]!.outputTokens > thresholdTokens) {
    crossingIdx--;
  }
  const crossingTurn = turns[crossingIdx]!;

  return [
    {
      verb: hintType.verb,
      reason: renderQualityHintReason(hintType, {
        tokens: crossingTurn.outputTokens,
        threshold: thresholdTokens,
      }),
      hintType: hintType.id,
      idempotencyKey: `${hintType.id}:${crossingTurn.turnId}`,
    },
  ];
}
