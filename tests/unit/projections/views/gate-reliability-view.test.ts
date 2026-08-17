import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { gateRunnerObservationSource } from '../../../../src/verbs/gates/gate-runner.js';
import {
  gateReliabilityProjection,
  type GateReliabilityMetric,
  type GateReliabilityViewState,
} from '../../../../src/projections/views/gate-reliability-view.js';

const STREAM = 'gate-reliability-tests';
const BASE_TIME = Date.parse('2026-07-21T22:00:00.000Z');
const digest = (character: string) => ({
  algorithm: 'sha256' as const,
  value: character.repeat(64),
});

function timestamp(sequence: number): string {
  return new Date(BASE_TIME + sequence * 1_000).toISOString();
}

function verdictEvent(
  sequence: number,
  verdict: 'pass' | 'fail' | 'indeterminate',
  options: {
    evidenceId?: string;
    source?: string;
    invocationId?: string;
    gateClass?: string;
    providerRef?: string;
  } = {},
): WorkflowEvent {
  const evidenceId = options.evidenceId ?? `evidence.${sequence}`;
  const invocationId = options.invocationId ?? `invocation.${sequence}`;
  const gateClass = options.gateClass ?? 'test-adequacy';
  return {
    streamId: STREAM,
    sequence,
    timestamp: timestamp(sequence),
    type: 'admission.evidence-recorded',
    schemaVersion: '1.0',
    operationId: invocationId,
    source: options.source ?? gateRunnerObservationSource(gateClass),
    data: {
      eventVersion: '1.0',
      evidence: {
        contractVersion: '1.0',
        kind: 'gate',
        evidenceId,
        requirementId: 'requirement.test-adequacy',
        phaseAttemptId: 'phase-attempt.010',
        subject: {
          kind: 'task',
          taskId: 'task.010',
          digest: digest('1'),
        },
        producer: {
          producerId: 'agent.task-010',
          providerRef: options.providerRef ?? 'check_test_adequacy',
          providerVersion: '2.12.0',
          invocationId,
        },
        policyId: 'policy.verification-ladder',
        policyDigest: digest('2'),
        contentDigest: digest(
          verdict === 'pass' ? '3' : verdict === 'fail' ? '4' : '5',
        ),
        createdAt: timestamp(sequence),
        verdict,
      },
    },
  } as WorkflowEvent;
}

function contradictionEvent(
  sequence: number,
  evidenceIds: readonly string[],
  contradictionId = `contradiction.${sequence}`,
): WorkflowEvent {
  return {
    streamId: STREAM,
    sequence,
    timestamp: timestamp(sequence),
    type: 'admission.contradiction-recorded',
    schemaVersion: '1.0',
    data: {
      eventVersion: '1.0',
      contradictionId,
      phaseAttemptId: 'phase-attempt.010',
      policyId: 'policy.verification-ladder',
      policyDigest: digest('2'),
      requirementId: 'requirement.test-adequacy',
      subject: {
        kind: 'task',
        taskId: 'task.010',
        digest: digest('1'),
      },
      evidenceIds,
      evidenceSetDigest: digest('6'),
      detectedAt: timestamp(sequence),
    },
  } as WorkflowEvent;
}

function fold(events: readonly WorkflowEvent[]): GateReliabilityViewState {
  return events.reduce(
    (state, event) => gateReliabilityProjection.apply(state, event),
    gateReliabilityProjection.init(),
  );
}

function metric(
  state: GateReliabilityViewState,
  gateClass = 'test-adequacy',
  gateIdentity = 'check_test_adequacy',
): GateReliabilityMetric {
  const result = state.gates.find(
    (candidate) =>
      candidate.gateClass === gateClass &&
      candidate.gateIdentity === gateIdentity,
  );
  expect(result).toBeDefined();
  return result!;
}

