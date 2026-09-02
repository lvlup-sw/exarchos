// Exit-proof tests for P06-05 / Transition task 019 — freeze the obligation
// lattice into persisted, content-addressed requirement records.
//
// Proves the projection is:
//   - faithful   (one gate-evidence record per gate; approval / corroboration
//                 records appear iff the lattice demanded them);
//   - floored    (a positive corroboration obligation floors at 2 sources);
//   - stable     (same obligations + binding ⇒ identical ids and digest);
//   - bound      (records are content-addressed to the phase attempt + subject);
//   - monotone   (a stronger lattice element ⇒ a superset of records).
import { describe, expect, it } from 'vitest';

import {
  CORROBORATION_RECORD_FLOOR,
  DEFAULT_APPROVAL_CLASS,
  freezeRequirements,
} from '../../../../src/workflow/admission/freeze-requirements.js';
import { deepFreezeRequirements } from '../../../../src/workflow/admission/requirement-strength.js';
import type { ResolvedRequirements } from '../../../../src/workflow/admission/requirement-strength.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import { ApprovalClassSchema, PhaseAttemptIdSchema } from '../../../../src/workflow/admission/types.js';
import type { ResolvedGate } from '../../../../src/workflow/phase-kind.js';

const phaseAttemptId = PhaseAttemptIdSchema.parse('phase-attempt-freeze-001');
const subject = createEvidenceSubject(
  { kind: 'phase-attempt', phaseAttemptId },
  { phase: 'implement', attempt: 1 },
);

const STATIC: ResolvedGate = { family: 'ladder', gate: 'check_static_analysis' };
const ADEQUACY: ResolvedGate = { family: 'ladder', gate: 'check_test_adequacy' };

const resolved = (over: Partial<ResolvedRequirements> = {}): ResolvedRequirements =>
  deepFreezeRequirements({
    gates: [],
    minimumApprovals: 0,
    minimumCorroboratingSources: 0,
    waivable: true,
    ...over,
  });

describe('freezeRequirements — faithful projection', () => {
  it('Freeze_EmptyObligations_ProjectsNoRecordsWithStableDigest', () => {
    const first = freezeRequirements({ resolved: resolved(), phaseAttemptId, subject });
    const second = freezeRequirements({ resolved: resolved(), phaseAttemptId, subject });
    expect(first.requirements).toEqual([]);
    // A stable digest even for the empty set — a re-freeze is a no-op in identity.
    expect(first.requirementSetDigest).toEqual(second.requirementSetDigest);
    expect(first.requirementSetDigest.algorithm).toBe('sha256');
  });

  it('Freeze_GateObligations_ProjectOneGateEvidenceRecordEach', () => {
    const { requirements } = freezeRequirements({
      resolved: resolved({ gates: [STATIC, ADEQUACY] }),
      phaseAttemptId,
      subject,
    });
    expect(requirements).toHaveLength(2);
    for (const requirement of requirements) {
      expect(requirement.kind).toBe('gate-evidence');
      expect(requirement.phaseAttemptId).toBe(phaseAttemptId);
      expect(requirement.subject).toEqual(subject);
    }
    // Distinct gates project to distinct gate ids and requirement ids.
    const gateIds = requirements.map((r) =>
      r.kind === 'gate-evidence' ? r.gateId : '',
    );
    expect(new Set(gateIds).size).toBe(2);
    const reqIds = requirements.map((r) => r.requirementId);
    expect(new Set(reqIds).size).toBe(2);
  });

  it('Freeze_ApprovalObligation_ProjectsApprovalRecordWithClassAndCount', () => {
    const approvalClass = ApprovalClassSchema.parse('approval.security');
    const { requirements } = freezeRequirements({
      resolved: resolved({ minimumApprovals: 2 }),
      phaseAttemptId,
      subject,
      approvalClass,
    });
    expect(requirements).toHaveLength(1);
    const approval = requirements[0];
    expect(approval?.kind).toBe('approval');
    if (approval?.kind === 'approval') {
      expect(approval.minimumApprovals).toBe(2);
      expect(approval.approvalClass).toBe(approvalClass);
    }
  });

  it('Freeze_NoApprovalFloor_OmitsApprovalRecord', () => {
    const { requirements } = freezeRequirements({
      resolved: resolved({ minimumApprovals: 0 }),
      phaseAttemptId,
      subject,
    });
    expect(requirements.some((r) => r.kind === 'approval')).toBe(false);
  });

  it('Freeze_ApprovalWithoutClass_UsesDefaultApprovalClass', () => {
    const { requirements } = freezeRequirements({
      resolved: resolved({ minimumApprovals: 1 }),
      phaseAttemptId,
      subject,
    });
    const approval = requirements.find((r) => r.kind === 'approval');
    expect(approval?.kind === 'approval' && approval.approvalClass).toBe(
      DEFAULT_APPROVAL_CLASS,
    );
  });
});

