/**
 * `scoreStaleness(state, contract)` pure-function tests (DR-7, v2.11).
 *
 * Verifies the typed-contract reduction:
 *   - 'all' → fresh iff every declared signal is fresh
 *             (i.e. stale iff ANY signal exceeds its threshold)
 *   - 'any' → fresh iff at least one declared signal is fresh
 *             (i.e. stale iff EVERY declared signal exceeds its threshold)
 *
 * The v2.9 single-signal heuristic fallback (when `contract === undefined`)
 * was deleted in v2.11 (Phase 5c, DR-7); see `pruner.dr7-removal.test.ts`
 * for the post-cut surface.
 *
 * State is a numeric snapshot — the caller (handler layer) does the
 * timestamp math; the scorer is pure (no clock, no IO).
 */
import { describe, it, expect } from 'vitest';
import { scoreStaleness } from './score.js';
import type { PhaseContract } from '../workflow/topology/phase-contract.js';

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
        { lastActivityMinutes: 9999 /* branchActivityMinutes absent */ },
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
