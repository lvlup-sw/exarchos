/**
 * Exit-proof tests for P06-02 — closed edge-condition AST and compile/import
 * time validation (Transition task 009).
 *
 * Proves:
 *   (a) an unsupported / unknown node kind is rejected at compile/import time;
 *   (b) an arbitrary executable expression (function value, or a string
 *       expression escape hatch) is rejected at compile/import time;
 *   plus prototype-pollution, undeclared references, and shape closedness.
 */
import { describe, expect, it } from 'vitest';
import {
  EDGE_CONDITION_NODE_KINDS,
  EdgeConditionCompileError,
  compileEdgeCondition,
  serializeEdgeCondition,
  tryCompileEdgeCondition,
  type EdgeConditionCompileErrorCode,
  type EdgeConditionDeclaration,
} from '../../../../src/workflow/admission/edge-condition.js';

const declaration = {
  fields: {
    phaseKind: 'string',
    reviewPasses: 'number',
    boundaryClear: 'boolean',
  },
  events: ['gate.passed', 'gate.failed'],
} as const satisfies EdgeConditionDeclaration;

function expectReject(
  raw: unknown,
  code: EdgeConditionCompileErrorCode,
): EdgeConditionCompileError {
  const result = tryCompileEdgeCondition(raw, declaration);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected compilation to fail');
  expect(result.error).toBeInstanceOf(EdgeConditionCompileError);
  expect(result.error.code).toBe(code);
  return result.error;
}

describe('closed AST shape', () => {
  it('exposes exactly the seven approved node kinds', () => {
    expect([...EDGE_CONDITION_NODE_KINDS]).toEqual([
      'eventObserved',
      'factPresent',
      'factEquals',
      'counterCompare',
      'all',
      'any',
      'not',
    ]);
    expect(new Set(EDGE_CONDITION_NODE_KINDS).size).toBe(7);
  });

  it('compiles each of the seven node kinds and round-trips serialization', () => {
    const condition = compileEdgeCondition(
      {
        kind: 'all',
        operands: [
          { kind: 'eventObserved', event: 'gate.passed' },
          { kind: 'factPresent', field: 'phaseKind' },
          { kind: 'factEquals', field: 'phaseKind', value: 'review' },
          { kind: 'counterCompare', field: 'reviewPasses', op: 'gte', value: 2 },
          {
            kind: 'any',
            operands: [{ kind: 'factEquals', field: 'boundaryClear', value: true }],
          },
          { kind: 'not', operand: { kind: 'eventObserved', event: 'gate.failed' } },
        ],
      },
      declaration,
    );
    expect(Object.isFrozen(condition)).toBe(true);
    expect(Object.isFrozen(condition.node)).toBe(true);
    // Serialization is total and holds only inert data.
    const json = serializeEdgeCondition(condition);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toContain('function');
  });

  it('treats an empty `all` as the always-legal constant and empty `any` as never-legal', () => {
    expect(() => compileEdgeCondition({ kind: 'all', operands: [] }, declaration)).not.toThrow();
    expect(() => compileEdgeCondition({ kind: 'any', operands: [] }, declaration)).not.toThrow();
  });
});

describe('(a) unsupported node kinds are rejected at compile time', () => {
  it('rejects an unknown discriminant', () => {
    expectReject({ kind: 'custom', field: 'phaseKind' }, 'UNKNOWN_NODE_KIND');
  });

  it('rejects a free-form expression node', () => {
    expectReject({ kind: 'expr', expression: 'reviewPasses > 1' }, 'UNKNOWN_NODE_KIND');
  });

  it('rejects a provider-reference escape-hatch node', () => {
    expectReject(
      { kind: 'providerRef', provider: 'static-analysis' },
      'UNKNOWN_NODE_KIND',
    );
  });

  it('rejects a node with no kind', () => {
    expectReject({ field: 'phaseKind' }, 'MISSING_KIND');
  });
});

