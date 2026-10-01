/**
 * Review classification. It groups review `ActionItem`s by file and gives each
 * group a dispatch recommendation:
 *
 * - `direct`: one item without HIGH severity. The shepherd loop fixes it.
 * - `delegate-fixer`: a HIGH item, or more than one item on the file.
 * - `delegate-scaffolder`: all items LOW, and one matches a doc-nit keyword.
 */

import type {
  ActionItem,
  ClassificationGroup,
  ClassificationResult,
  ClassificationSummary,
  DispatchRecommendation,
  Severity,
} from './types.js';
import { REVIEW_DOC_NIT_KEYWORDS } from '../verbs/tasks/scaffolding-keywords.js';

const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

const DIRECT_FIX_MAX_ITEMS = 1;

const NULL_FILE_KEY = null as unknown as string;

export function groupItemsByFile(
  items: readonly ActionItem[],
): Map<string | null, ActionItem[]> {
  const groups = new Map<string | null, ActionItem[]>();
  for (const item of items) {
    const key = item.file ?? NULL_FILE_KEY;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

function maxSeverity(items: readonly ActionItem[]): Severity {
  let highest: Severity = 'LOW';
  for (const item of items) {
    const s = item.normalizedSeverity ?? 'MEDIUM';
    if (SEVERITY_RANK[s] > SEVERITY_RANK[highest]) {
      highest = s;
    }
  }
  return highest;
}

function isDocNit(item: ActionItem): boolean {
  const haystack = (item.description ?? '').toLowerCase();
  return REVIEW_DOC_NIT_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
}

/**
 * Recommends a dispatch for one file group. A group with more than one item
 * goes to a fixer, so that one fixer reads the file once for all items.
 */
export function recommendForGroup(items: readonly ActionItem[]): {
  recommendation: DispatchRecommendation;
  rationale: string;
  severity: Severity;
} {
  const severity = maxSeverity(items);

  if (severity === 'LOW' && items.some(isDocNit)) {
    return {
      recommendation: 'delegate-scaffolder',
      rationale: 'All items are LOW severity and at least one matches a doc-nit keyword (scaffolding work)',
      severity,
    };
  }

  if (severity === 'HIGH') {
    return {
      recommendation: 'delegate-fixer',
      rationale: 'Group contains HIGH severity item(s); delegate to fixer subagent',
      severity,
    };
  }

  if (items.length > DIRECT_FIX_MAX_ITEMS) {
    return {
      recommendation: 'delegate-fixer',
      rationale: `Group has ${items.length} items on the same file; batched fixer dispatch amortises file-read cost`,
      severity,
    };
  }

  return {
    recommendation: 'direct',
    rationale: 'Single item, non-HIGH severity; cheap to address inline in the shepherd loop',
    severity,
  };
}

export function classifyReviewItems(items: readonly ActionItem[]): ClassificationResult {
  const grouped = groupItemsByFile(items);
  const groups: ClassificationGroup[] = [];
  let directCount = 0;
  let delegateCount = 0;

  for (const [file, groupItems] of grouped.entries()) {
    const { recommendation, rationale, severity } = recommendForGroup(groupItems);
    groups.push({
      file,
      items: groupItems,
      severity,
      recommendation,
      rationale,
    });
    if (recommendation === 'direct') {
      directCount += 1;
    } else {
      delegateCount += 1;
    }
  }

  const summary: ClassificationSummary = {
    totalItems: items.length,
    directCount,
    delegateCount,
  };

  return { groups, summary };
}
