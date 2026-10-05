/**
 * Pins the pruner as a scorer that requires a typed `PhaseContract`. `score.ts`
 * holds no single-signal fallback for a missing contract, and
 * `scoreEntryThroughTopology` throws for a phase with no contract.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreStaleness } from '../../../src/pruner/score.js';
import { scoreEntryThroughTopology } from '../../../src/pruner/coordinator.js';
import * as scoreModule from '../../../src/pruner/score.js';
import type { PhaseContract, Topology } from '../../../src/workflow/topology/phase-contract.js';

describe('Pruner_PostDR7_NoSingleSignalHeuristic_TypedContractOnly', () => {
  /**
   * Reads the source text, because a check of the exports cannot find an internal
   * fallback branch. `fileURLToPath` is necessary on Windows: `URL.pathname` gives
   * `/D:/…`, and `path.resolve` then doubles the drive letter. The `thresholdMinutes ??`
   * pattern rejects a default threshold, because each threshold comes from the contract.
   */
  it('pruner module source contains no single-signal heuristic markers', () => {
    const scorePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../src/pruner/score.ts',
    );
    const src = fs.readFileSync(scorePath, 'utf-8');

    expect(src).not.toMatch(/DEFAULT_THRESHOLD_MINUTES/);
    expect(src).not.toMatch(/no-contract-no-signal/);
    expect(src.toLowerCase()).not.toMatch(/single-signal/);
    expect(src.toLowerCase()).not.toMatch(/v2\.9 fallback/);
    expect(src).not.toMatch(/thresholdMinutes\s*\?\?/);
  });

  it('module exports no symbol matching the single-signal heuristic name pattern', () => {
    const exportedNames = Object.keys(scoreModule);
    for (const name of exportedNames) {
      expect(name).not.toMatch(/singleSignal/i);
      expect(name).not.toMatch(/heuristic/i);
      expect(name).not.toMatch(/legacyV29/i);
    }
  });

  it('contract-aware scoring is deterministic for an `all`-fresh contract', () => {
    const contract: PhaseContract = {
      expectedMaxDwellMinutes: 60,
      freshnessRequires: 'all',
      signals: [
        { name: 'lastActivity', thresholdMinutes: 60 },
        { name: 'phaseTransition', thresholdMinutes: 60 },
      ],
    };
    const fresh = scoreStaleness(
      { lastActivityMinutes: 10, phaseTransitionMinutes: 10 },
      contract,
    );
    expect(fresh.isStale).toBe(false);

    const oneStale = scoreStaleness(
      { lastActivityMinutes: 10, phaseTransitionMinutes: 9999 },
      contract,
    );
    expect(oneStale.isStale).toBe(true);
  });

  it('contract-aware scoring is deterministic for an `any`-fresh contract', () => {
    const contract: PhaseContract = {
      expectedMaxDwellMinutes: 120,
      freshnessRequires: 'any',
      signals: [
        { name: 'lastActivity', thresholdMinutes: 120 },
        { name: 'branchActivity', thresholdMinutes: 120 },
      ],
    };
    const oneFresh = scoreStaleness(
      { lastActivityMinutes: 9999, branchActivityMinutes: 10 },
      contract,
    );
    expect(oneFresh.isStale).toBe(false);

    const allStale = scoreStaleness(
      { lastActivityMinutes: 9999, branchActivityMinutes: 9999 },
      contract,
    );
    expect(allStale.isStale).toBe(true);
  });

  it('scoreEntryThroughTopology with a complete topology produces deterministic typed verdicts', () => {
    const topology: Topology = Object.freeze({
      phases: Object.freeze({
        design: Object.freeze({
          staleness: Object.freeze({
            expectedMaxDwellMinutes: 60,
            freshnessRequires: 'all' as const,
            signals: Object.freeze([
              Object.freeze({ name: 'lastActivity' as const, thresholdMinutes: 60 }),
            ]),
          }),
        }),
        implement: Object.freeze({
          staleness: Object.freeze({
            expectedMaxDwellMinutes: 240,
            freshnessRequires: 'any' as const,
            signals: Object.freeze([
              Object.freeze({ name: 'lastActivity' as const, thresholdMinutes: 240 }),
              Object.freeze({ name: 'branchActivity' as const, thresholdMinutes: 1440 }),
            ]),
          }),
        }),
      }),
    }) as Topology;

    const designStale = scoreEntryThroughTopology(topology, 'design', {
      lastActivityMinutes: 9999,
    });
    expect(designStale.isStale).toBe(true);
    expect(designStale.signalsEvaluated).toEqual({ lastActivity: true });

    const implementFresh = scoreEntryThroughTopology(topology, 'implement', {
      lastActivityMinutes: 9999,
      branchActivityMinutes: 600,
    });
    expect(implementFresh.isStale).toBe(false);
  });

  /** The loader rejects this shape, so the topology is synthetic. The pruner must throw and must not fall back. */
  it('scoreEntryThroughTopology throws when the requested phase has no contract (v2.11 invariant)', () => {
    const topology: Topology = Object.freeze({
      phases: Object.freeze({
        scaffolding: Object.freeze({}),
      }),
    }) as Topology;

    expect(() =>
      scoreEntryThroughTopology(topology, 'scaffolding', {
        lastActivityMinutes: 100,
      }),
    ).toThrow(/contract|staleness/i);
  });

  it('scoreEntryThroughTopology throws when the requested phase is absent from topology (v2.11 invariant)', () => {
    const topology: Topology = Object.freeze({
      phases: Object.freeze({}),
    }) as Topology;

    expect(() =>
      scoreEntryThroughTopology(topology, 'unknown-phase', {
        lastActivityMinutes: 100,
      }),
    ).toThrow(/contract|staleness|unknown|absent|missing/i);
  });
});
