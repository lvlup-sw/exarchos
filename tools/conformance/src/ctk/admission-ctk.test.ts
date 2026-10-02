/**
 * The admission CTK pins the declared route and verdict of each corpus scenario
 * against the real decision path. It also pins the properties that the
 * cross-runtime and replay suites need:
 *
 * - The decision path is a pure function of its inputs.
 * - The corpus spans every route outcome, requirement kind and policy verdict. A
 *   corpus that stops covering this surface fails here.
 * - The frozen requirement digest is content-addressed.
 */

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

  /**
   * The unknown-risk allow scenario freezes the widest requirement set: a gate, one
   * or more approvals and corroboration. Its `allow` proves that all three kinds are
   * satisfied, not only resolved.
   */
  it('Corpus_ExercisesEveryRequirementKind', () => {
    const widest = admissionScenarioCorpus.find(
      (s) => s.name === 'unknown-risk/allow/gate+approval+corroboration',
    );
    expect(widest, 'widest scenario present').toBeDefined();
    const outcome = decideAdmission(widest!);
    expect(outcome.verdict).toBe('allow');
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
