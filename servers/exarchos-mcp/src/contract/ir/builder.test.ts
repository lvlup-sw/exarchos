import { describe, it, expect } from 'vitest';
import {
  AdmissionIrBuilder,
  AdmissionIrLoweringError,
  validateAdmissionIrDocument,
} from './builder.js';
import { canonicalJson } from '../request-context.js';
import type {
  EdgeDefinition,
  PolicyDefinition,
  RequirementDefinition,
  WaiverDefinition,
} from './admission-ir.js';

const ACTION_IDS = new Set(['exarchos_event.append']);

const gateReq: RequirementDefinition = {
  requirementId: 'req.gate',
  kind: 'gate-evidence',
  gateId: 'gate.build',
  subjectKind: 'task',
};

const policy: PolicyDefinition = {
  policyId: 'pol.release',
  requires: ['req.gate'],
  onDeny: ['exarchos_event.append'],
};

const edge: EdgeDefinition = {
  edgeId: 'edge.build',
  from: 's.plan',
  to: 's.review',
  declaration: { fields: { ok: 'boolean' }, events: [] },
  condition: { kind: 'not', operand: { kind: 'factEquals', field: 'ok', value: false } },
  admits: 'pol.release',
  effect: { actionRef: 'exarchos_event.append' },
};

const waiver: WaiverDefinition = {
  waiverId: 'wv.gate',
  scope: { kind: 'workflow', workflowId: 'wf.demo' },
  waives: ['req.gate'],
  expiresAt: '2027-01-01T00:00:00Z',
  authorization: { approvalClass: 'release', minimumApprovals: 1 },
};

function fullBuilder(): AdmissionIrBuilder {
  return new AdmissionIrBuilder()
    .workflow('wf.demo')
    .policy(policy)
    .requirement(gateReq)
    .edge(edge)
    .waiver(waiver);
}

describe('shared admission IR — builder lowering (transition tasks 033/047)', () => {
  it('lowers assembled parts to a structurally valid shared IR document', () => {
    const doc = fullBuilder().lower();
    expect(doc.irVersion).toBe('1');
    expect(doc.workflowId).toBe('wf.demo');
    expect(doc.policies.map((p) => p.policyId)).toEqual(['pol.release']);
    expect(doc.edges).toHaveLength(1);
  });

  it('lowering is deterministic — add order does not change the lowered bytes', () => {
    const a = new AdmissionIrBuilder()
      .workflow('wf.demo')
      .requirement({ ...gateReq, requirementId: 'req.b' })
      .requirement({ ...gateReq, requirementId: 'req.a' })
      .policy({ ...policy, policyId: 'pol.z', requires: [] })
      .policy({ ...policy, policyId: 'pol.a', requires: [] })
      .edge(edge)
      .waiver(waiver)
      .lower();
    const b = new AdmissionIrBuilder()
      .workflow('wf.demo')
      .policy({ ...policy, policyId: 'pol.a', requires: [] })
      .policy({ ...policy, policyId: 'pol.z', requires: [] })
      .requirement({ ...gateReq, requirementId: 'req.a' })
      .requirement({ ...gateReq, requirementId: 'req.b' })
      .waiver(waiver)
      .edge(edge)
      .lower();
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    // and sorted deterministically by stable id
    expect(a.requirements.map((r) => r.requirementId)).toEqual(['req.a', 'req.b']);
    expect(a.policies.map((p) => p.policyId)).toEqual(['pol.a', 'pol.z']);
  });

  it('throws AdmissionIrLoweringError on a structurally invalid assembly', () => {
    // No workflow id set → lowering produces an empty workflowId, which fails the
    // stable-id shape.
    const builder = new AdmissionIrBuilder().policy(policy).requirement(gateReq);
    expect(() => builder.lower()).toThrow(AdmissionIrLoweringError);
  });

  it('build() lowers AND resolves references (sound document passes both)', () => {
    const { document, references } = fullBuilder().build({ actionIds: ACTION_IDS });
    expect(document.workflowId).toBe('wf.demo');
    expect(references.ok).toBe(true);
  });

  it('build() surfaces dangling references without throwing (structure is valid)', () => {
    const { references } = new AdmissionIrBuilder()
      .workflow('wf.demo')
      .policy(policy)
      .requirement(gateReq)
      .edge({ ...edge, admits: 'pol.ghost' }) // dangling policy ref
      .waiver(waiver)
      .build({ actionIds: ACTION_IDS });
    expect(references.ok).toBe(false);
    expect(references.violations.some((v) => v.kind === 'dangling-policy')).toBe(true);
  });
});

describe('shared admission IR — validateAdmissionIrDocument (consumer entry point)', () => {
  it('accepts a structurally valid AND referentially sound document', () => {
    const doc = fullBuilder().lower();
    const result = validateAdmissionIrDocument(doc, { actionIds: ACTION_IDS });
    expect(result.ok).toBe(true);
  });

  it('rejects a structurally invalid document at the structure stage', () => {
    const result = validateAdmissionIrDocument({ irVersion: '1' }, { actionIds: ACTION_IDS });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('structure');
  });

  it('rejects a structurally valid but referentially unsound document at the references stage', () => {
    const doc = fullBuilder().lower();
    const broken = { ...doc, edges: doc.edges.map((e) => ({ ...e, admits: 'pol.ghost' })) };
    const result = validateAdmissionIrDocument(broken, { actionIds: ACTION_IDS });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('references');
  });
});
