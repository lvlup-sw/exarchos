/**
 * `PhaseContractSchema` rejects malformed contracts at load time.
 * The structured error names the malformed field. Through `TopologySchema`, the error path also names the phase.
 */
import { describe, it, expect } from 'vitest';
import {
  PhaseContractSchema,
  TopologySchema,
} from '../../../../src/workflow/topology/phase-contract.js';

describe('PhaseContractSchema_validation', () => {
  it('accepts a well-formed contract', () => {
    const result = PhaseContractSchema.safeParse({
      expectedMaxDwellMinutes: 60,
      freshnessRequires: 'all',
      signals: [{ name: 'lastActivity', thresholdMinutes: 60 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a contract missing `expectedMaxDwellMinutes`', () => {
    const result = PhaseContractSchema.safeParse({
      freshnessRequires: 'all',
      signals: [{ name: 'lastActivity', thresholdMinutes: 60 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flatPaths = result.error.issues.map((i) => i.path.join('.'));
      expect(flatPaths).toContain('expectedMaxDwellMinutes');
    }
  });

  it('rejects a contract missing `signals`', () => {
    const result = PhaseContractSchema.safeParse({
      expectedMaxDwellMinutes: 60,
      freshnessRequires: 'all',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flatPaths = result.error.issues.map((i) => i.path.join('.'));
      expect(flatPaths).toContain('signals');
    }
  });

  it('rejects a wrong-type field (`expectedMaxDwellMinutes: "thirty"`)', () => {
    const result = PhaseContractSchema.safeParse({
      expectedMaxDwellMinutes: 'thirty',
      freshnessRequires: 'all',
      signals: [{ name: 'lastActivity', thresholdMinutes: 60 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flatPaths = result.error.issues.map((i) => i.path.join('.'));
      expect(flatPaths).toContain('expectedMaxDwellMinutes');
    }
  });

  it('rejects `freshnessRequires` outside the {all, any} enum', () => {
    const result = PhaseContractSchema.safeParse({
      expectedMaxDwellMinutes: 60,
      freshnessRequires: 'sometimes',
      signals: [{ name: 'lastActivity', thresholdMinutes: 60 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flatPaths = result.error.issues.map((i) => i.path.join('.'));
      expect(flatPaths).toContain('freshnessRequires');
    }
  });

  it('rejects unknown signal `name` values', () => {
    const result = PhaseContractSchema.safeParse({
      expectedMaxDwellMinutes: 60,
      freshnessRequires: 'all',
      signals: [{ name: 'completelyUnknownSignal', thresholdMinutes: 60 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flatPaths = result.error.issues.map((i) => i.path.join('.'));
      expect(flatPaths.some((p) => p.endsWith('name'))).toBe(true);
    }
  });
});

describe('TopologySchema_validation_includes_phase_name_in_errors', () => {
  /** The `design` contract lacks `expectedMaxDwellMinutes`. */
  it('error path references the phase name when a contract is malformed', () => {
    const result = TopologySchema.safeParse({
      phases: {
        design: {
          staleness: {
            freshnessRequires: 'all',
            signals: [{ name: 'lastActivity', thresholdMinutes: 60 }],
          },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((i) => i.path.join('.'));
      expect(issuePaths.some((p) => p.includes('design'))).toBe(true);
    }
  });
});
