/**
 * Round-trip proofs for the shared admission IR. The generated JSON Schema and the authored Zod
 * schemas must agree with each other and with the runtime validators in `src/workflow/admission`.
 * The tests import the runtime validators and do not change them.
 */
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

import {
  AdmissionIrDocumentV1Schema,
  EdgeConditionNodeSchema,
  SharedStableIdSchema,
  admissionIrJsonSchema,
  IR_EDGE_CONDITION_KINDS,
  IR_EDGE_COMPARE_OPS,
  IR_SUBJECT_KINDS,
  IR_REQUIREMENT_KINDS,
  IR_WAIVER_SCOPE_KINDS,
} from '../../../../src/contract/ir/admission-ir.js';
import {
  ROUNDTRIP_FIXTURES,
  EDGE_CONDITION_CASES,
  minimalValidDoc,
} from '../../../../src/contract/ir/admission-ir-fixtures.js';

import {
  EvidenceSubjectV1Schema,
  AdmissionRequirementV1Schema,
  WaiverScopeV1Schema,
  PolicyIdSchema,
  RequirementIdSchema,
} from '../../../../src/workflow/admission/types.js';
import {
  EDGE_CONDITION_NODE_KINDS,
  EDGE_COMPARE_OPS,
  tryCompileEdgeCondition,
} from '../../../../src/workflow/admission/edge-condition.js';

/**
 * Compiles the generated JSON Schema with Ajv. This validator is independent of Zod.
 * The `date-time` format always passes, because the emitted `pattern` already validates a datetime.
 * The declared format also stops the Ajv warning for an unknown format.
 */
function compileSchemaValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, formats: { 'date-time': true } });
  return ajv.compile(admissionIrJsonSchema());
}

/** Access a Zod discriminated-union's arm count without reaching for `any`. */
function armCount(schema: unknown): number {
  return (schema as { options: readonly unknown[] }).options.length;
}

const SHA256_ZEROS = '0'.repeat(64);
const DIGEST = { algorithm: 'sha256', value: SHA256_ZEROS } as const;

function runtimeSubjectFor(kind: string): Record<string, unknown> {
  const idKey: Record<string, string> = {
    workflow: 'workflowId',
    'phase-attempt': 'phaseAttemptId',
    wave: 'waveId',
    task: 'taskId',
    commit: 'commitId',
    diff: 'diffId',
    artifact: 'artifactId',
  };
  const key = idKey[kind];
  return { kind, [key ?? 'id']: 'id.one', digest: DIGEST };
}

describe('shared admission IR — round-trip (JSON Schema ⟺ Zod runtime validators)', () => {
  const validate = compileSchemaValidator();

  it('the generated JSON Schema compiles under a JSON-Schema validator', () => {
    expect(typeof validate).toBe('function');
  });

  /** For each fixture, Ajv and Zod must agree, and both must match the declared validity. */
  it.each(ROUNDTRIP_FIXTURES)(
    'JSON Schema and Zod agree on: $name',
    ({ doc, structurallyValid }) => {
      const ajvOk = validate(doc);
      const zodOk = AdmissionIrDocumentV1Schema.safeParse(doc).success;
      expect(ajvOk).toBe(structurallyValid);
      expect(zodOk).toBe(structurallyValid);
      expect(ajvOk).toBe(zodOk);
    },
  );

  it('no fixture is silently skipped — the corpus covers accept AND reject', () => {
    const accepts = ROUNDTRIP_FIXTURES.filter((f) => f.structurallyValid).length;
    const rejects = ROUNDTRIP_FIXTURES.length - accepts;
    expect(accepts).toBeGreaterThanOrEqual(4);
    expect(rejects).toBeGreaterThanOrEqual(10);
  });
});

