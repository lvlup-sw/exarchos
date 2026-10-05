import { describe, it, expect } from 'vitest';
import {
  InvariantEntryV3Schema,
  EnforcementSchema,
  CheckNodeSchema,
  UnknownCheckKindError,
  type InvariantEntryV3,
} from '../../../src/architecture/invariant-schema.js';

describe('InvariantEntryV3Schema', () => {
  /** A minimal entry holds only the required fields. Each absent v3 field parses to `undefined`. */
  it('InvariantSchemaV3_AllFieldsOptional_ParsesMinimalEntry', () => {
    const minimal = {
      id: 'INV-1',
      dimension: 'Sandbox isolation',
      axis: 'substrate',
      'cost-of-load': 'always-load',
      'applies-to': ['servers/exarchos-mcp/**'],
      summary: 'Some invariant summary.',
      references: ['docs/architecture/invariants.md'],
    };

    const parsed: InvariantEntryV3 = InvariantEntryV3Schema.parse(minimal);

    expect(parsed.id).toBe('INV-1');
    expect(parsed.axis).toBe('substrate');
    expect(parsed['cost-of-load']).toBe('always-load');
    expect(parsed['phase-affinity']).toBeUndefined();
    expect(parsed['workflow-affinity']).toBeUndefined();
    expect(parsed['state-affinity']).toBeUndefined();
    expect(parsed.enforcement).toBeUndefined();
    expect(parsed.severity).toBeUndefined();
    expect(parsed['integrity-class']).toBeUndefined();
  });

  /** The schema accepts the workflow token `discovery` and rejects `discover`, which matches no workflow type. */
  it('InvariantSchema_WorkflowAffinityDiscovery_Validates', () => {
    const base = {
      id: 'INV-9',
      dimension: 'Discovery affinity',
      axis: 'authoring',
      'cost-of-load': 'always-load',
      'applies-to': ['docs/**'],
      summary: 'Discovery-scoped invariant.',
      references: ['docs/architecture/invariants.md'],
    };
    expect(
      InvariantEntryV3Schema.safeParse({ ...base, 'workflow-affinity': ['discovery'] }).success,
    ).toBe(true);
    expect(
      InvariantEntryV3Schema.safeParse({ ...base, 'workflow-affinity': ['discover'] }).success,
    ).toBe(false);
  });

  /** The schema has no `axiom-overlap` field, so a rich entry must parse without it. */
  it('InvariantSchemaV3_AcceptsAllV3Fields_ParsesRichEntry', () => {
    const rich = {
      id: 'INV-4',
      dimension: 'Declarative enforcement',
      axis: 'substrate',
      'cost-of-load': 'reference-only',
      'applies-to': ['servers/**'],
      summary: 'Enforcement is declarative-only.',
      references: ['docs/architecture/invariants.md'],
      citations: ['some-paper-2024'],
      'phase-affinity': ['delegate', 'review'],
      'workflow-affinity': ['feature', 'refactor'],
      'state-affinity': ['delegated', 'in-review'],
      'integrity-class': 'substrate',
      severity: {
        default: 'blocking',
        'by-workflow': { discovery: 'advisory' },
        'by-phase': { ideate: 'advisory' },
      },
      enforcement: {
        mode: 'check',
        check: { kind: 'grep', pattern: 'TODO' },
      },
    };

    const parsed = InvariantEntryV3Schema.parse(rich);
    expect(parsed['phase-affinity']).toEqual(['delegate', 'review']);
    expect(parsed['integrity-class']).toBe('substrate');
    expect(parsed.severity?.default).toBe('blocking');
    expect(parsed.enforcement?.mode).toBe('check');
  });
});

describe('EnforcementSchema', () => {
  /** An `all-of` node with two grep leaves is a valid combinator tree. */
  it('EnforcementSchema_CheckMode_AcceptsCombinatorTree', () => {
    const enforcement = {
      mode: 'check',
      check: {
        'all-of': [
          { kind: 'grep', pattern: 'foo' },
          { kind: 'grep', pattern: 'bar', fileGlob: '*.ts' },
        ],
      },
    };
    expect(() => EnforcementSchema.parse(enforcement)).not.toThrow();
  });

  it('EnforcementSchema_AuditMode_AcceptsAuditPrompt', () => {
    const enforcement = {
      mode: 'audit',
      'audit-prompt': 'Does this design respect the sandbox boundary?',
    };
    expect(() => EnforcementSchema.parse(enforcement)).not.toThrow();
  });

  /** A check leaf is strict, so a leaf with an embedded executable key such as `script` fails validation. */
  it('EnforcementSchema_RejectsEmbeddedExecutable', () => {
    const malicious = {
      mode: 'check',
      check: { kind: 'grep', pattern: 'foo', script: 'rm -rf /' },
    };
    expect(() => EnforcementSchema.parse(malicious)).toThrow();
  });
});

describe('CheckNodeSchema fail-closed', () => {
  /** An unknown leaf `kind` throws `UnknownCheckKindError` at parse time, before the evaluator can run. */
  it('EvaluateTree_UnknownKind_ThrowsAtLoadNotEval', () => {
    const bogus = { kind: 'bogus', pattern: 'foo' };
    expect(() => CheckNodeSchema.parse(bogus)).toThrow(UnknownCheckKindError);
  });
});
