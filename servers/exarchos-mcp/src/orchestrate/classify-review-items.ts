// ─── Classify Review Items Orchestrate Action ───────────────────────────────
//
// Wraps review/classifier.ts as an orchestrate action. Consumers
// (typically the shepherd skill) pass an array of normalized ActionItems
// returned by assess_stack and receive a ClassificationResult containing
// per-file groups, each annotated with a dispatch recommendation.
//
// Emits one `dispatch.classified` event per invocation so we can later
// measure classifier accuracy and the realized severity distribution
// across PR comments. The handler is provider-agnostic — it operates on
// already-normalized ActionItems regardless of which adapter produced them.
// ────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { ActionItem, Severity } from '../review/types.js';
import { classifyReviewItems } from '../review/classifier.js';
import { orchestrateLogger } from '../logger.js';

// Canonical per-item fingerprint for idempotency. Including all identifying
// fields (not just threadId) makes the signature stable across equivalent
// inputs and distinct across genuinely different batches; sorting on the
// composite key renders order-insensitivity (#1161 PR feedback).
function canonicalSignature(items: readonly ActionItem[]): string {
  const canonical = items
    .map((i) => ({
      threadId: i.threadId ?? null,
      file: i.file ?? null,
      line: i.line ?? null,
      reviewer: i.reviewer ?? null,
      severity: i.normalizedSeverity ?? null,
      description: i.description ?? null,
    }))
    .sort((a, b) => {
      const ka = `${a.threadId ?? ''}|${a.file ?? ''}|${a.line ?? ''}|${a.reviewer ?? ''}|${a.severity ?? ''}|${a.description ?? ''}`;
      const kb = `${b.threadId ?? ''}|${b.file ?? ''}|${b.line ?? ''}|${b.reviewer ?? ''}|${b.severity ?? ''}|${b.description ?? ''}`;
      return ka.localeCompare(kb);
    });
  return createHash('sha1')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

export interface ClassifyReviewItemsArgs {
  readonly featureId: string;
  readonly actionItems: readonly ActionItem[];
  readonly eventStore?: EventStore;
}

function severityDistribution(items: readonly ActionItem[]): {
  high: number;
  medium: number;
  low: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const item of items) {
    const s: Severity = item.normalizedSeverity ?? 'MEDIUM';
    if (s === 'HIGH') high += 1;
    else if (s === 'MEDIUM') medium += 1;
    else low += 1;
  }
  return { high, medium, low };
}

export async function handleClassifyReviewItems(
  args: ClassifyReviewItemsArgs,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }
  if (!Array.isArray(args.actionItems)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'actionItems must be an array' },
    };
  }

  const result = classifyReviewItems(args.actionItems);

  if (args.eventStore) {
    // Idempotency: same featureId + same input ActionItems → same key,
    // so retries don't accumulate duplicate events on the stream. Telemetry
    // is best-effort — a failing event store must not abort classification,
    // which is the shepherd-visible result (#1161).
    const signature = canonicalSignature(args.actionItems);
    try {
      await args.eventStore.append(args.featureId, {
        type: 'dispatch.classified' as const,
        data: {
          groupCount: result.groups.length,
          directCount: result.summary.directCount,
          delegateCount: result.summary.delegateCount,
          severityDistribution: severityDistribution(args.actionItems),
        },
      }, {
        idempotencyKey: `${args.featureId}:dispatch.classified:${signature}`,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      orchestrateLogger.warn(
        { featureId: args.featureId, err: errorMessage },
        'Failed to append dispatch.classified event; classification result still returned',
      );
    }
  }

  return { success: true, data: result };
}
