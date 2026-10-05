/** Handler for the telemetry action of `exarchos_view`. */

import { toViewFailure } from '../degraded-result.js';
import { foldToTail } from '../fold-at-tail.js';
import { z } from 'zod';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import {
  getOrCreateMaterializer,
  materializeFiltered,
  hasCorrelationFilters,
  deriveCorrelationFilters,
} from '../views/tools.js';
import {
  TELEMETRY_VIEW,
  computeOutputTokenHints,
} from './telemetry-projection.js';
import type { TelemetryViewState, ToolMetrics } from './telemetry-projection.js';
import { TELEMETRY_STREAM } from './constants.js';
import { generateHints } from './hints.js';
import {
  getQualityHintThreshold,
  type QualityHintsConfig,
} from '../../workflow/capabilities/resolver.js';
import type { NextAction } from '../../next-action.js';

/**
 * Arguments of the telemetry view.
 * Rows are compact by default. `detail: true` or `compact: false` adds the rolling `durations`, `sizes`, and `tokenEstimates` arrays.
 * The correlation filters scope `EventStore.query` to the events of one dispatch boundary.
 */
const ViewTelemetryArgsSchema = z.object({
  compact: z.boolean().optional(),
  detail: z.boolean().optional(),
  tool: z.string().optional(),
  sort: z.enum(['tokens', 'invocations', 'duration']).optional(),
  limit: z.number().int().positive().optional(),
  operationId: z.string().optional(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
});

type ViewTelemetryArgs = z.infer<typeof ViewTelemetryArgsSchema>;

interface CompactToolEntry {
  readonly tool: string;
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
  /** The output schema `TelemetryToolEntrySchema` requires this field and `actionErrorBreakdown`. Without them, `validateAgainstActionSchema` rejects the envelope. */
  readonly actionErrors: number;
  readonly actionErrorBreakdown: Readonly<Record<string, number>>;
}

interface FullToolEntry extends CompactToolEntry {
  readonly durations: readonly number[];
  readonly sizes: readonly number[];
  readonly tokenEstimates: readonly number[];
}

const SORT_FIELDS: Record<string, keyof ToolMetrics> = {
  tokens: 'totalTokens',
  invocations: 'invocations',
  duration: 'totalDurationMs',
};

/**
 * Returns the telemetry view: session totals, per-tool rows, and hints.
 * With a correlation filter, it folds only the matching events and skips the materializer cache, so the filtered fold does not change unfiltered reads.
 * The `tool` filter, the descending `sort`, and the `limit` apply in that order.
 * Each output-token hint goes in `next_actions[]` with its `idempotencyKey`, so callers can dedupe repeated hints for one streak.
 */
export async function handleViewTelemetry(
  args: unknown,
  stateDir: string,
  eventStore: EventStore,
  config?: QualityHintsConfig,
): Promise<ToolResult> {
  const parseResult = ViewTelemetryArgsSchema.safeParse(args);
  if (!parseResult.success) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: parseResult.error.issues.map((i) => i.message).join('; '),
      },
    };
  }
  const validated = parseResult.data;

  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);

    const correlationFilters = deriveCorrelationFilters(validated);
    const filtered = hasCorrelationFilters(correlationFilters);
    let view: TelemetryViewState;
    if (filtered) {
      const events = await store.query(TELEMETRY_STREAM, correlationFilters);
      view = materializeFiltered<TelemetryViewState>(materializer, TELEMETRY_VIEW, events);
    } else {
      view = (await foldToTail<TelemetryViewState>(
        store,
        materializer,
        TELEMETRY_STREAM,
        TELEMETRY_VIEW,
      )).view;
    }

    const wantFull = validated.detail === true || validated.compact === false;

    let toolEntries = Object.entries(view.tools).map(([name, metrics]) =>
      toToolEntry(name, metrics, !wantFull),
    );

    if (validated.tool) {
      toolEntries = toolEntries.filter((entry) => entry.tool === validated.tool);
    }

    if (validated.sort) {
      const sortField = SORT_FIELDS[validated.sort];
      if (sortField) {
        toolEntries.sort((a, b) => {
          const aVal = (a as unknown as Record<string, number>)[sortField] ?? 0;
          const bVal = (b as unknown as Record<string, number>)[sortField] ?? 0;
          return bVal - aVal;
        });
      }
    }

    if (validated.limit !== undefined) {
      toolEntries = toolEntries.slice(0, validated.limit);
    }

    const hints = generateHints(view);

    const threshold = getQualityHintThreshold('output_tokens', config);
    const tokenHints = computeOutputTokenHints(view, threshold);
    const nextActions: readonly NextAction[] = tokenHints.map((h) => ({
      verb: h.verb,
      reason: h.reason,
      idempotencyKey: h.idempotencyKey,
    }));

    return {
      success: true,
      data: {
        session: {
          start: view.sessionStart,
          totalInvocations: view.totalInvocations,
          totalTokens: view.totalTokens,
        },
        tools: toolEntries,
        hints,
      },
      ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'telemetry' });
  }
}

function toToolEntry(
  name: string,
  metrics: ToolMetrics,
  compact: boolean,
): CompactToolEntry | FullToolEntry {
  const base: CompactToolEntry = {
    tool: name,
    invocations: metrics.invocations,
    errors: metrics.errors,
    totalDurationMs: metrics.totalDurationMs,
    totalBytes: metrics.totalBytes,
    totalTokens: metrics.totalTokens,
    p50DurationMs: metrics.p50DurationMs,
    p95DurationMs: metrics.p95DurationMs,
    p50Bytes: metrics.p50Bytes,
    p95Bytes: metrics.p95Bytes,
    p50Tokens: metrics.p50Tokens,
    p95Tokens: metrics.p95Tokens,
    actionErrors: metrics.actionErrors,
    actionErrorBreakdown: metrics.actionErrorBreakdown,
  };

  if (compact) {
    return base;
  }

  return {
    ...base,
    durations: metrics.durations,
    sizes: metrics.sizes,
    tokenEstimates: metrics.tokenEstimates,
  };
}
