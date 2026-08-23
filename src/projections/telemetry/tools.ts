// ─── Telemetry MCP Tool Handler ──────────────────────────────────────────────

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

// ─── Types ──────────────────────────────────────────────────────────────────

const ViewTelemetryArgsSchema = z.object({
  compact: z.boolean().optional(),
  // DR-8 / B-4 (Task 014) — compact-by-default is the telemetry contract, so
  // the `--compact` flag was a no-op against the default (both stripped the
  // heavy rolling-window arrays). `detail: true` is now the explicit restore
  // path — matching the 013/024 view contract — so `compact: true` measurably
  // reduces output relative to the `detail: true` full response. The legacy
  // `compact: false` restore remains honored for backward compatibility.
  detail: z.boolean().optional(),
  tool: z.string().optional(),
  sort: z.enum(['tokens', 'invocations', 'duration']).optional(),
  limit: z.number().int().positive().optional(),
  // Wave 5 (#1437) — correlation tuple filters scope `EventStore.query`
  // to events stamped by the same dispatch boundary. Honored at the
  // backend layer (SQL indexed-WHERE / in-memory post-fetch filter).
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
  // PR3/T10 (#1364) — structured action-level failure counters. These
  // mirror the `TelemetryToolEntrySchema` fields registered for the
  // `view.telemetry` action's output schema; omitting them here would
  // make `validateAgainstActionSchema` reject the envelope and surface
  // INTERNAL_ERROR/outputSchemaViolation to the caller.
  readonly actionErrors: number;
  readonly actionErrorBreakdown: Readonly<Record<string, number>>;
}

interface FullToolEntry extends CompactToolEntry {
  readonly durations: readonly number[];
  readonly sizes: readonly number[];
  readonly tokenEstimates: readonly number[];
}

// ─── Sort Field Mapping ─────────────────────────────────────────────────────

const SORT_FIELDS: Record<string, keyof ToolMetrics> = {
  tokens: 'totalTokens',
  invocations: 'invocations',
  duration: 'totalDurationMs',
};

// ─── Handler ────────────────────────────────────────────────────────────────

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

    // Materialize the telemetry view from the telemetry stream.
    // Wave 5 (#1437) — when a correlation filter arg is present, scope the
    // query to that dispatch boundary so the rollup reflects only matching
    // events. The filter handle is the indexed columns on the SQLite
    // substrate / a post-fetch JS filter on the in-memory backend; INV-1
    // keeps the value of truth on the payload, mirrored to the columns.
    // Filtered queries bypass the materializer cache (see ViewQueryFilters
    // doc in views/tools.ts) so an unfiltered call before or after is not
    // contaminated by the filtered fold.
    const correlationFilters = deriveCorrelationFilters(validated);
    const filtered = hasCorrelationFilters(correlationFilters);
    let view: TelemetryViewState;
    if (filtered) {
      const events = await store.query(TELEMETRY_STREAM, correlationFilters);
      view = materializeFiltered<TelemetryViewState>(materializer, TELEMETRY_VIEW, events);
    } else {
      await materializer.loadFromSnapshot(TELEMETRY_STREAM, TELEMETRY_VIEW);
      const events = await store.query(TELEMETRY_STREAM);
      view = materializer.materialize<TelemetryViewState>(
        TELEMETRY_STREAM,
        TELEMETRY_VIEW,
        events,
      );
    }

    // DR-8 / B-4 (Task 014) — compact-by-default; the full per-tool rolling
    // window arrays (`durations`/`sizes`/`tokenEstimates`, capped at 1000 each
    // and the heaviest secondary sub-structure) are restored only under an
    // explicit `detail: true` (or the legacy `compact: false`). This makes the
    // `--compact` flag measurably reduce output against the `detail: true`
    // response instead of being a no-op against an already-compact default.
    const wantFull = validated.detail === true || validated.compact === false;

    // Convert tools map to array of { tool, ...metrics } entries
    let toolEntries = Object.entries(view.tools).map(([name, metrics]) =>
      toToolEntry(name, metrics, !wantFull),
    );

    // Apply tool filter
    if (validated.tool) {
      toolEntries = toolEntries.filter((entry) => entry.tool === validated.tool);
    }

    // Apply sort (descending)
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

    // Apply limit
    if (validated.limit !== undefined) {
      toolEntries = toolEntries.slice(0, validated.limit);
    }

    // Generate hints
    const hints = generateHints(view);

    // #1262 — compute output-token quality hints and surface them via
    // `next_actions[]` so the envelope-wrap boundary lifts them onto the
    // outgoing payload alongside any HSM-derived verbs. Each hint becomes
    // one `NextAction` entry with `verb: 'checkpoint'`. The threshold is
    // resolved from `.exarchos.yml` → `qualityHints.outputTokenThreshold`
    // (default 80% of the per-turn cap).
    const threshold = getQualityHintThreshold('output_tokens', config);
    const tokenHints = computeOutputTokenHints(view, threshold);
    const nextActions: readonly NextAction[] = tokenHints.map((h) => ({
      verb: h.verb,
      reason: h.reason,
      // Sentry MEDIUM #1424: thread idempotencyKey through so downstream
      // dedup of repeated checkpoint hints on the same streak works.
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
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── Entry Builder ──────────────────────────────────────────────────────────

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