describe('freezeRequirements — corroboration floor and self-source', () => {
  it('Freeze_PositiveCorroboration_FloorsAtTwoAndSelfSources', () => {
    const { requirements } = freezeRequirements({
      // A lattice value of 1 is meaningless as a persisted record; it floors to 2.
      resolved: resolved({ minimumCorroboratingSources: 1 }),
      phaseAttemptId,
      subject,
    });
    const corroboration = requirements.find((r) => r.kind === 'corroboration');
    expect(corroboration?.kind).toBe('corroboration');
    if (corroboration?.kind === 'corroboration') {
      expect(corroboration.minimumIndependentSources).toBe(CORROBORATION_RECORD_FLOOR);
      // Self-source: the obligation is discharged by N independent evidence
      // items bound to its own id.
      expect(corroboration.sourceRequirementId).toBe(corroboration.requirementId);
    }
  });

  it('Freeze_CorroborationAboveFloor_PreservesTheHigherCount', () => {
    const { requirements } = freezeRequirements({
      resolved: resolved({ minimumCorroboratingSources: 3 }),
      phaseAttemptId,
      subject,
    });
    const corroboration = requirements.find((r) => r.kind === 'corroboration');
    expect(
      corroboration?.kind === 'corroboration' && corroboration.minimumIndependentSources,
    ).toBe(3);
  });

  it('Freeze_ZeroCorroboration_OmitsCorroborationRecord', () => {
    const { requirements } = freezeRequirements({
      resolved: resolved({ minimumCorroboratingSources: 0 }),
      phaseAttemptId,
      subject,
    });
    expect(requirements.some((r) => r.kind === 'corroboration')).toBe(false);
  });
});

describe('freezeRequirements — determinism, binding, monotonicity', () => {
  it('Freeze_SameObligationsAndBinding_ProduceIdenticalIdsAndDigest', () => {
    const input = {
      resolved: resolved({ gates: [STATIC], minimumApprovals: 1 }),
      phaseAttemptId,
      subject,
    };
    const a = freezeRequirements(input);
    const b = freezeRequirements(input);
    expect(a).toEqual(b);
    expect(a.requirementSetDigest).toEqual(b.requirementSetDigest);
    expect(a.requirements.map((r) => r.requirementId)).toEqual(
      b.requirements.map((r) => r.requirementId),
    );
  });

  it('Freeze_DifferentPhaseAttempt_ProducesDifferentRequirementIds', () => {
    const base = freezeRequirements({
      resolved: resolved({ gates: [STATIC] }),
      phaseAttemptId,
      subject,
    });
    const otherAttempt = PhaseAttemptIdSchema.parse('phase-attempt-freeze-002');
    const otherSubject = createEvidenceSubject(
      { kind: 'phase-attempt', phaseAttemptId: otherAttempt },
      { phase: 'implement', attempt: 1 },
    );
    const other = freezeRequirements({
      resolved: resolved({ gates: [STATIC] }),
      phaseAttemptId: otherAttempt,
      subject: otherSubject,
    });
    expect(base.requirements[0]?.requirementId).not.toBe(
      other.requirements[0]?.requirementId,
    );
    expect(base.requirementSetDigest).not.toEqual(other.requirementSetDigest);
  });

  it('Freeze_StrongerLattice_ProjectsSupersetOfRecords', () => {
    const weak = freezeRequirements({
      resolved: resolved({ gates: [STATIC] }),
      phaseAttemptId,
      subject,
    });
    const strong = freezeRequirements({
      resolved: resolved({
        gates: [STATIC, ADEQUACY],
        minimumApprovals: 1,
        minimumCorroboratingSources: 2,
      }),
      phaseAttemptId,
      subject,
    });
    const weakIds = new Set(weak.requirements.map((r) => r.requirementId));
    const strongIds = new Set(strong.requirements.map((r) => r.requirementId));
    // Every weak requirement id survives in the stronger projection (superset).
    for (const id of weakIds) expect(strongIds.has(id)).toBe(true);
    expect(strong.requirements.length).toBeGreaterThan(weak.requirements.length);
    expect(strong.requirementSetDigest).not.toEqual(weak.requirementSetDigest);
  });

  it('Freeze_Records_AreDeeplyFrozen', () => {
    const { requirements } = freezeRequirements({
      resolved: resolved({ gates: [STATIC] }),
      phaseAttemptId,
      subject,
    });
    expect(Object.isFrozen(requirements)).toBe(true);
    expect(Object.isFrozen(requirements[0])).toBe(true);
  });
});
