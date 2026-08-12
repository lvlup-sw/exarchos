import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WorkflowEvent } from '../../events/schemas.js';
import { AdmissionEvidenceRecordedData } from '../../events/schemas.js';
import { buildValidatedEvent } from '../../events/event-factory.js';
import { workflowStateProjection } from '../../projections/views/workflow-state-projection.js';
import { selectEvidence } from './select-evidence.js';

const AT = '2026-07-21T20:00:00.000Z';
const digest = (character = 'a') => ({
  algorithm: 'sha256' as const,
  value: character.repeat(64),
});

function evidenceRecord(
  evidenceId: string,
  verdict: 'pass' | 'fail' | 'indeterminate',
  overrides: Record<string, unknown> = {},
) {
  const { supersedesEvidenceId, ...evidenceOverrides } = overrides;
  return {
    eventVersion: '1.0',
    evidence: {
      contractVersion: '1.0',
      kind: 'gate',
      evidenceId,
      requirementId: 'requirement.typecheck',
      phaseAttemptId: 'phase-attempt.1',
      subject: {
        kind: 'task',
        taskId: 'task.014',
        digest: digest('1'),
      },
      producer: {
        producerId: `producer.${evidenceId}`,
        providerRef: 'provider.typecheck',
        providerVersion: '1.0',
        invocationId: `invocation.${evidenceId}`,
      },
      policyId: 'policy.phase-gate',
      policyDigest: digest('2'),
      contentDigest: digest(verdict === 'pass' ? '3' : verdict === 'fail' ? '4' : '5'),
      createdAt: AT,
      verdict,
      ...evidenceOverrides,
    },
    ...(supersedesEvidenceId === undefined ? {} : { supersedesEvidenceId }),
  };
}

function contradictionEvent(
  evidenceIds: readonly string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    eventVersion: '1.0',
    contradictionId: 'contradiction.downstream',
    phaseAttemptId: 'phase-attempt.1',
    policyId: 'policy.phase-gate',
    policyDigest: digest('2'),
    requirementId: 'requirement.typecheck',
    subject: {
      kind: 'task',
      taskId: 'task.014',
      digest: digest('1'),
    },
    evidenceIds,
    evidenceSetDigest: digest('6'),
    detectedAt: AT,
    ...overrides,
  };
}

function event(
  sequence: number,
  type: 'admission.evidence-recorded' | 'admission.contradiction-recorded',
  data: Record<string, unknown>,
): WorkflowEvent {
  return buildValidatedEvent('phase-gate-v212-proof-substrate', sequence, {
    timestamp: AT,
    type,
    data,
  });
}

