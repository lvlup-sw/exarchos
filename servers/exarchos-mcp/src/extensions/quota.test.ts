import { describe, it, expect } from 'vitest';
import {
  ExtensionQuotaSchema,
  evaluateContentQuota,
  evaluateDeclaredQuota,
  type ExtensionQuota,
} from './quota.js';

const BUDGET: ExtensionQuota = ExtensionQuotaSchema.parse({
  maxContentBytes: 1_000,
  maxMemoryBytes: 10_000,
  maxRuntimeMillis: 5_000,
  maxConcurrency: 4,
});

function declared(overrides: Partial<Record<keyof ExtensionQuota, number>>): ExtensionQuota {
  return ExtensionQuotaSchema.parse({
    maxContentBytes: 500,
    maxMemoryBytes: 5_000,
    maxRuntimeMillis: 2_000,
    maxConcurrency: 2,
    ...overrides,
  });
}

describe('evaluateDeclaredQuota (P03-08)', () => {
  it('Quota_DeclaredWithinBudget_Admissible', () => {
    expect(evaluateDeclaredQuota(declared({}), BUDGET).withinBudget).toBe(true);
  });

  it('Quota_DeclaredMemoryExceedsBudget_FailsClosed', () => {
    const result = evaluateDeclaredQuota(declared({ maxMemoryBytes: 20_000 }), BUDGET);
    expect(result.withinBudget).toBe(false);
    if (!result.withinBudget) expect(result.detail).toContain('maxMemoryBytes');
  });

  it('Quota_DeclaredConcurrencyExceedsBudget_FailsClosed', () => {
    const result = evaluateDeclaredQuota(declared({ maxConcurrency: 8 }), BUDGET);
    expect(result.withinBudget).toBe(false);
  });
});

describe('evaluateContentQuota (P03-08)', () => {
  it('Quota_ContentWithinDeclared_Admissible', () => {
    expect(evaluateContentQuota(declared({}), BUDGET, 400).withinBudget).toBe(true);
  });

  it('Quota_ContentExceedsDeclared_FailsClosed', () => {
    const result = evaluateContentQuota(declared({ maxContentBytes: 100 }), BUDGET, 400);
    expect(result.withinBudget).toBe(false);
    if (!result.withinBudget) expect(result.detail).toContain('declared maxContentBytes');
  });

  it('Quota_ContentExceedsBudget_FailsClosed', () => {
    // declared ceiling is generous but the host budget is the harder cap.
    const result = evaluateContentQuota(
      declared({ maxContentBytes: 100_000 }),
      BUDGET,
      2_000,
    );
    expect(result.withinBudget).toBe(false);
    if (!result.withinBudget) expect(result.detail).toContain('host budget');
  });
});