describe('shared admission IR — closed edge conditions round-trip against the runtime', () => {
  const validate = compileSchemaValidator();

  /**
   * The IR Zod schema, the generated JSON Schema under Ajv and the runtime
   * `tryCompileEdgeCondition` must accept and reject the same edge-condition nodes.
   */
  it.each(EDGE_CONDITION_CASES)('IR schema, JSON Schema, and runtime agree on: $name', (c) => {
    const zodOk = EdgeConditionNodeSchema.safeParse(c.condition).success;
    const runtimeOk = tryCompileEdgeCondition(c.condition, {
      fields: c.fields,
      events: [...c.events],
    }).ok;

    const doc = minimalValidDoc();
    const edges = doc['edges'] as Record<string, unknown>[];
    const edge = edges[0] as Record<string, unknown>;
    edge['condition'] = c.condition;
    edge['declaration'] = { fields: c.fields, events: [...c.events] };
    const ajvOk = validate(doc);

    expect(zodOk).toBe(c.valid);
    expect(runtimeOk).toBe(c.valid);
    expect(ajvOk).toBe(c.valid);
  });

  it('the closed node-kind set IS the runtime closed AST (P06-02)', () => {
    expect([...IR_EDGE_CONDITION_KINDS]).toEqual([...EDGE_CONDITION_NODE_KINDS]);
    expect([...IR_EDGE_COMPARE_OPS]).toEqual([...EDGE_COMPARE_OPS]);
  });
});

describe('shared admission IR — id/enum vocabularies track the runtime validators', () => {
  it('the stable-id vocabulary matches the runtime StableId schemas', () => {
    const corpus = [
      'wf.demo',
      'exarchos_event.append',
      'a:b-c_d.e',
      'X',
      '',
      'has space',
      '; rm -rf /',
      '../escape',
      '.leading-dot',
      'tab\tchar',
    ];
    for (const s of corpus) {
      const shared = SharedStableIdSchema.safeParse(s).success;
      const runtimePolicy = PolicyIdSchema.safeParse(s).success;
      const runtimeReq = RequirementIdSchema.safeParse(s).success;
      expect(shared).toBe(runtimePolicy);
      expect(shared).toBe(runtimeReq);
    }
  });

  it('IR evidence-subject kinds are exactly the runtime EvidenceSubjectV1 kinds', () => {
    expect(armCount(EvidenceSubjectV1Schema)).toBe(IR_SUBJECT_KINDS.length);
    for (const kind of IR_SUBJECT_KINDS) {
      expect(EvidenceSubjectV1Schema.safeParse(runtimeSubjectFor(kind)).success).toBe(true);
    }
    expect(EvidenceSubjectV1Schema.safeParse(runtimeSubjectFor('nope')).success).toBe(false);
  });

  it('IR requirement kinds are exactly the runtime AdmissionRequirementV1 kinds', () => {
    expect(armCount(AdmissionRequirementV1Schema)).toBe(IR_REQUIREMENT_KINDS.length);
    const base = {
      contractVersion: '1.0',
      requirementId: 'req.one',
      phaseAttemptId: 'pa.one',
      subject: runtimeSubjectFor('task'),
    };
    const byKind: Record<string, Record<string, unknown>> = {
      'gate-evidence': { ...base, kind: 'gate-evidence', gateId: 'gate.x' },
      approval: { ...base, kind: 'approval', approvalClass: 'release', minimumApprovals: 1 },
      corroboration: {
        ...base,
        kind: 'corroboration',
        sourceRequirementId: 'req.two',
        minimumIndependentSources: 2,
      },
    };
    for (const kind of IR_REQUIREMENT_KINDS) {
      expect(AdmissionRequirementV1Schema.safeParse(byKind[kind]).success).toBe(true);
    }
  });

  it('IR waiver-scope kinds are exactly the runtime WaiverScopeV1 kinds', () => {
    expect(armCount(WaiverScopeV1Schema)).toBe(IR_WAIVER_SCOPE_KINDS.length);
    const byKind: Record<string, Record<string, unknown>> = {
      workflow: { kind: 'workflow', workflowId: 'wf.x' },
      'phase-attempt': { kind: 'phase-attempt', phaseAttemptId: 'pa.x' },
      subject: { kind: 'subject', subject: runtimeSubjectFor('artifact') },
    };
    for (const kind of IR_WAIVER_SCOPE_KINDS) {
      expect(WaiverScopeV1Schema.safeParse(byKind[kind]).success).toBe(true);
    }
  });
});
