/**
 * T46 — `scoreStaleness(state, contract)` pure-function tests.
 *
 * Verifies two branches:
 *
 *   1. With contract: scorer reduces over declared signals according to
 *      the contract's `freshnessRequires` semantics:
 *        - 'all' → fresh iff every declared signal is fresh
 *                  (i.e. stale iff ANY signal exceeds its threshold)
 *        - 'any' → fresh iff at least one declared signal is fresh
 *                  (i.e. stale iff EVERY declared signal exceeds its threshold)
 *
 *   2. Without contract (`undefined`): falls back to the v2.9 single-signal
 *      heuristic — stale iff `lastActivityMinutes > thresholdMinutes`.
 *      Behavior must match `selectPruneCandidates`'s legacy path
 *      (`hasSecondarySignal === false → isStale = lastActivityStale`).
 *
 * State is a numeric snapshot — the caller (handler layer) does the
 * timestamp math; the scorer is pure (no clock, no IO).
 */
import { describe, it, expect } from 'vitest';
import { scoreStaleness, type StalenessState } from './score.js';
import type { PhaseContract } from '../topology/phase-contract.js';

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
});

describe('scoreStaleness_without_contract_falls_back_to_v2_9_single_signal', () => {
  // The v2.9 heuristic (from selectPruneCandidates, legacy path):
  //   hasSecondarySignal === false → isStale = lastActivityStale
  //   lastActivityStale = minutesSince(lastActivityTimestamp, now) > thresholdMinutes
  //
  // The scorer reproduces that EXACTLY when `contract === undefined`. It
  // ignores any secondary signals on `state` because the legacy path
  // does (those signals are only consulted when at least one is "wired").

  it('lastActivity at threshold → not stale (strict > comparison, matching v2.9)', () => {
    const result = scoreStaleness(
      { lastActivityMinutes: 60, thresholdMinutes: 60 },
      undefined,
    );
    expect(result.isStale).toBe(false);
  });

  it('lastActivity above threshold → stale', () => {
    const result = scoreStaleness(
      { lastActivityMinutes: 61, thresholdMinutes: 60 },
      undefined,
    );
    expect(result.isStale).toBe(true);
  });

  it('lastActivity below threshold → not stale', () => {
    const result = scoreStaleness(
      { lastActivityMinutes: 10, thresholdMinutes: 60 },
      undefined,
    );
    expect(result.isStale).toBe(false);
  });

  it('default threshold (20160 = 14 days) when caller omits it', () => {
    const fresh: StalenessState = { lastActivityMinutes: 1000 };
    expect(scoreStaleness(fresh, undefined).isStale).toBe(false);

    const stale: StalenessState = { lastActivityMinutes: 99_999 };
    expect(scoreStaleness(stale, undefined).isStale).toBe(true);
  });
});
