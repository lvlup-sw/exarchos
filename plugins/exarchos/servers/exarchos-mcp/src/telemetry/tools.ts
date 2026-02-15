// ─── Telemetry MCP Tool Handler ──────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import { getOrCreateMaterializer, getOrCreateEventStore } from '../views/tools.js';
import { TELEMETRY_VIEW } from './telemetry-projection.js';
import type { TelemetryViewState, ToolMetrics } from './telemetry-projection.js';
import { TELEMETRY_STREAM } from './constants.js';
import { generateHints } from './hints.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ViewTelemetryArgs {
  compact?: boolean;
  tool?: string;
  sort?: 'tokens' | 'invocations' | 'duration';
  limit?: number;
}

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
  args: ViewTelemetryArgs,
  stateDir: string,
): Promise<ToolResult> {
  try {
    const store = getOrCreateEventStore(stateDir);
    const materializer = getOrCreateMaterializer(stateDir);

    // Materialize the telemetry view from the telemetry stream
    await materializer.loadFromSnapshot(TELEMETRY_STREAM, TELEMETRY_VIEW);
    const events = await store.query(TELEMETRY_STREAM);
    const view = materializer.materialize<TelemetryViewState>(
      TELEMETRY_STREAM,
      TELEMETRY_VIEW,
      events,
    );

    // Convert tools map to array of { tool, ...metrics } entries
    let toolEntries = Object.entries(view.tools).map(([name, metrics]) =>
      toToolEntry(name, metrics, args.compact !== false),
    );

    // Apply tool filter
    if (args.tool) {
      toolEntries = toolEntries.filter((entry) => entry.tool === args.tool);
    }

    // Apply sort (descending)
    if (args.sort) {
      const sortField = SORT_FIELDS[args.sort];
      if (sortField) {
        toolEntries.sort((a, b) => {
          const aVal = (a as unknown as Record<string, number>)[sortField] ?? 0;
          const bVal = (b as unknown as Record<string, number>)[sortField] ?? 0;
          return bVal - aVal;
        });
      }
    }

    // Apply limit
    if (args.limit !== undefined) {
      toolEntries = toolEntries.slice(0, args.limit);
    }

    // Generate hints
    const hints = generateHints(view);

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

