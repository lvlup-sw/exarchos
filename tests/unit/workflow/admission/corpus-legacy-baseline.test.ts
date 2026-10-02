// The transition-admission corpus records the legacy verdict of each fixture in
// `fixture.expected.verdict`. The admission agreement checks and the cutover
// gate condition `deterministic-corpus-clean` compare against these verdicts.
// One wrong verdict turns a real over-admission into a recorded agreement. This
// test runs each fixture state through `executeTransition` on the real
// `getHSMDefinition` HSM, which evaluates the real `guards.ts` closures. The
// recorded verdict must match.
//
// This test imports the legacy guard path on purpose, as an independent check.
// `built-in-workflow-ir.structure.test.ts` proves that the shared-IR modules do
// not import guard code.

import { describe, expect, it } from 'vitest';

import {
  transitionAdmissionCorpus,
  type LegacyTransitionFixture,
} from '../__fixtures__/transition-admission-corpus.js';
import { executeTransition, getHSMDefinition } from '../../../../src/workflow/state-machine.js';

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
  /** Every fixture must reach a guard, so the harness cannot pass because each fixture took an invalid transition. */
  it('every fixture resolves to a real HSM transition (harness is not vacuous)', () => {
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

  /** A harness that only gives `allow` makes the per-fixture check unfalsifiable for each deny fixture. */
  it('the harness observes BOTH verdicts (it can produce a deny)', () => {
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
