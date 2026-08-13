import { describe, it, expect } from 'vitest';
import { QUALITY_CHECK_CATALOG } from './check-catalog.js';

describe('CheckCatalog', () => {
  it('CheckCatalog_DimensionCount_HasAtLeastSix', () => {
    expect(QUALITY_CHECK_CATALOG.dimensions.length).toBeGreaterThanOrEqual(6);
  });

  it('CheckCatalog_TotalChecks_HasAtLeastFifteen', () => {
    const total = QUALITY_CHECK_CATALOG.dimensions.reduce((sum, d) => sum + d.checks.length, 0);
    expect(total).toBeGreaterThanOrEqual(15);
  });

  it('CheckCatalog_AllGrepPatterns_CompileAsValidRegex', () => {
    for (const dim of QUALITY_CHECK_CATALOG.dimensions) {
      for (const check of dim.checks) {
        if (check.pattern) {
          expect(() => new RegExp(check.pattern!), `${check.id}: ${check.pattern}`).not.toThrow();
        }
      }
    }
  });

  it('CheckCatalog_AllChecks_HaveRequiredFields', () => {
    for (const dim of QUALITY_CHECK_CATALOG.dimensions) {
      for (const check of dim.checks) {
        expect(check.id, `check in ${dim.id} missing id`).toBeTruthy();
        expect(check.execution, `${check.id} missing execution`).toBeTruthy();
        expect(check.severity, `${check.id} missing severity`).toBeTruthy();
        expect(check.description, `${check.id} missing description`).toBeTruthy();
        expect(check.remediation, `${check.id} missing remediation`).toBeTruthy();
        expect(check.falsePositives, `${check.id} missing falsePositives`).toBeTruthy();
      }
    }
  });

  it('CheckCatalog_DimensionIds_AreUnique', () => {
    const ids = QUALITY_CHECK_CATALOG.dimensions.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('CheckCatalog_CheckIds_AreUniqueWithinDimension', () => {
    for (const dim of QUALITY_CHECK_CATALOG.dimensions) {
      const ids = dim.checks.map(c => c.id);
      expect(new Set(ids).size, `Duplicate IDs in ${dim.id}`).toBe(ids.length);
    }
  });

  it('CheckCatalog_Severities_AreValidValues', () => {
    const valid = new Set(['HIGH', 'MEDIUM', 'LOW']);
    for (const dim of QUALITY_CHECK_CATALOG.dimensions) {
      for (const check of dim.checks) {
        expect(valid.has(check.severity), `${check.id} has invalid severity: ${check.severity}`).toBe(true);
      }
    }
  });

  it('CheckCatalog_Version_IsSemver', () => {
    expect(QUALITY_CHECK_CATALOG.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
