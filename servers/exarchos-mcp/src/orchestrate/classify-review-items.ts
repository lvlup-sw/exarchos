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

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { ActionItem, Severity } from '../review/types.js';
import { classifyReviewItems } from '../review/classifier.js';

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
    await args.eventStore.append(args.featureId, {
      type: 'dispatch.classified' as const,
      data: {
        groupCount: result.groups.length,
        directCount: result.summary.directCount,
        delegateCount: result.summary.delegateCount,
        severityDistribution: severityDistribution(args.actionItems),
      },
    });
  }

  return { success: true, data: result };
}
