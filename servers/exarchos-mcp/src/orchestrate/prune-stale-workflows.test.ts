import { describe, it, expect } from 'vitest';
import {
  selectPruneCandidates,
  type WorkflowListEntry,
} from './prune-stale-workflows.js';

/**
 * Build a minimal WorkflowListEntry fixture.
 * Staleness is computed from `_checkpoint.lastActivityTimestamp` vs an
 * injectable `now` in the tests, so fixtures only need to set the timestamp.
 */
function makeEntry(overrides: {
  featureId: string;
  workflowType?: string;
  phase?: string;
  lastActivityTimestamp: string;
}): WorkflowListEntry {
  return {
    featureId: overrides.featureId,
    workflowType: overrides.workflowType ?? 'feature',
    phase: overrides.phase ?? 'implementing',
    stateFile: `/tmp/${overrides.featureId}.state.json`,
    _checkpoint: {
      lastActivityTimestamp: overrides.lastActivityTimestamp,
    },
  };
}

// A fixed "now" for deterministic tests.
const NOW = new Date('2026-04-11T12:00:00.000Z');

// Helper: minutes-before-now as ISO string
function minutesAgo(mins: number): string {
  return new Date(NOW.getTime() - mins * 60 * 1000).toISOString();
}

describe('selectPruneCandidates', () => {
  it('excludes terminal phases (completed, cancelled)', () => {
    // Very stale so they'd otherwise qualify (> 10080 min default threshold)
    const stale = minutesAgo(20_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'a', phase: 'completed', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'b', phase: 'cancelled', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'c', phase: 'implementing', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, {}, NOW);

    expect(candidates.map((c) => c.featureId).sort()).toEqual(['c']);
    const terminalExclusions = excluded.filter((e) => e.reason === 'terminal');
    expect(terminalExclusions.map((e) => e.featureId).sort()).toEqual(['a', 'b']);
  });

  it('excludes fresh workflows (within default threshold)', () => {
    // Default threshold is 10080 minutes (7 days)
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'fresh', lastActivityTimestamp: minutesAgo(60) }), // 1h
      makeEntry({ featureId: 'stale', lastActivityTimestamp: minutesAgo(20_000) }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['stale']);
    const freshExclusions = excluded.filter((e) => e.reason === 'fresh');
    expect(freshExclusions.map((e) => e.featureId)).toEqual(['fresh']);
  });

  it('includes stale non-terminal entries', () => {
    const entries: WorkflowListEntry[] = [
      makeEntry({
        featureId: 'a',
        phase: 'implementing',
        lastActivityTimestamp: minutesAgo(20_000),
      }),
      makeEntry({
        featureId: 'b',
        phase: 'plan',
        lastActivityTimestamp: minutesAgo(20_000),
      }),
    ];

    const { candidates } = selectPruneCandidates(entries, {}, NOW);

    expect(candidates.map((c) => c.featureId).sort()).toEqual(['a', 'b']);
    for (const candidate of candidates) {
      expect(candidate.stalenessMinutes).toBeGreaterThan(0);
      expect(candidate.workflowType).toBe('feature');
    }
  });

  it('respects a custom threshold (60 min)', () => {
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'a', lastActivityTimestamp: minutesAgo(30) }), // fresh vs 60
      makeEntry({ featureId: 'b', lastActivityTimestamp: minutesAgo(120) }), // stale vs 60
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      { thresholdMinutes: 60 },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['b']);
    expect(excluded.map((e) => e.featureId)).toEqual(['a']);
    expect(excluded[0]?.reason).toBe('fresh');
  });

  it('excludes oneshot workflows when includeOneShot is false', () => {
    const stale = minutesAgo(20_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'os1', workflowType: 'oneshot', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'f1', workflowType: 'feature', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      { includeOneShot: false },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['f1']);
    const oneshotExclusions = excluded.filter((e) => e.reason === 'oneshot-excluded');
    expect(oneshotExclusions.map((e) => e.featureId)).toEqual(['os1']);
  });

  it('includes oneshot workflows by default (includeOneShot defaults to true)', () => {
    const stale = minutesAgo(20_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'os1', workflowType: 'oneshot', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'f1', workflowType: 'feature', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, {}, NOW);

    expect(candidates.map((c) => c.featureId).sort()).toEqual(['f1', 'os1']);
    expect(excluded.filter((e) => e.reason === 'oneshot-excluded')).toEqual([]);
  });
});
