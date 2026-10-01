/**
 * The orchestrate action that wraps `review/classifier.ts`. It takes normalized `ActionItem`s from
 * `assess_stack` and returns per-file groups, each with a dispatch recommendation.
 * With an event store, it appends a `dispatch.classified` event to measure classifier accuracy and severity distribution.
 */

import { createHash } from 'node:crypto';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import type { ActionItem, Severity } from '../../review/types.js';
import { classifyReviewItems } from '../../review/classifier.js';
import { orchestrateLogger } from '../../logger.js';

/**
 * The idempotency fingerprint of an item batch. It uses each identifying field and sorts the items,
 * so equal batches match in any order and different batches do not match.
 */
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

/**
 * Classifies the items. The event key holds the feature id and the batch fingerprint, so a retry
 * does not append a duplicate event. A failed append logs a warning and does not stop the classification.
 */
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
