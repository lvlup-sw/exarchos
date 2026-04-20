// ─── Review Classification (Issue #1159 Phase 2) ────────────────────────────
//
// Promotes the prose direct-vs-delegate heuristic from
// skills-src/shepherd/references/fix-strategies.md into a structured
// orchestrate action. Consumers pass a list of ActionItems (typically the
// `actionItems` returned by assess_stack) and receive a list of file-keyed
// groups, each with a recommended dispatch strategy:
//
//   direct              — small enough to fix in the running shepherd loop
//   delegate-fixer      — multi-item or HIGH severity → spawn fixer subagent
//   delegate-scaffolder — pure doc-nit cluster → cheap scaffolder dispatch
//
// The shared SCAFFOLDING_KEYWORDS constant is also used by
// orchestrate/prepare-delegation.ts (#1159 design Q-P5 resolution).
// ────────────────────────────────────────────────────────────────────────────

import type {
  ActionItem,
  ClassificationGroup,
  ClassificationResult,
  ClassificationSummary,
  DispatchRecommendation,
  Severity,
} from './types.js';
import { SCAFFOLDING_KEYWORDS } from '../orchestrate/scaffolding-keywords.js';

const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

const DIRECT_FIX_MAX_ITEMS = 1;

const NULL_FILE_KEY = null as unknown as string;

// ─── Grouping ──────────────────────────────────────────────────────────────

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

// ─── Per-Group Recommendation ──────────────────────────────────────────────

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
  return SCAFFOLDING_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
}

export function recommendForGroup(items: readonly ActionItem[]): {
  recommendation: DispatchRecommendation;
  rationale: string;
  severity: Severity;
} {
  const severity = maxSeverity(items);

  // All-LOW + at least one doc-nit keyword → cheap scaffolder dispatch.
  if (severity === 'LOW' && items.some(isDocNit)) {
    return {
      recommendation: 'delegate-scaffolder',
      rationale: 'All items are LOW severity and at least one matches a doc-nit keyword (scaffolding work)',
      severity,
    };
  }

  // Any HIGH severity → delegate to fixer subagent regardless of count.
  if (severity === 'HIGH') {
    return {
      recommendation: 'delegate-fixer',
      rationale: 'Group contains HIGH severity item(s); delegate to fixer subagent',
      severity,
    };
  }

  // Multi-item groups (same file, multiple comments) → delegate to amortise
  // file-read overhead per #1159 P1.
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

// ─── Top-Level Entry Point ─────────────────────────────────────────────────

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
