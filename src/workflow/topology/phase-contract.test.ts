/**
 * T45 — `PhaseContractSchema` malformed-input rejection.
 *
 * Ensures the Zod schema rejects malformed contracts at load time with
 * structured errors that reference the phase name and the offending
 * field. The acceptance criterion (DR-7) is:
 *
 *   "Schema validation rejects malformed contracts at load time with a
 *    structured error referencing the phase name and the specific
 *    malformed field."
 *
 * Tests:
 *   - well-formed contract validates
 *   - missing required field fails (errors include the field name and
 *     the phase name when validated through TopologySchema)
 *   - wrong-type field fails
 *   - unknown signal `name` fails (T45 GREEN narrows the open string to
 *     a known-signal enum)
 */
import { describe, it, expect } from 'vitest';
import {
  PhaseContractSchema,
  TopologySchema,
} from './phase-contract.js';

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
      // The signal name lives at signals.0.name
      expect(flatPaths.some((p) => p.endsWith('name'))).toBe(true);
    }
  });
});

describe('TopologySchema_validation_includes_phase_name_in_errors', () => {
  it('error path references the phase name when a contract is malformed', () => {
    const result = TopologySchema.safeParse({
      phases: {
        design: {
          staleness: {
            // missing expectedMaxDwellMinutes
            freshnessRequires: 'all',
            signals: [{ name: 'lastActivity', thresholdMinutes: 60 }],
          },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The structured Zod error path includes the phase name.
      const issuePaths = result.error.issues.map((i) => i.path.join('.'));
      expect(issuePaths.some((p) => p.includes('design'))).toBe(true);
    }
  });
});
