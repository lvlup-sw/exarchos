/**
 * Runs action-contract closure against the live registry. Other suites cover
 * the evaluator with synthetic subjects. This suite pins the collector to the
 * registered-actions denominator.
 */
import { describe, expect, it } from 'vitest';
import {
  actionContractRequiresIsNone,
  classifyActionContractExecute,
  collectLiveActionContractSubjects,
  collectedSubjectsCoverLiveDenominator,
  evaluateActionContractClosure,
  evaluateCollectedActionContractClosure,
  liveActionContractSubject,
  liveRegisteredActionIds,
} from '../../src/contract/action-contract-closure.js';
import {
  measureLiveRegisteredActions,
  readRegisteredActionsSnapshot,
  snapshotMatchesLiveRegistry,
} from '../../src/contract/registered-actions-denominator.js';

describe('action-contract closure live tree', () => {
  it('Closure_LiveTree_MatchesRegisteredSnapshot', () => {
    const subjects = collectLiveActionContractSubjects();
    const live = measureLiveRegisteredActions();
    const recorded = readRegisteredActionsSnapshot();
    const collectedIds = subjects.map((subject) => subject.actionId).sort((left, right) => left.localeCompare(right));
    const liveIds = [...liveRegisteredActionIds(live)];
    const snapshotIds = recorded.tools
      .flatMap((tool) => tool.actions.map((action) => `${tool.name}.${action}`))
      .sort((left, right) => left.localeCompare(right));

    expect(snapshotMatchesLiveRegistry(recorded, live)).toBe(true);
    expect(collectedSubjectsCoverLiveDenominator(subjects)).toBe(true);
    expect(subjects.length).toBe(live.counts.actions);
    expect(subjects.length).toBe(recorded.counts.actions);
    expect(collectedIds).toEqual(liveIds);
    expect(collectedIds).toEqual(snapshotIds);
    expect(live.counts).toEqual(recorded.counts);
    expect(new Set(collectedIds).size).toBe(subjects.length);
  });

  /**
   * Asks for the verdict on the live tree. Collection coverage and the kill
   * fixtures can both pass while the live tree reports drift. The assertion
   * names each finding, because a verdict alone does not name the action.
   */
  it('Closure_LiveTree_Closes', () => {
    const subjects = collectLiveActionContractSubjects();
    expect(subjects.length).toBe(measureLiveRegisteredActions().counts.actions);
    expect(subjects.length).toBeGreaterThan(0);

    const result = evaluateCollectedActionContractClosure(subjects);

    expect(result.findings.map((f) => `${f.actionId} ${f.code} ${f.dimension ?? ''}`.trim()))
      .toEqual([]);
    expect(result.closed).toBe(true);
    expect(result.subjectCount).toBe(subjects.length);
  });

  /**
   * Kill probe for the closed verdict. An evaluator that does not compare
   * projections also reports a closed tree, and only this seeded drift shows it.
   */
  it('Closure_LiveTree_SeededProjectionDrift_IsReported', () => {
    const subjects = collectLiveActionContractSubjects();
    const [first] = subjects;
    expect(first, 'the live tree names at least one subject').toBeDefined();

    const drifted = evaluateActionContractClosure({
      subjects: [
        ...subjects.slice(1),
        {
          ...first!,
          projections: [
            ...(first!.projections ?? []),
            { name: 'seeded', contract: { requires: { kind: 'none', because: 'not the declaration' } } },
          ],
        },
      ],
    });

    expect(drifted.closed).toBe(false);
    expect(
      drifted.findings.some(
        (f) => f.code === 'PROJECTION_DRIFT' && f.actionId === first!.actionId,
      ),
    ).toBe(true);
  });

  it('Closure_ExecuteClassifier_SeparatesHsmFromAdmission', () => {
    expect(classifyActionContractExecute({ success: true })).toBe('admitted');
    expect(
      classifyActionContractExecute({ success: false, errorCode: 'ADMISSION_DENIED' }),
    ).toBe('admission-denied');
    expect(
      classifyActionContractExecute({ success: false, errorCode: 'ENSURE_CONTRACT_VIOLATED' }),
    ).toBe('ensure-violated');
    expect(
      classifyActionContractExecute({ success: false, errorCode: 'GUARD_FAILED' }),
    ).toBe('hsm-deny');
    expect(
      classifyActionContractExecute({ success: false, errorCode: 'INVALID_TRANSITION' }),
    ).toBe('hsm-deny');

    const transition = liveActionContractSubject('exarchos_workflow.transition');
    expect(transition, 'live tree names workflow.transition').toBeDefined();
    expect(actionContractRequiresIsNone(transition?.contract)).toBe(true);
  });
});
