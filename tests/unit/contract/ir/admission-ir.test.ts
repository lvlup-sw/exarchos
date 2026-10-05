import { describe, it, expect } from 'vitest';
import {
  AdmissionIrDocumentV1Schema,
  EdgeConditionNodeSchema,
  SHARED_ADMISSION_IR_VERSION,
  parseAdmissionIrDocument,
} from '../../../../src/contract/ir/admission-ir.js';
import { baseValidDoc } from '../../../../src/contract/ir/admission-ir-fixtures.js';

describe('shared admission IR — authored Zod validator (closure property)', () => {
  it('parses a valid document into a typed value', () => {
    const result = parseAdmissionIrDocument(baseValidDoc());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.irVersion).toBe(SHARED_ADMISSION_IR_VERSION);
      expect(result.document.workflowId).toBe('wf.demo');
    }
  });

  /**
   * The document cannot carry a shell command, a closure, an expression or harness syntax.
   * Each such key is an unknown property of a `.strict()` object, so the schema rejects it.
   */
  it.each([
    ['top-level command', (d: Record<string, unknown>) => (d['command'] = 'rm -rf /')],
    ['top-level script', (d: Record<string, unknown>) => (d['script'] = 'evil()')],
    ['top-level exec', (d: Record<string, unknown>) => (d['exec'] = 'sh -c x')],
    ['top-level eval', (d: Record<string, unknown>) => (d['eval'] = '1+1')],
    [
      'policy handler binding',
      (d: Record<string, unknown>) =>
        ((d['policies'] as Record<string, unknown>[])[0]!['handler'] = 'fn'),
    ],
    [
      'edge condition expression',
      (d: Record<string, unknown>) => {
        const edges = d['edges'] as Record<string, unknown>[];
        const cond = edges[0]!['condition'] as Record<string, unknown>;
        const ops = cond['operands'] as Record<string, unknown>[];
        ops[0]!['expression'] = 'a && b';
      },
    ],
  ])('rejects an escape hatch: %s', (_name, mutate) => {
    const doc = baseValidDoc();
    mutate(doc);
    expect(AdmissionIrDocumentV1Schema.safeParse(doc).success).toBe(false);
  });

  it('the closed edge-condition union rejects unknown kinds and non-scalar leaves', () => {
    expect(EdgeConditionNodeSchema.safeParse({ kind: 'custom', command: 'x' }).success).toBe(false);
    expect(
      EdgeConditionNodeSchema.safeParse({ kind: 'factEquals', field: 'x', value: { a: 1 } }).success,
    ).toBe(false);
    expect(
      EdgeConditionNodeSchema.safeParse({ kind: 'factEquals', field: 'x', value: [1, 2] }).success,
    ).toBe(false);
    expect(
      EdgeConditionNodeSchema.safeParse({ kind: 'factEquals', field: 'x', value: 'v' }).success,
    ).toBe(true);
  });

  it('rejects an off-version document', () => {
    const doc = baseValidDoc();
    doc['irVersion'] = '0';
    expect(AdmissionIrDocumentV1Schema.safeParse(doc).success).toBe(false);
  });
});
