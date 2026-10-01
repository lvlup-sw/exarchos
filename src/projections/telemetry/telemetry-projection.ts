import type { ViewProjection } from '../views/materializer.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { percentile } from './percentile.js';
import {
  getQualityHintType,
  renderQualityHintReason,
  type QualityHintType,
} from './quality-hints.js';

export const TELEMETRY_VIEW = 'telemetry';

const DEFAULT_WINDOW_SIZE = 1000;

export interface ToolMetrics {
  readonly invocations: number;
  /** Count of `tool.errored` events, which are transport and protocol failures. */
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
  /**
   * Count of `tool.action_errored` events, which are typed action failures with an `errorCode`.
   * It is kept apart from `errors`, so a handler that returns an error code does not look like a broken connection.
   */
  readonly actionErrors: number;
  /** The `actionErrors` count for each `errorCode`. */
  readonly actionErrorBreakdown: Readonly<Record<string, number>>;
  /**
   * Count of the responses of this tool over the response-economy token budget.
   * `tokenEstimates` holds only the `tool.completed` calls in the window. This counter keeps a breach countable after it leaves the window.
   * The breach lives in this view, not as a gate row. Nothing runs that gate again, so a gate row keeps its convergence dimension false for the rest of the workflow.
   */
  readonly budgetExceeded: number;
}

/**
 * The output-token sum of one agent turn.
 * The projection folds `turn.completed` events into `view.turns`, so quality-hint generators can find threshold crossings without a second scan of the event stream.
 * A `turn.completed` payload without a string `turnId` and a numeric `outputTokens` has no effect.
 */
export interface TurnRecord {
  readonly turnId: string;
  readonly outputTokens: number;
}

export interface TelemetryViewState {
  readonly tools: Record<string, ToolMetrics>;
  readonly sessionStart: string;
  readonly totalInvocations: number;
  readonly totalTokens: number;
  readonly windowSize: number;
  /** Per-turn output-token records. The reducer keeps the last `windowSize + 1` turns, so a long session cannot grow the view state without limit. */
  readonly turns: readonly TurnRecord[];
}

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
    actionErrors: 0,
    actionErrorBreakdown: {},
    budgetExceeded: 0,
  };
}

function appendWithCap(arr: readonly number[], value: number, cap: number): readonly number[] {
  const next = [...arr, value];
  if (next.length <= cap) return next;
  return next.slice(next.length - cap);
}

export const telemetryProjection: ViewProjection<TelemetryViewState> = {
  init: () => ({
    tools: {},
    sessionStart: new Date().toISOString(),
    totalInvocations: 0,
    totalTokens: 0,
    windowSize: DEFAULT_WINDOW_SIZE,
    turns: [],
  }),

  /**
   * Folds tool, budget, and turn events into the view.
   * The `tool.completed` arm lists each `ToolMetrics` field with no spread, so a new field fails the type check until that arm sets it.
   * That arm must carry the counters of the other arms forward, or the next completion erases them.
   */
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
          actionErrors: existing.actionErrors,
          actionErrorBreakdown: existing.actionErrorBreakdown,
          budgetExceeded: existing.budgetExceeded,
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

      case 'tool.budget_exceeded': {
        const beData = event.data as { tool?: unknown } | undefined;
        if (!beData || typeof beData.tool !== 'string') return view;

        const existing = view.tools[beData.tool] ?? initToolMetrics();
        return {
          ...view,
          tools: {
            ...view.tools,
            [beData.tool]: { ...existing, budgetExceeded: existing.budgetExceeded + 1 },
          },
        };
      }

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

/**
 * A hint for a turn with an output-token sum above the threshold.
 * It has the `verb`, `reason`, and `idempotencyKey` fields of a `NextAction`, so the envelope formatter can lift it into `next_actions[]`.
 */
export interface OutputTokenHint {
  readonly verb: string;
  readonly reason: string;
  readonly hintType: string;
  readonly idempotencyKey: string;
}

/**
 * Computes the output-token quality hint for the telemetry view state.
 * Returns `[]` when the catalog has no `output_tokens_high` entry, when there are no turns, or when the latest turn is at or below `thresholdTokens`.
 * Otherwise it returns one hint, and only the latest turn decides it.
 *
 * The function walks back from the latest turn to the first kept turn of the current streak above the threshold.
 * The `idempotencyKey` uses that turn, so one streak gives the same key on each view request, and callers can dedupe.
 * When every kept turn is above the threshold, the key uses the earliest kept turn.
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
