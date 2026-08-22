import { describe, expect, it } from 'vitest';
import { observeActionPostconditions } from '../../src/dispatch/core/action-postconditions.js';
import { replayedEvidence } from '../../src/dispatch/core/effect-carrier.js';
import { declared } from '../../src/registry/action-contract.js';
import { ADMISSION_EVENT_TYPES } from '../../src/workflow/admission/types.js';

const STREAM = 'feature-postconditions';
const OPERATION = 'operation.postconditions-1';
const DIGEST = { algorithm: 'sha256' as const, value: 'a'.repeat(64) };

interface StoreRow {
  readonly type: string;
  readonly operationId?: string;
  readonly data?: unknown;
}

function memorySource(rows: readonly StoreRow[]) {
  return {
    async query(
      _streamId: string,
      filters?: { type?: string; operationId?: string },
    ): Promise<readonly StoreRow[]> {
      return rows.filter((row) => {
        if (filters?.type !== undefined && row.type !== filters.type) return false;
        if (filters?.operationId !== undefined && row.operationId !== filters.operationId) {
          return false;
        }
        return true;
      });
    },
  };
}

function persistedGateEvidence(operationId: string): StoreRow {
  return {
    type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
    operationId,
    data: {
      eventVersion: '1.0',
      evidence: {
        contractVersion: '1.0',
        evidenceId: 'evidence.gate-1',
        requirementId: 'requirement.typecheck',
        phaseAttemptId: 'phase-attempt.1',
        subject: { kind: 'task', taskId: 'task.1', digest: DIGEST },
        producer: {
          producerId: 'producer.gate-runner',
          providerRef: 'provider.static-analysis',
          providerVersion: '1.3.0',
          invocationId: 'invocation.gate-1',
        },
        policyId: 'policy.transition',
        policyDigest: DIGEST,
        contentDigest: DIGEST,
        createdAt: '2026-08-22T00:00:00.000Z',
        kind: 'gate',
        verdict: 'pass',
      },
    },
  };
}

describe('durable action postcondition observation', () => {
  it('Postconditions_CommittedEvent_IsSatisfied', async () => {
    const store = memorySource([
      { type: 'workflow.started', operationId: OPERATION },
    ]);

    const observation = await observeActionPostconditions({
      ensures: declared({
        source: 'event-append',
        when: 'success',
        event: 'workflow.started',
      }),
      store,
      evidence: memorySource([]),
      streamId: STREAM,
      operationId: OPERATION,
    });

    expect(observation.status).toBe('satisfied');
    expect(observation.missing).toEqual([]);
  });

  it('Postconditions_MissingEvent_IsViolation', async () => {
    const observation = await observeActionPostconditions({
      ensures: declared({
        source: 'event-append',
        when: 'success',
        event: 'workflow.started',
      }),
      store: memorySource([]),
      evidence: memorySource([]),
      streamId: STREAM,
      operationId: OPERATION,
    });

    expect(observation.status).toBe('violated');
    expect(observation.missing).toEqual([
      { source: 'event-append', when: 'success', event: 'workflow.started' },
    ]);
  });

  it('Postconditions_PersistedEvidence_IsSatisfied', async () => {
    const evidence = memorySource([persistedGateEvidence(OPERATION)]);

    const observation = await observeActionPostconditions({
      ensures: declared({
        source: 'durable-evidence',
        when: 'success',
        evidenceType: 'gate',
      }),
      store: memorySource([]),
      evidence,
      streamId: STREAM,
      operationId: OPERATION,
    });

    expect(observation.status).toBe('satisfied');
    expect(observation.missing).toEqual([]);
  });

  it('Postconditions_ReplayedEvidenceWitness_DoesNotPass', async () => {
    const observation = await observeActionPostconditions({
      ensures: declared({
        source: 'durable-evidence',
        when: 'success',
        evidenceType: 'gate',
      }),
      store: memorySource([]),
      evidence: memorySource([]),
      streamId: STREAM,
      operationId: OPERATION,
      witnesses: [replayedEvidence('workflow.started', 'ledger fold of a prior run')],
    });

    expect(observation.status).toBe('violated');
    expect(observation.missing).toEqual([
      { source: 'durable-evidence', when: 'success', evidenceType: 'gate' },
    ]);
  });

  it('Postconditions_DeclarationWithoutObservation_DoesNotPass', async () => {
    const observation = await observeActionPostconditions({
      ensures: declared(
        { source: 'event-append', when: 'success', event: 'workflow.started' },
        { source: 'durable-evidence', when: 'success', evidenceType: 'gate' },
      ),
      store: memorySource([]),
      evidence: memorySource([]),
      streamId: STREAM,
      operationId: OPERATION,
    });

    expect(observation.status).toBe('violated');
    expect(observation.missing).toHaveLength(2);
  });
});
