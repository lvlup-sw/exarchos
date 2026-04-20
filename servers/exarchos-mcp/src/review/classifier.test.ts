import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  classifyReviewItems,
  groupItemsByFile,
  recommendForGroup,
} from './classifier.js';
import type { ActionItem } from './types.js';

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    type: 'comment-reply',
    pr: 1,
    description: overrides.description ?? 'sample',
    severity: 'major',
    normalizedSeverity: 'MEDIUM',
    ...overrides,
  };
}

describe('groupItemsByFile', () => {
  it('GroupItemsByFile_TwoItemsSameFile_ReturnsOneGroup', () => {
    const groups = groupItemsByFile([
      makeItem({ file: 'src/a.ts', line: 10 }),
      makeItem({ file: 'src/a.ts', line: 20 }),
    ]);
    expect(groups.size).toBe(1);
    expect(groups.get('src/a.ts')).toHaveLength(2);
  });

  it('GroupItemsByFile_ItemsAcrossFiles_ReturnsOneGroupPerFile', () => {
    const groups = groupItemsByFile([
      makeItem({ file: 'src/a.ts' }),
      makeItem({ file: 'src/b.ts' }),
      makeItem({ file: 'src/a.ts' }),
    ]);
    expect(groups.size).toBe(2);
    expect(groups.get('src/a.ts')).toHaveLength(2);
    expect(groups.get('src/b.ts')).toHaveLength(1);
  });

  it('GroupItemsByFile_ItemsWithoutFile_GroupedUnderNullKey', () => {
    const groups = groupItemsByFile([
      makeItem({ file: undefined }),
      makeItem({ file: undefined }),
    ]);
    expect(groups.has(null as unknown as string)).toBe(true);
    expect(groups.get(null as unknown as string)).toHaveLength(2);
  });
});

describe('recommendForGroup', () => {
  it('RecommendForGroup_SingleNonHighItem_RecommendsDirect', () => {
    const r = recommendForGroup([makeItem({ normalizedSeverity: 'MEDIUM' })]);
    expect(r.recommendation).toBe('direct');
    expect(r.severity).toBe('MEDIUM');
    expect(r.rationale).toMatch(/single|direct/i);
  });

  it('RecommendForGroup_MultipleItemsSameFile_RecommendsDelegateFixer', () => {
    const r = recommendForGroup([
      makeItem({ file: 'src/a.ts', normalizedSeverity: 'MEDIUM' }),
      makeItem({ file: 'src/a.ts', normalizedSeverity: 'MEDIUM' }),
    ]);
    expect(r.recommendation).toBe('delegate-fixer');
  });

  it('RecommendForGroup_AnyHighSeverity_RecommendsDelegateFixer', () => {
    const r = recommendForGroup([makeItem({ normalizedSeverity: 'HIGH' })]);
    expect(r.recommendation).toBe('delegate-fixer');
    expect(r.severity).toBe('HIGH');
  });

  it('RecommendForGroup_AllLowWithDocNitKeyword_RecommendsScaffolder', () => {
    const r = recommendForGroup([
      makeItem({
        normalizedSeverity: 'LOW',
        description: 'Add <remarks> XML doc on PublicMethod',
      }),
    ]);
    expect(r.recommendation).toBe('delegate-scaffolder');
  });

  it('RecommendForGroup_LowSeverityNoDocNitKeyword_RecommendsDirect', () => {
    const r = recommendForGroup([
      makeItem({
        normalizedSeverity: 'LOW',
        description: 'Consider renaming the variable for clarity',
      }),
    ]);
    expect(r.recommendation).toBe('direct');
  });

  it('RecommendForGroup_PopulatesRationale', () => {
    const r = recommendForGroup([makeItem({ normalizedSeverity: 'HIGH' })]);
    expect(r.rationale.length).toBeGreaterThan(0);
  });

  it('RecommendForGroup_MaxSeverityIsHighWhenMixed', () => {
    const r = recommendForGroup([
      makeItem({ normalizedSeverity: 'LOW' }),
      makeItem({ normalizedSeverity: 'HIGH' }),
      makeItem({ normalizedSeverity: 'MEDIUM' }),
    ]);
    expect(r.severity).toBe('HIGH');
  });
});

describe('classifyReviewItems', () => {
  it('ClassifyReviewItems_MixedItems_ProducesGroupsAndSummary', () => {
    const result = classifyReviewItems([
      makeItem({ file: 'src/a.ts', normalizedSeverity: 'HIGH' }),
      makeItem({ file: 'src/a.ts', normalizedSeverity: 'MEDIUM' }),
      makeItem({ file: 'src/b.ts', normalizedSeverity: 'LOW', description: 'nit' }),
      makeItem({ file: undefined, normalizedSeverity: 'MEDIUM' }),
    ]);
    expect(result.groups.length).toBe(3);
    expect(result.summary.totalItems).toBe(4);
    expect(result.summary.directCount + result.summary.delegateCount).toBe(3);
  });

  it('ClassifyReviewItems_PartitionInvariant', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            file: fc.option(fc.string({ minLength: 1, maxLength: 30 })),
            severity: fc.constantFrom('HIGH', 'MEDIUM', 'LOW') as fc.Arbitrary<
              'HIGH' | 'MEDIUM' | 'LOW'
            >,
          }),
          { maxLength: 50 },
        ),
        (raw) => {
          const items: ActionItem[] = raw.map((r) =>
            makeItem({
              file: r.file ?? undefined,
              normalizedSeverity: r.severity,
            }),
          );
          const result = classifyReviewItems(items);
          const itemsInGroups = result.groups.flatMap((g) => g.items as ActionItem[]);
          // Partition: every item appears in exactly one group, no losses, no duplicates.
          expect(itemsInGroups.length).toBe(items.length);
          expect(result.summary.totalItems).toBe(items.length);
        },
      ),
    );
  });
});
