/**
 * Live ActionId collection for action-contract closure. The evaluator is
 * covered synthetically elsewhere; this suite pins the collector to the
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

  it('Closure_LiveTree_Closes', () => {
    // The verdict itself, which nothing asked for before. Collection coverage
    // and the corrupted-subject kill fixtures were both green while the live
    // tree reported drift on all 124 actions — the instrument named as this
    // boundary's enforcement had never been pointed at the tree it governs.
    const subjects = collectLiveActionContractSubjects();
    expect(subjects.length).toBe(measureLiveRegisteredActions().counts.actions);
    expect(subjects.length).toBeGreaterThan(0);

    const result = evaluateCollectedActionContractClosure(subjects);

    // Name the findings rather than counting them: a verdict alone tells a
    // reader nothing about which action broke it.
    expect(result.findings.map((f) => `${f.actionId} ${f.code} ${f.dimension ?? ''}`.trim()))
      .toEqual([]);
    expect(result.closed).toBe(true);
    expect(result.subjectCount).toBe(subjects.length);
  });

  it('Closure_LiveTree_SeededProjectionDrift_IsReported', () => {
    // The kill probe for the verdict above. Without it, an evaluator that
    // stopped comparing projections would read exactly like a closed tree.
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