describe('gate reliability diagnostic projection', () => {
  it('GateReliability_VerdictAndContradiction_FoldsAttributably', () => {
    const pass = verdictEvent(1, 'pass', { evidenceId: 'evidence.pass' });
    const fail = verdictEvent(2, 'fail', { evidenceId: 'evidence.fail' });
    const contradiction = contradictionEvent(
      3,
      ['evidence.pass', 'evidence.fail'],
      'contradiction.downstream',
    );

    const result = metric(fold([pass, fail, contradiction]));

    expect(result).toMatchObject({
      gateClass: 'test-adequacy',
      gateIdentity: 'check_test_adequacy',
      value: 0,
      fpr: 1,
      falsePositiveRate: 1,
      sampleSize: 2,
      positiveSampleSize: 1,
      falsePositiveCount: 1,
      verdicts: { pass: 1, fail: 1, indeterminate: 0 },
      asOf: timestamp(3),
      source: { streamId: STREAM, sequence: 3 },
    });
    expect(result.provenance.verdicts).toEqual([
      expect.objectContaining({
        evidenceId: 'evidence.fail',
        verdict: 'fail',
        source: { streamId: STREAM, sequence: 2 },
      }),
      expect.objectContaining({
        evidenceId: 'evidence.pass',
        verdict: 'pass',
        producer: expect.objectContaining({
          providerRef: 'check_test_adequacy',
          invocationId: 'invocation.1',
        }),
      }),
    ]);
    expect(result.provenance.contradictions).toEqual([
      {
        contradictionId: 'contradiction.downstream',
        detectedAt: timestamp(3),
        source: { streamId: STREAM, sequence: 3 },
        evidenceIds: ['evidence.fail', 'evidence.pass'],
        falsePositiveEvidenceIds: ['evidence.pass'],
      },
    ]);
    expect(result.provenance.verdicts[0]).toHaveProperty('subject');
    expect(result.provenance.verdicts[0]).toHaveProperty('policyDigest');
    expect(result.provenance.verdicts[0]).toHaveProperty('contentDigest');
    expect(result).not.toHaveProperty('requirements');
    expect(result).not.toHaveProperty('transition');
  });

  it('GateReliability_FoldOrderAndIncrementalReplay_AreDeterministic', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('pass', 'fail', 'indeterminate') as fc.Arbitrary<
          'pass' | 'fail' | 'indeterminate'
        >, { minLength: 1, maxLength: 20 }),
        (verdicts) => {
          const events = verdicts.map((verdict, index) =>
            verdictEvent(index + 1, verdict, {
              evidenceId: `evidence.${index + 1}`,
            }),
          );
          const forward = fold(events);
          const reverse = fold([...events].reverse());
          const split = Math.floor(events.length / 2);
          const incremental = fold(events.slice(0, split));
          const completed = events.slice(split).reduce(
            (state, event) => gateReliabilityProjection.apply(state, event),
            incremental,
          );

          expect(reverse).toEqual(forward);
          expect(completed).toEqual(forward);
        },
      ),
    );
  });

  it('GateReliability_SampleAccounting_MatchesNormalizedVerdicts', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('pass', 'fail', 'indeterminate') as fc.Arbitrary<
          'pass' | 'fail' | 'indeterminate'
        >, { maxLength: 30 }),
        (verdicts) => {
          const result = metric(fold(verdicts.map((verdict, index) =>
            verdictEvent(index + 1, verdict)
          )));
          expect(result.sampleSize).toBe(verdicts.length);
          expect(result.verdicts.pass).toBe(verdicts.filter((v) => v === 'pass').length);
          expect(result.verdicts.fail).toBe(verdicts.filter((v) => v === 'fail').length);
          expect(result.verdicts.indeterminate).toBe(
            verdicts.filter((v) => v === 'indeterminate').length,
          );
          expect(result.positiveSampleSize).toBe(result.verdicts.pass);
          if (result.positiveSampleSize === 0) {
            expect(result.value).toBeNull();
            expect(result.falsePositiveRate).toBeNull();
          }
        },
      ),
    );
  });

  it('GateReliability_ContradictionEffects_CountEachAttributedPassOnce', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), (passCount) => {
        const passes = Array.from({ length: passCount }, (_, index) =>
          verdictEvent(index + 1, 'pass', {
            evidenceId: `evidence.pass.${index + 1}`,
          }),
        );
        const contradiction = contradictionEvent(
          passCount + 1,
          ['evidence.pass.1', 'evidence.pass.2'],
        );
        // A second fact over the same pass cannot double count that execution.
        const overlap = contradictionEvent(
          passCount + 2,
          ['evidence.pass.1', `evidence.pass.${passCount}`],
        );
        const result = metric(fold([...passes, contradiction, overlap]));
        const expectedFalsePositives = passCount === 2 ? 2 : 3;

        expect(result.falsePositiveCount).toBe(expectedFalsePositives);
        expect(result.falsePositiveRate).toBe(expectedFalsePositives / passCount);
        expect(result.value).toBe(1 - expectedFalsePositives / passCount);
      }),
    );
  });

  it('GateReliability_UnobservedExecutionsAndIncompleteContradictions_AreExcluded', () => {
    fc.assert(
      fc.property(fc.boolean(), (passed) => {
        const telemetry = {
          streamId: STREAM,
          sequence: 1,
          timestamp: timestamp(1),
          type: 'gate.executed',
          schemaVersion: '1.0',
          data: { gateName: 'test-adequacy', passed },
        } as WorkflowEvent;
        const directEvidence = verdictEvent(2, passed ? 'pass' : 'fail', {
          source: 'direct-telemetry',
          evidenceId: 'evidence.direct',
        });
        const mismatchedInvocation = verdictEvent(3, 'pass', {
          invocationId: 'invocation.evidence',
          evidenceId: 'evidence.mismatch',
        }) as WorkflowEvent;
        const forgedMismatch = {
          ...mismatchedInvocation,
          operationId: 'invocation.envelope',
        } as WorkflowEvent;
        const observed = verdictEvent(4, 'pass', {
          evidenceId: 'evidence.observed',
        });
        const incomplete = contradictionEvent(
          5,
          ['evidence.observed', 'evidence.direct'],
        );

        const result = metric(fold([
          telemetry,
          directEvidence,
          forgedMismatch,
          observed,
          incomplete,
        ]));
        expect(result.sampleSize).toBe(1);
        expect(result.falsePositiveCount).toBe(0);
        expect(result.value).toBe(1);
        expect(result.provenance.verdicts.map(({ evidenceId }) => evidenceId))
          .toEqual(['evidence.observed']);
        expect(result.provenance.contradictions).toEqual([]);
      }),
    );
  });

  it('GateReliability_ProvenanceRetainsEveryCountedSource', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('pass', 'fail', 'indeterminate') as fc.Arbitrary<
          'pass' | 'fail' | 'indeterminate'
        >, { minLength: 1, maxLength: 20 }),
        (verdicts) => {
          const events = verdicts.map((verdict, index) =>
            verdictEvent(index + 1, verdict, {
              evidenceId: `evidence.provenance.${index + 1}`,
            }),
          );
          const result = metric(fold(events));

          expect(result.provenance.verdicts).toHaveLength(result.sampleSize);
          expect(new Set(
            result.provenance.verdicts.map(({ evidenceId }) => evidenceId),
          ).size).toBe(result.sampleSize);
          expect(result.provenance.verdicts.map(({ source }) => source.sequence).sort(
            (left, right) => left - right,
          )).toEqual(events.map(({ sequence }) => sequence));
        },
      ),
    );
  });
});
