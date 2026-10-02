import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  estimateTokens,
  auditDescriptionBudgets,
  formatBudgetReport,
  DESCRIPTION_BUDGETS,
  ACTION_BUDGET_RATCHET_TARGET,
} from './description-budget.js';
import { TOOL_REGISTRY, buildToolDescription } from '../../../src/registry.js';
import { auditLiveDescriptionBudgets } from './bindings/index.js';
import type { CompositeTool, ToolAction } from '../../../src/registry.js';

/**
 * A minimal valid action for the synthetic tools of the planted-bloat cases. Only `name`,
 * `description` and `schema` carry meaning. The other fields satisfy the `ToolAction` contract, so
 * the audit walks the same code paths as for the real registry.
 */
function makeAction(name: string, description: string): ToolAction {
  return {
    name,
    description,
    schema: z.object({}),
    phases: new Set(['any']),
    roles: new Set(['any']),
    outputSchema: z.unknown(),
    annotations: {
      safety: 'read-only',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
  };
}

function makeTool(partial: Partial<CompositeTool> & { name: string }): CompositeTool {
  return {
    description: 'base',
    actions: [],
    ...partial,
  };
}

describe('estimateTokens', () => {
  it('approximates one token per four characters, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(800))).toBe(200);
  });
});

describe('auditDescriptionBudgets — planted over-budget descriptions', () => {
  it('FAILS when an action description exceeds the action budget', () => {
    const overBy = DESCRIPTION_BUDGETS['action']! * 4 + 4;
    const tool = makeTool({
      name: 'exarchos_planted',
      actions: [makeAction('bloated', 'z'.repeat(overBy))],
    });

    const report = auditDescriptionBudgets([tool], buildToolDescription);

    expect(report.pass).toBe(false);
    expect(report.offenders).toHaveLength(1);
    expect(report.offenders[0]).toMatchObject({
      kind: 'action',
      name: 'exarchos_planted.bloated',
      overBudget: true,
    });
    expect(report.offenders[0].tokens).toBeGreaterThan(DESCRIPTION_BUDGETS['action']!);
  });

  it('FAILS when a slim tool description exceeds the slim budget', () => {
    const overBy = DESCRIPTION_BUDGETS['tool.slim']! * 4 + 4;
    const tool = makeTool({
      name: 'exarchos_planted',
      slimDescription: 'z'.repeat(overBy),
    });

    const report = auditDescriptionBudgets([tool], buildToolDescription);

    expect(report.pass).toBe(false);
    expect(report.offenders.some((e) => e.kind === 'tool.slim')).toBe(true);
  });

  it('FAILS when a base tool description exceeds the base budget', () => {
    const overBy = DESCRIPTION_BUDGETS['tool.base']! * 4 + 4;
    const tool = makeTool({
      name: 'exarchos_planted',
      description: 'z'.repeat(overBy),
    });

    const report = auditDescriptionBudgets([tool], buildToolDescription);

    expect(report.pass).toBe(false);
    expect(report.offenders.some((e) => e.kind === 'tool.base')).toBe(true);
  });

  /**
   * Many short actions fold into a large `tool.full` string. Each description is in budget, so the
   * tool must pass, because `tool.full` has no budget.
   */
  it('does NOT enforce the derived tool.full string (measured-only)', () => {
    const actions = Array.from({ length: 40 }, (_, i) =>
      makeAction(`a${i}`, 'short action description well under budget'),
    );
    const tool = makeTool({ name: 'exarchos_wide', actions });

    const report = auditDescriptionBudgets([tool], buildToolDescription);

    const full = report.entries.find((e) => e.kind === 'tool.full');
    expect(full).toBeDefined();
    expect(full!.budget).toBeUndefined();
    expect(full!.overBudget).toBe(false);
    expect(report.pass).toBe(true);
  });
});

describe('auditDescriptionBudgets — live registry surface', () => {
  /**
   * If this fails, a description grew past its budget. Read the report, then trim the description,
   * or move the budget in `DESCRIPTION_BUDGETS` with a reason.
   */
  it('PASSES on the current TOOL_REGISTRY (budgets are green today)', () => {
    const report = auditLiveDescriptionBudgets();
    expect(report.offenders, formatBudgetReport(report)).toEqual([]);
    expect(report.pass).toBe(true);
  });

  /** The audit gives one action entry for each registered action. */
  it('measures every enforced kind against the live surface', () => {
    const report = auditLiveDescriptionBudgets();
    const kinds = new Set(report.entries.map((e) => e.kind));
    expect(kinds.has('action')).toBe(true);
    expect(kinds.has('tool.base')).toBe(true);
    expect(kinds.has('tool.slim')).toBe(true);
    expect(kinds.has('tool.full')).toBe(true);
    const actionEntries = report.entries.filter((e) => e.kind === 'action');
    const totalActions = TOOL_REGISTRY.reduce((n, t) => n + t.actions.length, 0);
    expect(actionEntries).toHaveLength(totalActions);
  });

  /** The ratchet tightens toward the target, and the live ceiling must not drop below it. */
  it('keeps the action budget at or above the R-E ratchet target', () => {
    expect(DESCRIPTION_BUDGETS['action']!).toBeGreaterThanOrEqual(ACTION_BUDGET_RATCHET_TARGET);
  });
});

describe('formatBudgetReport', () => {
  it('flags offenders and names the ratchet target when over budget', () => {
    const overBy = DESCRIPTION_BUDGETS['action']! * 4 + 4;
    const tool = makeTool({
      name: 'exarchos_planted',
      actions: [makeAction('bloated', 'z'.repeat(overBy))],
    });
    const text = formatBudgetReport(auditDescriptionBudgets([tool], buildToolDescription));
    expect(text).toContain('OVER budget');
    expect(text).toContain('exarchos_planted.bloated');
    expect(text).toContain(String(ACTION_BUDGET_RATCHET_TARGET));
  });

  it('reports clean when all descriptions are within budget', () => {
    const tool = makeTool({
      name: 'exarchos_clean',
      slimDescription: 'short',
      actions: [makeAction('ok', 'a concise action description')],
    });
    const text = formatBudgetReport(auditDescriptionBudgets([tool], buildToolDescription));
    expect(text).toContain('within budget (clean)');
  });
});
