// ─── Corpus baseline attestation — the `expected` verdicts are DERIVED, not typed ─
//
// The transition-admission corpus records, per fixture, what the LEGACY guard
// path decides (`fixture.expected.verdict`). Until now those verdicts were
// hand-authored via `allow()` / `deny()` helpers and never once compared against
// the guards they claim to describe. Every downstream soundness claim —
// "admission agrees with legacy except for N known defects", "every surviving
// disagreement is in the SAFE direction", and the cutover gate's
// `deterministic-corpus-clean` condition — is computed against those strings.
// A single mis-transcribed verdict silently converts a REAL over-admission into
// a recorded "agreement", so the safety property would be asserted over a
// baseline that cannot falsify it.
//
// This test closes that hole: it drives every fixture's `state` through the REAL
// legacy authority (`executeTransition` over the real `getHSMDefinition` HSM,
// which evaluates the real `guards.ts` closures) and asserts the recorded
// verdict matches. The corpus is thereby MACHINE-DERIVED: it can no longer drift
// from the guards without this test going red.
//
// Note on module boundaries: this is a TEST. It deliberately imports the legacy
// guard path, which is exactly what makes it an independent cross-check. The
// production shared-IR modules (`built-in-workflow-ir.ts`,
// `legacy-state-translation.ts`) remain structurally guard-free — that property
// is proved separately by `built-in-workflow-ir.structure.test.ts`, which walks
// the import graph from those two roots only.

import { describe, expect, it } from 'vitest';

import {
  transitionAdmissionCorpus,
  type LegacyTransitionFixture,
} from '../__fixtures__/transition-admission-corpus.js';
import { executeTransition, getHSMDefinition } from '../state-machine.js';

type LegacyVerdict = 'allow' | 'deny';

/**
 * The authoritative legacy decision for a fixture: the real HSM executing the
 * real guard for `from → to` against the fixture's own state. `success` is the
 * whole decision — a guard failure, an invalid transition and a fail-closed
 * phase block are all `deny`.
 */
function legacyVerdict(fixture: LegacyTransitionFixture): {
  readonly verdict: LegacyVerdict;
  readonly detail: string;
} {
  const hsm = getHSMDefinition(fixture.workflowType);
  const state: Record<string, unknown> = {
    ...(fixture.state as Record<string, unknown>),
    phase: fixture.from,
  };
  const result = executeTransition(hsm, state, fixture.to);
  return {
    verdict: result.success ? 'allow' : 'deny',
    detail: result.success
      ? `allowed → ${String(result.newPhase)}`
      : `${result.errorCode ?? 'DENIED'}: ${result.errorMessage ?? ''}`,
  };
}

describe('corpus baseline is machine-derived from the real legacy guards', () => {
  it('every fixture resolves to a real HSM transition (harness is not vacuous)', () => {
    // Guards against a harness that silently "passes" because every fixture
    // took an INVALID_TRANSITION path rather than actually reaching a guard.
    let reachedAGuard = 0;
    for (const fixture of transitionAdmissionCorpus) {
      const { detail } = legacyVerdict(fixture);
      expect(detail, fixture.id).not.toContain('No transition from');
      if (detail.startsWith('GUARD_FAILED') || detail.startsWith('allowed')) {
        reachedAGuard += 1;
      }
    }
    expect(reachedAGuard).toBe(transitionAdmissionCorpus.length);
  });

  it('the harness observes BOTH verdicts (it can produce a deny)', () => {
    // A baseline harness that can only ever emit `allow` would make the
    // per-fixture assertion below unfalsifiable for every deny fixture.
    const verdicts = new Set(
      transitionAdmissionCorpus.map((f) => legacyVerdict(f).verdict),
    );
    expect(verdicts).toEqual(new Set(['allow', 'deny']));
  });

  it.each(transitionAdmissionCorpus.map((f) => [f.id, f] as const))(
    'recorded verdict matches the real guard path: %s',
    (_id, fixture) => {
      const { verdict, detail } = legacyVerdict(fixture);
      expect(
        verdict,
        `${fixture.id} (${fixture.workflowType}:${fixture.from}→${fixture.to}) ` +
          `recorded '${fixture.expected.verdict}' but the real legacy path said ` +
          `'${verdict}' — ${detail}`,
      ).toBe(fixture.expected.verdict);
    },
  );
});
