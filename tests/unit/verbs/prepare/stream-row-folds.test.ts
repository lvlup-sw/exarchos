/**
 * Tests for three pure folds over the rows of a stream. One reads the tasks that later design
 * revisions name. One reads the latest prepared record of a capsule version. One reads the gate
 * evidence records.
 *
 * Each fold takes plain rows, so each case writes its rows by hand and appends nothing to a store.
 * The rows are of mixed types, in commit order. Each valid row passes the schema of its type.
 *
 * @oracle-sources: ../../../../src/verbs/prepare/design-version.ts, the maps and records worked out by hand in each case
 */

import { describe, expect, it } from 'vitest';

import {
  AdmissionEvidenceRecordedData,
  DesignRevisedData,
  WorkflowPreparedData,
  type AdmissionEvidenceRecorded,
  type DesignRevised,
  type WorkflowPrepared,
} from '../../../../src/events/schemas.js';
import { gateEvidenceRecordsOf } from '../../../../src/verbs/gates/durable-gate-producer.js';
import { revisedTasksAfter } from '../../../../src/verbs/prepare/design-version.js';
import { preparedRecordOf } from '../../../../src/verbs/prepare/prepared-record.js';

interface Row {
  readonly type: string;
  readonly sequence: number;
  readonly data: unknown;
}

const WORKFLOW = 'feat-stream-row-folds';
const DIGEST = { algorithm: 'sha256', value: 'a'.repeat(64) };
const BUNDLE_REF = { artifactId: `run-bundle:settlement:${WORKFLOW}:1`, digest: DIGEST };

/** One row of a type that none of the folds reads. */
function otherRow(sequence: number): Row {
  return { type: 'task.completed', sequence, data: { taskId: 'task-a', verified: false } };
}

/** The data of a revision row that moves the design to `nextDesignVersion`. */
function revisionData(batchId: string, nextDesignVersion: number, affectedTasks: readonly string[]): DesignRevised {
  return DesignRevisedData.parse({
    operationId: `settle:${batchId}`,
    workflowId: WORKFLOW,
    capsuleVersion: 1,
    batchId,
    priorDesignVersion: nextDesignVersion - 1,
    nextDesignVersion,
    deviationIds: [`deviation-${batchId}`],
    affectedTasks: [...affectedTasks],
    bundleRefs: [BUNDLE_REF],
  });
}

/** The data of a prepared record of one capsule version, told apart by its capsule digest. */
function preparedData(capsuleVersion: number, capsuleDigest: string): WorkflowPrepared {
  return WorkflowPreparedData.parse({
    operationId: `prepare:${capsuleDigest}`,
    workflowId: WORKFLOW,
    workflowType: 'feature',
    capsuleVersion,
    definitionVersion: 'definition-1',
    designVersion: 'design-v1',
    capsuleDigest,
    compilerVersion: 'compiler-1',
    taskCount: 2,
    requestDigest: `request:${capsuleDigest}`,
    bundleRefs: [BUNDLE_REF],
  });
}

/** The fields that each evidence fixture shares. */
const EVIDENCE_BASE = {
  contractVersion: '1.0',
  requirementId: 'verification-ladder:static-analysis',
  phaseAttemptId: 'phase-attempt-001',
  subject: { kind: 'task', taskId: 'task-a', digest: DIGEST },
  producer: {
    producerId: 'producer.gate-runner',
    providerRef: 'provider.static-analysis',
    providerVersion: '1.0.0',
    invocationId: 'invocation-001',
  },
  policyId: 'policy-001',
  policyDigest: DIGEST,
  contentDigest: DIGEST,
};

/** The data of one evidence row. `evidence` holds the fields that differ from the base. */
function evidenceData(evidence: Record<string, unknown>): AdmissionEvidenceRecorded {
  return AdmissionEvidenceRecordedData.parse({ eventVersion: '1.0', evidence: { ...EVIDENCE_BASE, ...evidence } });
}

