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

// The Exarchos runtime validators the shared IR must round-trip against (P01-03,
// P06-02). Imported read-only — this test PROVES the shared surface tracks the
// runtime; it never mutates it.
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

// One compiled Ajv validator over the GENERATED JSON Schema — the second,
// independent validator the round-trip compares against Zod. `date-time` is
// declared as an always-pass format because the emitted `pattern` already does
// the datetime validation (agreement on a datetime corpus is proven below), and
// this silences Ajv's "unknown format" warning.
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

  // Exit proof half 1: neither side may accept what the other rejects. For EVERY
  // fixture, Ajv(JSON Schema) and Zod must agree, and both must match the
  // fixture's declared structural validity.
  it.each(ROUNDTRIP_FIXTURES)(
    'JSON Schema and Zod agree on: $name',
    ({ doc, structurallyValid }) => {
      const ajvOk = validate(doc);
      const zodOk = AdmissionIrDocumentV1Schema.safeParse(doc).success;
      expect(ajvOk).toBe(structurallyValid);
      expect(zodOk).toBe(structurallyValid);
      // The decisive round-trip assertion: the two validators never disagree.
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

  // Three-way agreement: the IR Zod schema, the generated JSON Schema (Ajv), and
  // the REAL runtime `compileEdgeCondition` (P06-02) all accept/reject the same
  // closed edge-condition nodes — proving the shared node set IS the runtime's.
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
      '', // empty
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
    // A kind outside the closed set is rejected by the runtime union.
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
