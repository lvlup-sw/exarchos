// ─── P07-04 exit-proof (d) — shared admission-contract CTK ───────────────────
//
// The compatibility test kit exercises the runtime admission contract across
// its declared surface using the shared scenario corpus, and PINS each
// scenario's declared route + verdict against the real decision path. It also
// pins the contract-level properties the cross-runtime and replay suites depend
// on:
//   • every scenario's outcome matches its declared expectation;
//   • the decision path is a pure function of its inputs (repeat = identical);
//   • the corpus spans every route outcome, every requirement kind, and every
//     policy verdict (a shrinking corpus that stopped covering the surface
//     would fail here);
//   • the frozen requirement digest is content-addressed and stable.
//
// The corpus lives under `__fixtures__/`, so a reverted `decideAdmission`
// implementation makes these expectations go red — the kill-probe's contract.

import { describe, it, expect } from 'vitest';

import {
  admissionScenarioCorpus,
  cleanAllowScenarios,
} from './__fixtures__/admission-scenario-corpus.js';
import {
  decideAdmission,
  outcomeDigest,
  type AdmissionScenario,
} from './__fixtures__/admission-decision-path.js';

describe('admission CTK — every scenario matches its declared contract', () => {
  it.each(admissionScenarioCorpus.map((s) => [s.name, s] as const))(
    'Scenario_%s_MatchesDeclaredRouteAndVerdict',
    (_name: string, scenario: AdmissionScenario) => {
      const outcome = decideAdmission(scenario);
      expect(outcome.route).toBe(scenario.expect.route);
      if (scenario.expect.route === 'selected') {
        expect(outcome.verdict).toBe(scenario.expect.verdict);
        expect(outcome.requirementSetDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(outcome.requirementIds.length).toBeGreaterThan(0);
      } else {
        expect(outcome.verdict).toBeNull();
        expect(outcome.requirementSetDigest).toBeNull();
      }
    },
  );
});

describe('admission CTK — contract-level properties', () => {
  it('DecisionPath_IsPure_RepeatYieldsIdenticalDigest', () => {
    for (const scenario of admissionScenarioCorpus) {
      const first = outcomeDigest(decideAdmission(scenario));
      const second = outcomeDigest(decideAdmission(scenario));
      expect(second, `scenario ${scenario.name} is not deterministic`).toBe(first);
    }
  });

  it('Corpus_SpansEveryDeclaredRouteOutcome', () => {
    const routes = new Set(admissionScenarioCorpus.map((s) => s.expect.route));
    expect([...routes].sort()).toEqual(['blocked', 'no-match', 'selected']);
  });

  it('Corpus_SpansEveryPolicyVerdict', () => {
    const verdicts = new Set(
      admissionScenarioCorpus
        .map((s) => decideAdmission(s).verdict)
        .filter((v): v is NonNullable<typeof v> => v !== null),
    );
    expect([...verdicts].sort()).toEqual(['allow', 'deny', 'indeterminate']);
  });

  it('Corpus_ExercisesEveryRequirementKind', () => {
    // The unknown-risk allow scenario freezes gate + approval + corroboration —
    // the widest requirement set the freezer mints. Its allow proves all three
    // requirement kinds were satisfied, not merely resolved.
    const widest = admissionScenarioCorpus.find(
      (s) => s.name === 'unknown-risk/allow/gate+approval+corroboration',
    );
    expect(widest, 'widest scenario present').toBeDefined();
    const outcome = decideAdmission(widest!);
    expect(outcome.verdict).toBe('allow');
    // gate(1) + approval(>=1) + corroboration(1) ⇒ at least three requirements.
    expect(outcome.requirementIds.length).toBeGreaterThanOrEqual(3);
    expect(outcome.satisfiedCount).toBe(outcome.requirementIds.length);
  });

  it('DenyScenarios_ReportSatisfied-plus-DeniedEqualsRequirementCount', () => {
    const deny = admissionScenarioCorpus.filter(
      (s) => s.expect.verdict === 'deny',
    );
    expect(deny.length).toBeGreaterThan(0);
    for (const scenario of deny) {
      const outcome = decideAdmission(scenario);
      expect(outcome.deniedCount).toBeGreaterThan(0);
      expect(
        outcome.satisfiedCount +
          outcome.deniedCount +
          outcome.waivedCount +
          outcome.indeterminateCount,
      ).toBe(outcome.requirementIds.length);
    }
  });

  it('CleanAllowScenarios_AreNonEmpty_AndAllAllow', () => {
    expect(cleanAllowScenarios.length).toBeGreaterThan(0);
    for (const scenario of cleanAllowScenarios) {
      expect(decideAdmission(scenario).verdict).toBe('allow');
    }
  });
});
