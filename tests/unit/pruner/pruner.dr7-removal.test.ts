/**
 * T5c.2 (DR-7 hard-cut, v2.11) — pruner becomes a pure typed-contract scorer.
 *
 * v2.10 had two scoring branches in `pruner/score.ts`:
 *   1. Contract-aware path (typed `PhaseContract`).
 *   2. v2.9 single-signal heuristic fallback (when `contract === undefined`):
 *      stale iff `lastActivityMinutes > thresholdMinutes`, plus a fail-closed
 *      sub-branch for "no contract AND no signal".
 *
 * v2.11 (DR-7) deletes branch (2). Because the topology loader (T5c.1)
 * now THROWS on any phase missing a `staleness` block, downstream pruner
 * callers can rely on every phase having a contract. The pruner's public
 * API tightens accordingly: `scoreStaleness` and the topology-aware
 * `scoreEntryThroughTopology` now REQUIRE a typed `PhaseContract`.
 *
 * This test file pins the post-v2.11 surface:
 *   - `score.ts` contains no single-signal heuristic code path
 *     (no `?? DEFAULT_THRESHOLD_MINUTES`, no `no-contract-no-signal`
 *     diagnostic, no `lastActivityMinutes > thresholdMinutes` fallback).
 *   - The contract-aware path produces deterministic verdicts on a
 *     complete-topology fixture.
 *   - Calling `scoreEntryThroughTopology` for a phase whose entry is
 *     missing a contract is a programmer error and surfaces explicitly
 *     (no silent fallback). The loader's hard-throw should prevent this
 *     state in production, but the unit-test surface is the contract
 *     boundary that detects the regression if introduced.
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
  it('pruner module source contains no single-signal heuristic markers', () => {
    // The module source is the canonical artifact we're asserting on.
    // After v2.11, the literal markers from the v2.10 fallback path
    // must be gone. We assert on raw source rather than runtime
    // exports because the heuristic was an internal branch (no
    // exported symbol), so a "no longer exported" check would not
    // detect a still-present branch.
    const scorePath = path.resolve(
      // Test file lives at src/pruner/.
      // score.ts is in the same directory.
      // fileURLToPath (not URL.pathname) so the Windows drive letter resolves
      // correctly — `.pathname` yields `/D:/…`, which path.resolve doubles to
      // `D:\D:\…` (#1620).
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../src/pruner/score.ts',
    );
    const src = fs.readFileSync(scorePath, 'utf-8');

    // v2.9 heuristic constants and diagnostic reasons are gone.
    expect(src).not.toMatch(/DEFAULT_THRESHOLD_MINUTES/);
    expect(src).not.toMatch(/no-contract-no-signal/);
    // The "fall back to v2.9 single-signal" comment block is gone.
    expect(src.toLowerCase()).not.toMatch(/single-signal/);
    expect(src.toLowerCase()).not.toMatch(/v2\.9 fallback/);
    // `thresholdMinutes` (the fallback-only field on StalenessState) is
    // no longer referenced in score.ts: with no fallback path, there
    // is no caller-supplied default-threshold semantic.
    expect(src).not.toMatch(/thresholdMinutes\s*\?\?/);
  });

  it('module exports no symbol matching the single-signal heuristic name pattern', () => {
    const exportedNames = Object.keys(scoreModule);
    for (const name of exportedNames) {
      // Accept any export that doesn't carry single-signal terminology.
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

  it('scoreEntryThroughTopology throws when the requested phase has no contract (v2.11 invariant)', () => {
    // Under v2.11 the loader prevents a topology object reaching the
    // pruner with any phase missing a contract. If a caller constructs
    // such a topology synthetically (test, internal seam), the pruner
    // surfaces the missing-contract case loudly rather than silently
    // falling back. This is the structural replacement for the v2.10
    // single-signal fallback.
    const topology: Topology = Object.freeze({
      phases: Object.freeze({
        // Synthetic — production-loaded topologies cannot reach this
        // shape because the loader throws first.
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