describe('(b) arbitrary executable expressions are rejected at compile time', () => {
  // Named exit-proof: EdgeConditionAst_ExecutableLeaf_IsRejected
  it('EdgeConditionAst_ExecutableLeaf_IsRejected: a function-valued leaf is rejected', () => {
    expectReject(
      { kind: 'factEquals', field: 'phaseKind', value: (): boolean => true },
      'EXECUTABLE_VALUE',
    );
  });

  it('rejects a function-valued node anywhere in the tree', () => {
    expectReject(
      { kind: 'all', operands: [(): boolean => true] },
      'EXECUTABLE_VALUE',
    );
  });

  it('rejects the whole condition being a function', () => {
    expectReject((): boolean => true, 'EXECUTABLE_VALUE');
  });

  it('rejects a string-expression escape hatch smuggled as an extra property', () => {
    expectReject(
      { kind: 'factEquals', field: 'phaseKind', value: 'review', expression: 'a && b' },
      'UNKNOWN_PROPERTY',
    );
  });

  it('rejects a shell-command escape hatch smuggled as an extra property', () => {
    expectReject(
      { kind: 'factPresent', field: 'phaseKind', command: 'rm -rf /' },
      'UNKNOWN_PROPERTY',
    );
  });
});

describe('prototype-pollution keys are rejected', () => {
  it('rejects a __proto__ own property from parsed JSON without polluting Object.prototype', () => {
    const raw: unknown = JSON.parse(
      '{"kind":"all","operands":[],"__proto__":{"polluted":true}}',
    );
    expectReject(raw, 'FORBIDDEN_KEY');
    expect(
      (Object.prototype as Record<string, unknown>)['polluted'],
    ).toBeUndefined();
  });

  it('rejects a `constructor` property', () => {
    const raw: unknown = JSON.parse('{"kind":"all","operands":[],"constructor":1}');
    expectReject(raw, 'FORBIDDEN_KEY');
  });
});

describe('undeclared references are rejected', () => {
  it('rejects a factPresent on an undeclared field', () => {
    expectReject({ kind: 'factPresent', field: 'unknownField' }, 'UNDECLARED_FIELD');
  });

  it('rejects an eventObserved on an undeclared event', () => {
    expectReject({ kind: 'eventObserved', event: 'never.declared' }, 'UNDECLARED_EVENT');
  });
});

describe('type and shape constraints are enforced', () => {
  it('rejects a factEquals whose value type disagrees with the declared field type', () => {
    expectReject(
      { kind: 'factEquals', field: 'reviewPasses', value: 'two' },
      'FIELD_TYPE_MISMATCH',
    );
  });

  it('rejects a counterCompare against a non-numeric field', () => {
    expectReject(
      { kind: 'counterCompare', field: 'phaseKind', op: 'gt', value: 1 },
      'FIELD_TYPE_MISMATCH',
    );
  });

  it('rejects an unsupported comparison operator', () => {
    expectReject(
      { kind: 'counterCompare', field: 'reviewPasses', op: 'approx', value: 1 },
      'INVALID_OPERATOR',
    );
  });

  it('rejects a non-finite counter threshold', () => {
    expectReject(
      { kind: 'counterCompare', field: 'reviewPasses', op: 'gt', value: Number.POSITIVE_INFINITY },
      'INVALID_NUMBER',
    );
  });

  it('rejects a non-scalar factEquals value', () => {
    expectReject(
      { kind: 'factEquals', field: 'phaseKind', value: { nested: true } },
      'NON_SCALAR_VALUE',
    );
  });

  it('rejects operands that are not an array', () => {
    expectReject({ kind: 'all', operands: 'gate.passed' }, 'INVALID_PROPERTY_TYPE');
  });
});

describe('declaration validation', () => {
  it('rejects a malformed declaration', () => {
    const result = tryCompileEdgeCondition(
      { kind: 'all', operands: [] },
      { fields: { bad: 'integer' } } as unknown as EdgeConditionDeclaration,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('INVALID_DECLARATION');
  });
});
