/**
 * Live ActionId collection for action-contract closure. The evaluator is
 * covered synthetically elsewhere; this suite pins the collector to the
 * registered-actions denominator.
 */
import { describe, expect, it } from 'vitest';
import {
  collectLiveActionContractSubjects,
  collectedSubjectsCoverLiveDenominator,
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
});
