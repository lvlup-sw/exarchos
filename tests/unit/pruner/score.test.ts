/**
 * `scoreStaleness(state, contract)` is pure: the caller supplies minutes, and the
 * scorer reads no clock. With `freshnessRequires: 'all'`, one stale signal makes the
 * workflow stale. With `'any'`, the workflow is stale only when every declared
 * signal is stale. `pruner.dr7-removal.test.ts` pins that the scorer has no fallback
 * for a missing contract.
 */
import { describe, it, expect } from 'vitest';
import { scoreStaleness } from '../../../src/pruner/score.js';
import type { PhaseContract } from '../../../src/workflow/topology/phase-contract.js';

const ALL_CONTRACT: PhaseContract = {
  expectedMaxDwellMinutes: 60,
  freshnessRequires: 'all',
  signals: [
    { name: 'lastActivity', thresholdMinutes: 60 },
    { name: 'phaseTransition', thresholdMinutes: 60 },
  ],
};

const ANY_CONTRACT: PhaseContract = {
  expectedMaxDwellMinutes: 120,
  freshnessRequires: 'any',
  signals: [
    { name: 'lastActivity', thresholdMinutes: 120 },
    { name: 'branchActivity', thresholdMinutes: 120 },
  ],
};

describe('scoreStaleness_with_contract', () => {
  describe('freshnessRequires: all', () => {
    it('all signals fresh → not stale', () => {
      const result = scoreStaleness(
        { lastActivityMinutes: 10, phaseTransitionMinutes: 10 },
        ALL_CONTRACT,
      );
      expect(result.isStale).toBe(false);
    });

    it('one signal stale → stale (any signal exceeding threshold flips)', () => {
      const result = scoreStaleness(
        { lastActivityMinutes: 10, phaseTransitionMinutes: 9999 },
        ALL_CONTRACT,
      );
      expect(result.isStale).toBe(true);
    });

    it('all signals stale → stale', () => {
      const result = scoreStaleness(
        { lastActivityMinutes: 9999, phaseTransitionMinutes: 9999 },
        ALL_CONTRACT,
      );
      expect(result.isStale).toBe(true);
    });
  });

  describe('freshnessRequires: any', () => {
    it('one signal fresh → not stale', () => {
      const result = scoreStaleness(
        { lastActivityMinutes: 9999, branchActivityMinutes: 10 },
        ANY_CONTRACT,
      );
      expect(result.isStale).toBe(false);
    });

    it('all declared signals stale → stale', () => {
      const result = scoreStaleness(
        { lastActivityMinutes: 9999, branchActivityMinutes: 9999 },
        ANY_CONTRACT,
      );
      expect(result.isStale).toBe(true);
    });

    it('no declared signals are fresh and at least one is missing → stale (missing = no evidence)', () => {
      const result = scoreStaleness(
        { lastActivityMinutes: 9999 },
        ANY_CONTRACT,
      );
      expect(result.isStale).toBe(true);
    });
  });

  it('exposes the per-signal staleness verdicts on the result for diagnostics', () => {
    const result = scoreStaleness(
      { lastActivityMinutes: 10, phaseTransitionMinutes: 9999 },
      ALL_CONTRACT,
    );
    expect(result.signalsEvaluated).toEqual({
      lastActivity: false,
      phaseTransition: true,
    });
  });

  it('contract present + all declared signals absent → stale via per-signal whenAbsent convention', () => {
    const contract: PhaseContract = {
      expectedMaxDwellMinutes: 60,
      freshnessRequires: 'all',
      signals: [{ name: 'lastActivity', thresholdMinutes: 60 }],
    };
    const result = scoreStaleness({}, contract);
    expect(result.isStale).toBe(true);
  });
});