describe('the pure folds over the rows of a stream', () => {
  /**
   * The row at the sequence itself names a third task, and it does not count. A row of another
   * type that carries revision data does not count either.
   */
  it('RevisedTasksAfter_TakesTheLatestVersionOfEachTaskAfterTheSequence', () => {
    const rows: readonly Row[] = [
      { type: 'design.revised', sequence: 1, data: revisionData('batch-early', 2, ['task-a', 'task-c']) },
      otherRow(2),
      { type: 'design.revised', sequence: 3, data: revisionData('batch-at', 3, ['task-c']) },
      { type: 'design.revised', sequence: 4, data: revisionData('batch-first', 4, ['task-a', 'task-b']) },
      otherRow(5),
      { type: 'design.revised', sequence: 6, data: revisionData('batch-second', 5, ['task-a']) },
      { type: 'capsule.recompiled', sequence: 7, data: revisionData('batch-wrong-type', 9, ['task-d']) },
    ];

    const revised = revisedTasksAfter(rows, 3);

    expect([...revised]).toEqual([
      ['task-a', 5],
      ['task-b', 4],
    ]);
  });

  /** The damaged row is a valid revision row with its next version removed. */
  it('RevisedTasksAfter_ARefusedRowThrows', () => {
    const { nextDesignVersion, ...withoutVersion } = revisionData('batch-damaged', 2, ['task-a']);
    expect(nextDesignVersion).toBe(2);
    const rows: readonly Row[] = [otherRow(1), { type: 'design.revised', sequence: 2, data: withoutVersion }];

    expect(() => revisedTasksAfter(rows, 1)).toThrow(/nextDesignVersion/);
  });

  /**
   * The fold does not read a damaged row at or before the sequence, as the reader query with
   * `sinceSequence` does not return it. It does not read a row of another type.
   */
  it('RevisedTasksAfter_ARefusedRowAtOrBeforeTheSequenceOrOfAnotherType_IsNotRead', () => {
    const rows: readonly Row[] = [
      { type: 'design.revised', sequence: 1, data: { batchId: 'batch-damaged' } },
      { type: 'design.revised', sequence: 2, data: { batchId: 'batch-damaged' } },
      { type: 'deviation.decided', sequence: 3, data: { batchId: 'batch-damaged' } },
    ];

    expect(revisedTasksAfter(rows, 2).size).toBe(0);
  });

  /**
   * A record of another version, a record that the schema refuses, and a row of another type that
   * carries a valid record are all ignored.
   */
  it('PreparedRecordOf_TwoRecordsOfOneVersion_GivesTheLatest', () => {
    const { taskCount, ...withoutTaskCount } = preparedData(2, 'digest-refused');
    expect(taskCount).toBe(2);
    const rows: readonly Row[] = [
      { type: 'workflow.prepared', sequence: 1, data: preparedData(2, 'digest-first') },
      otherRow(2),
      { type: 'workflow.prepared', sequence: 3, data: preparedData(3, 'digest-other-version') },
      { type: 'workflow.prepared', sequence: 4, data: preparedData(2, 'digest-second') },
      { type: 'workflow.prepared', sequence: 5, data: withoutTaskCount },
      { type: 'capsule.recompiled', sequence: 6, data: preparedData(2, 'digest-wrong-type') },
    ];

    expect(preparedRecordOf(rows, 2)).toEqual({
      record: {
        operationId: 'prepare:digest-second',
        workflowId: 'feat-stream-row-folds',
        workflowType: 'feature',
        capsuleVersion: 2,
        definitionVersion: 'definition-1',
        designVersion: 'design-v1',
        capsuleDigest: 'digest-second',
        compilerVersion: 'compiler-1',
        taskCount: 2,
        requestDigest: 'request:digest-second',
        bundleRefs: [
          {
            artifactId: 'run-bundle:settlement:feat-stream-row-folds:1',
            digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
          },
        ],
      },
      sequence: 4,
    });
    expect(preparedRecordOf(rows, 3)?.sequence).toBe(3);
    expect(preparedRecordOf(rows, 4)).toBeUndefined();
  });

  /**
   * The second row of one evidence id replaces the first, and the id keeps its first place.
   * An approval record, a record that the schema refuses, and a row of another type are not in the map.
   */
  it('GateEvidenceRecordsOf_SeededRows_GiveTheExpectedRecords', () => {
    const rows: readonly Row[] = [
      {
        type: 'admission.evidence-recorded',
        sequence: 1,
        data: evidenceData({ evidenceId: 'evidence-a', kind: 'gate', verdict: 'fail', createdAt: '2026-10-22T10:00:00.000Z' }),
      },
      {
        type: 'admission.evidence-recorded',
        sequence: 2,
        data: evidenceData({
          evidenceId: 'evidence-approval',
          kind: 'approval',
          verdict: 'approved',
          attributedTo: { principalKind: 'operator', principalId: 'principal-001', role: 'reviewer' },
          createdAt: '2026-10-22T10:01:00.000Z',
        }),
      },
      {
        type: 'admission.evidence-recorded',
        sequence: 3,
        data: evidenceData({ evidenceId: 'evidence-b', kind: 'gate', verdict: 'pass', createdAt: '2026-10-22T10:02:00.000Z' }),
      },
      {
        type: 'admission.evidence-recorded',
        sequence: 4,
        data: {
          eventVersion: '1.0',
          evidence: { ...EVIDENCE_BASE, contractVersion: '2.0', evidenceId: 'evidence-refused', kind: 'gate', verdict: 'pass', createdAt: '2026-10-22T10:03:00.000Z' },
        },
      },
      otherRow(5),
      {
        type: 'admission.evidence-recorded',
        sequence: 6,
        data: evidenceData({ evidenceId: 'evidence-a', kind: 'gate', verdict: 'pass', createdAt: '2026-10-22T10:04:00.000Z' }),
      },
      {
        type: 'gate.executed',
        sequence: 7,
        data: evidenceData({ evidenceId: 'evidence-wrong-type', kind: 'gate', verdict: 'pass', createdAt: '2026-10-22T10:05:00.000Z' }),
      },
    ];

    const records = gateEvidenceRecordsOf(rows);

    expect([...records.keys()]).toEqual(['evidence-a', 'evidence-b']);
    expect(records.get('evidence-a')).toEqual({
      eventVersion: '1.0',
      evidence: {
        contractVersion: '1.0',
        evidenceId: 'evidence-a',
        requirementId: 'verification-ladder:static-analysis',
        phaseAttemptId: 'phase-attempt-001',
        subject: { kind: 'task', taskId: 'task-a', digest: { algorithm: 'sha256', value: 'a'.repeat(64) } },
        producer: {
          producerId: 'producer.gate-runner',
          providerRef: 'provider.static-analysis',
          providerVersion: '1.0.0',
          invocationId: 'invocation-001',
        },
        policyId: 'policy-001',
        policyDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
        contentDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
        createdAt: '2026-10-22T10:04:00.000Z',
        kind: 'gate',
        verdict: 'pass',
      },
    });
    expect(records.get('evidence-b')).toEqual({
      eventVersion: '1.0',
      evidence: {
        contractVersion: '1.0',
        evidenceId: 'evidence-b',
        requirementId: 'verification-ladder:static-analysis',
        phaseAttemptId: 'phase-attempt-001',
        subject: { kind: 'task', taskId: 'task-a', digest: { algorithm: 'sha256', value: 'a'.repeat(64) } },
        producer: {
          producerId: 'producer.gate-runner',
          providerRef: 'provider.static-analysis',
          providerVersion: '1.0.0',
          invocationId: 'invocation-001',
        },
        policyId: 'policy-001',
        policyDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
        contentDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
        createdAt: '2026-10-22T10:02:00.000Z',
        kind: 'gate',
        verdict: 'pass',
      },
    });
  });
});