describe('deterministic active-evidence selection', () => {
  it('EvidenceSelection_ValidRerun_SupersedesPriorResult', () => {
    const prior = evidenceRecord('evidence.1', 'fail');
    const rerun = evidenceRecord('evidence.2', 'pass', {
      supersedesEvidenceId: 'evidence.1',
    });

    const result = selectEvidence({ evidence: [prior, rerun] });

    expect(result.activeEvidence.map((record) => record.evidence.evidenceId)).toEqual([
      'evidence.2',
    ]);
    expect(result.supersessions).toEqual([
      expect.objectContaining({
        evidenceId: 'evidence.1',
        supersededByEvidenceId: 'evidence.2',
        producerId: 'producer.evidence.2',
      }),
    ]);
    expect(result.contradictions).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('EvidenceSelection_UnrelatedScope_RemainsActive', () => {
    const prior = evidenceRecord('evidence.1', 'fail');
    const rerun = evidenceRecord('evidence.2', 'pass', {
      supersedesEvidenceId: 'evidence.1',
    });
    const unrelated = evidenceRecord('evidence.3', 'fail', {
      requirementId: 'requirement.lint',
    });

    const result = selectEvidence({ evidence: [prior, unrelated, rerun] });

    expect(result.activeEvidence.map((record) => record.evidence.evidenceId)).toEqual([
      'evidence.2',
      'evidence.3',
    ]);
    expect(result.contradictions).toEqual([]);
  });

  it('EvidenceSelection_ActiveDisagreement_ProducesTypedContradiction', () => {
    const result = selectEvidence({
      evidence: [
        evidenceRecord('evidence.fail', 'fail'),
        evidenceRecord('evidence.pass', 'pass'),
      ],
    });

    expect(result.contradictions).toEqual([
      expect.objectContaining({
        source: 'active-evidence',
        requirementId: 'requirement.typecheck',
        evidenceIds: ['evidence.fail', 'evidence.pass'],
        statements: ['satisfied', 'unsatisfied'],
      }),
    ]);
  });

  it('EvidenceSelection_TypedDownstreamEvent_IsScopedAndVisible', () => {
    const evidence = [
      evidenceRecord('evidence.1', 'pass'),
      evidenceRecord('evidence.2', 'pass'),
    ];
    const result = selectEvidence({
      evidence,
      contradictionEvents: [contradictionEvent(['evidence.1', 'evidence.2'])],
    });

    expect(result.contradictions).toEqual([
      expect.objectContaining({
        source: 'downstream-event',
        contradictionId: 'contradiction.downstream',
        requirementId: 'requirement.typecheck',
        evidenceIds: ['evidence.1', 'evidence.2'],
      }),
    ]);
  });

  it('EvidenceSelection_DownstreamContradictionScopeFailures_AreExplicit', () => {
    const evidence = [
      evidenceRecord('evidence.1', 'pass'),
      evidenceRecord('evidence.2', 'fail'),
    ];
    const mismatchedEvents = [
      contradictionEvent(['evidence.1', 'evidence.2'], {
        contradictionId: 'contradiction.requirement',
        requirementId: 'requirement.other',
      }),
      contradictionEvent(['evidence.1', 'evidence.2'], {
        contradictionId: 'contradiction.phase',
        phaseAttemptId: 'phase-attempt.2',
      }),
      contradictionEvent(['evidence.1', 'evidence.2'], {
        contradictionId: 'contradiction.subject',
        subject: {
          kind: 'task',
          taskId: 'task.014',
          digest: digest('8'),
        },
      }),
      contradictionEvent(['evidence.1', 'evidence.2'], {
        contradictionId: 'contradiction.policy',
        policyDigest: digest('9'),
      }),
    ];

    const result = selectEvidence({
      evidence,
      contradictionEvents: [
        ...mismatchedEvents,
        contradictionEvent(['evidence.1', 'evidence.absent'], {
          contradictionId: 'contradiction.missing',
        }),
      ],
    });

    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'CONTRADICTION_SCOPE_MISMATCH',
      ),
    ).toHaveLength(mismatchedEvents.length);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_CONTRADICTION_EVIDENCE',
        contradictionId: 'contradiction.missing',
      }),
    );
    expect(
      result.contradictions.filter(
        (contradiction) => contradiction.source === 'downstream-event',
      ),
    ).toEqual([]);
  });

  it('EvidenceSelection_MalformedAndDuplicateFacts_HaveStableDiagnostics', () => {
    const duplicate = evidenceRecord('evidence.duplicate', 'pass');
    const result = selectEvidence({
      evidence: [
        duplicate,
        duplicate,
        {
          eventVersion: '1.0',
          evidence: { evidenceId: 'evidence.malformed' },
        },
      ],
      contradictionEvents: [
        {
          contradictionId: 'contradiction.malformed',
          eventVersion: '1.0',
        },
      ],
    });

    expect(result.activeEvidence).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'DUPLICATE_EVIDENCE_ID',
        evidenceId: 'evidence.duplicate',
      }),
      expect.objectContaining({
        code: 'MALFORMED_CONTRADICTION',
        contradictionId: 'contradiction.malformed',
      }),
      expect.objectContaining({
        code: 'MALFORMED_EVIDENCE',
        evidenceId: 'evidence.malformed',
      }),
    ]);
  });

  it('EvidenceSelection_MalformedChains_AreDiagnosticAndNeverSupersede', () => {
    const missing = evidenceRecord('evidence.missing-child', 'pass', {
      supersedesEvidenceId: 'evidence.absent',
    });
    const incompatiblePolicy = evidenceRecord('evidence.policy-child', 'pass', {
      supersedesEvidenceId: 'evidence.root',
      policyDigest: digest('9'),
    });
    const root = evidenceRecord('evidence.root', 'fail');
    const invalidDescendant = evidenceRecord('evidence.policy-grandchild', 'pass', {
      supersedesEvidenceId: 'evidence.policy-child',
      policyDigest: digest('9'),
    });
    const cycleA = evidenceRecord('evidence.cycle-a', 'pass', {
      supersedesEvidenceId: 'evidence.cycle-b',
    });
    const cycleB = evidenceRecord('evidence.cycle-b', 'fail', {
      supersedesEvidenceId: 'evidence.cycle-a',
    });

    const result = selectEvidence({
      evidence: [
        missing,
        invalidDescendant,
        incompatiblePolicy,
        root,
        cycleA,
        cycleB,
      ],
    });

    expect(result.activeEvidence.map((record) => record.evidence.evidenceId)).toEqual([
      'evidence.root',
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'CYCLIC_SUPERSESSION',
        'INCOMPATIBLE_POLICY_DIGEST',
        'INVALID_PREDECESSOR',
        'MISSING_PREDECESSOR',
      ]),
    );
  });

  it('EvidenceSelection_SupersessionScopeMismatch_IsExplicitPerScopeDimension', () => {
    const root = evidenceRecord('evidence.root', 'fail');
    const mismatched = [
      evidenceRecord('evidence.requirement', 'pass', {
        supersedesEvidenceId: 'evidence.root',
        requirementId: 'requirement.other',
      }),
      evidenceRecord('evidence.phase', 'pass', {
        supersedesEvidenceId: 'evidence.root',
        phaseAttemptId: 'phase-attempt.2',
      }),
      evidenceRecord('evidence.subject', 'pass', {
        supersedesEvidenceId: 'evidence.root',
        subject: {
          kind: 'task',
          taskId: 'task.014',
          digest: digest('8'),
        },
      }),
    ];

    const result = selectEvidence({ evidence: [root, ...mismatched] });

    expect(result.activeEvidence.map((record) => record.evidence.evidenceId)).toEqual([
      'evidence.root',
    ]);
    expect(
      result.diagnostics.filter((diagnostic) => diagnostic.code === 'SCOPE_MISMATCH'),
    ).toHaveLength(3);
  });

  it('EvidenceSelection_AllCanonicalSubjectVariants_IsolateDifferentIdentities', () => {
    const variants = [
      ['workflow', 'workflowId'],
      ['phase-attempt', 'phaseAttemptId'],
      ['wave', 'waveId'],
      ['task', 'taskId'],
      ['commit', 'commitId'],
      ['diff', 'diffId'],
      ['artifact', 'artifactId'],
    ] as const;

    for (const [kind, idField] of variants) {
      const root = evidenceRecord(`evidence.${kind}.root`, 'fail', {
        subject: { kind, [idField]: `${kind}.root`, digest: digest('1') },
      });
      const mismatched = evidenceRecord(`evidence.${kind}.child`, 'pass', {
        supersedesEvidenceId: `evidence.${kind}.root`,
        subject: { kind, [idField]: `${kind}.other`, digest: digest('1') },
      });

      const result = selectEvidence({ evidence: [mismatched, root] });

      expect(result.activeEvidence).toEqual([root]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'SCOPE_MISMATCH',
          evidenceId: `evidence.${kind}.child`,
        }),
      ]);
    }
  });

  it('EvidenceSchema_Supersession_IsExplicitAndCannotSelfReference', () => {
    expect(
      AdmissionEvidenceRecordedData.parse(
        evidenceRecord('evidence.2', 'pass', {
          supersedesEvidenceId: 'evidence.1',
        }),
      ).supersedesEvidenceId,
    ).toBe('evidence.1');
    expect(
      AdmissionEvidenceRecordedData.safeParse(
        evidenceRecord('evidence.1', 'pass', {
          supersedesEvidenceId: 'evidence.1',
        }),
      ).success,
    ).toBe(false);
  });

  it('WorkflowProjection_ProofFacts_AreAppendOnlyAuditVisibility', () => {
    const prior = evidenceRecord('evidence.1', 'fail');
    const rerun = evidenceRecord('evidence.2', 'pass', {
      supersedesEvidenceId: 'evidence.1',
    });
    const contradiction = contradictionEvent(['evidence.1', 'evidence.2']);
    const initial = workflowStateProjection.init();
    const afterPrior = workflowStateProjection.apply(
      initial,
      event(1, 'admission.evidence-recorded', prior),
    );
    const afterRerun = workflowStateProjection.apply(
      afterPrior,
      event(2, 'admission.evidence-recorded', rerun),
    );
    const projected = workflowStateProjection.apply(
      afterRerun,
      event(3, 'admission.contradiction-recorded', contradiction),
    );

    expect(projected.phase).toBe(initial.phase);
    expect(projected.admissionProof?.evidenceHistory).toEqual([prior, rerun]);
    expect(projected.admissionProof?.contradictionHistory).toEqual([contradiction]);
    expect(
      projected.admissionProof?.activeEvidence.map(
        (record) => record.evidence.evidenceId,
      ),
    ).toEqual(['evidence.2']);
    expect(projected.admissionProof?.contradictions).toEqual([
      expect.objectContaining({ source: 'downstream-event' }),
    ]);
    expect(afterPrior.admissionProof?.evidenceHistory).toEqual([prior]);
  });

  it('WorkflowProjection_PreProofState_AcceptsFirstProofEventWithoutBackfill', () => {
    const { admissionProof: _admissionProof, ...preProofState } =
      workflowStateProjection.init();
    const prior = evidenceRecord('evidence.legacy-first', 'pass');

    const projected = workflowStateProjection.apply(
      preProofState as ReturnType<typeof workflowStateProjection.init>,
      event(1, 'admission.evidence-recorded', prior),
    );

    expect(projected.admissionProof.evidenceHistory).toEqual([prior]);
    expect(projected.admissionProof.activeEvidence).toEqual([prior]);
  });

  it('EvidenceSelection_OrderIndependentReplay_Property', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer(), { minLength: 1, maxLength: 20 }),
        (priorities) => {
          const length = priorities.length;
          const chain = Array.from({ length }, (_, index) =>
            evidenceRecord(
              `evidence.${index}`,
              index % 2 === 0 ? 'fail' : 'pass',
              index === 0
                ? {}
                : { supersedesEvidenceId: `evidence.${index - 1}` },
            ),
          );
          const replay = chain
            .map((record, index) => ({ record, priority: priorities[index]! }))
            .sort((left, right) => left.priority - right.priority)
            .map(({ record }) => record);

          const result = selectEvidence({ evidence: replay });

          expect(result).toEqual(selectEvidence({ evidence: chain }));
          expect(
            result.activeEvidence.map((record) => record.evidence.evidenceId),
          ).toEqual([`evidence.${length - 1}`]);
          expect(result.supersessions).toHaveLength(length - 1);
          expect(result.diagnostics).toEqual([]);
          expect(result.contradictions).toEqual([]);
        },
      ),
    );
  });

  it('EvidenceSelection_AcyclicChains_Property', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), (length) => {
        const cycle = Array.from({ length }, (_, index) =>
          evidenceRecord(`evidence.${index}`, 'pass', {
            supersedesEvidenceId: `evidence.${(index + 1) % length}`,
          }),
        );

        const result = selectEvidence({ evidence: cycle });

        expect(result.activeEvidence).toEqual([]);
        expect(
          result.diagnostics.filter(
            (diagnostic) => diagnostic.code === 'CYCLIC_SUPERSESSION',
          ),
        ).toHaveLength(length);
      }),
    );
  });

  it('EvidenceSelection_UnrelatedScopeIsolation_Property', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (unrelatedCount) => {
        const prior = evidenceRecord('evidence.prior', 'fail');
        const rerun = evidenceRecord('evidence.rerun', 'pass', {
          supersedesEvidenceId: 'evidence.prior',
        });
        const unrelated = Array.from({ length: unrelatedCount }, (_, index) =>
          evidenceRecord(`evidence.unrelated-${index}`, 'fail', {
            requirementId: `requirement.unrelated-${index}`,
          }),
        );

        const result = selectEvidence({
          evidence: [rerun, ...unrelated.reverse(), prior],
        });

        expect(result.activeEvidence).toHaveLength(unrelatedCount + 1);
        expect(
          result.activeEvidence.map((record) => record.evidence.evidenceId),
        ).toContain('evidence.rerun');
        expect(result.contradictions).toEqual([]);
      }),
    );
  });

  it('EvidenceSelection_ContradictionDetection_Property', () => {
    fc.assert(
      fc.property(fc.boolean(), (supersede) => {
        const failed = evidenceRecord('evidence.failed', 'fail');
        const passed = evidenceRecord('evidence.passed', 'pass', {
          ...(supersede ? { supersedesEvidenceId: 'evidence.failed' } : {}),
        });

        const result = selectEvidence({ evidence: [passed, failed] });

        expect(
          result.contradictions.filter(
            (contradiction) => contradiction.source === 'active-evidence',
          ),
        ).toHaveLength(supersede ? 0 : 1);
      }),
    );
  });
});
