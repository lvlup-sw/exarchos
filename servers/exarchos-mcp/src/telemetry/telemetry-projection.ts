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
      // [`docs/designs/2026-05-15-wave2-wave3-polish.md`](../../docs/designs/2026-05-15-wave2-wave3-polish.md).
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
        const turns = next.length <= view.windowSize
          ? next
          : next.slice(next.length - view.windowSize);

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
 * A NextAction-shaped hint surfaced when a per-turn output-token sum crosses
 * the configured threshold. The shape is intentionally a subset of
 * `NextAction` (verb + reason) so the envelope formatter can lift it
 * directly into `next_actions[]` without translation.
 */
export interface OutputTokenHint {
  readonly verb: string;
  readonly reason: string;
  readonly hintType: string;
}

/**
 * Compute output-token quality hints for the given telemetry view state.
 *
 * Walks `view.turns` and emits hints using **edge-triggered** semantics:
 * one hint per upward transition from below-threshold to above-threshold.
 * A sequence of consecutive above-threshold turns produces a single hint,
 * not one per turn — a below-threshold turn must intervene to re-arm the
 * detector. The threshold is supplied explicitly (rather than read from a
 * constant) so callers — typically the envelope wrap point — can pull the
 * value from `.exarchos.yml` via the config resolver (T05).
 *
 * CodeRabbit MEDIUM (#1262): the previous per-turn implementation emitted
 * a hint for every above-threshold turn, flooding `next_actions[]` on
 * long high-output sessions. Edge-triggered emission de-duplicates while
 * preserving the "session crossed into a danger zone" signal.
 *
 * Returns `[]` when the catalog entry is missing (defensive) or no turn
 * crosses the threshold.
 */
export function computeOutputTokenHints(
  view: TelemetryViewState,
  thresholdTokens: number,
): readonly OutputTokenHint[] {
  const hintType: QualityHintType | undefined = getQualityHintType('output_tokens_high');
  if (!hintType) return [];

  const hints: OutputTokenHint[] = [];
  let above = false;
  for (const turn of view.turns) {
    const crossesThreshold = turn.outputTokens > thresholdTokens;
    if (crossesThreshold && !above) {
      // Upward transition: emit a hint and latch the above-threshold state.
      hints.push({
        verb: hintType.verb,
        reason: renderQualityHintReason(hintType, {
          tokens: turn.outputTokens,
          threshold: thresholdTokens,
        }),
        hintType: hintType.id,
      });
      above = true;
    } else if (!crossesThreshold) {
      // Below-threshold turn: re-arm so the next upward crossing fires.
      above = false;
    }
    // crossesThreshold && above → suppress (already emitted this run).
  }
  return hints;
}
