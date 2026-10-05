/**
 * Self-test for the audit-delivery closure audit. `audit-delivery-closure.ts` is a library, so
 * this file is the guard. It holds the live proof and the kill fixtures. CI runs it on the
 * unfiltered `grep-gates` job, so a guard that fails to run exits non-zero.
 *
 * The kill fixtures reproduce a vacuous `outputSchema` and a reader that never names the field.
 * Both must fail, because a guard with no failing subject is not proven.
 *
 * The audit compares two independent sources. The first is the Zod objects that the live tool
 * registry builds at import. The second is the reader documents under `content`, which the audit
 * reads as text and which are not in the import graph. The obligation record is the specification
 * and not an oracle, because the registry imports it transitively.
 */
// @oracle-sources: ../../../src/registry.ts, the reader documents on disk that each obligation names under content which are read as text at audit time and appear nowhere in the static import graph
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { EnvelopeSchema } from '../../../src/contract/schemas/envelope.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import { withCappedShape } from '../../../src/output-schema-declaration.js';
import {
  AUDIT_DELIVERY_OBLIGATIONS,
  requiredDirectiveTokens,
  type AuditDeliveryObligation,
} from '../../../src/architecture/audit-delivery-closure.data.js';
import {
  auditDeliveryClosure,
  formatDeliveryClosureReport,
  hasColocatedDirective,
  inspectContractField,
  splitIntoSections,
  type ClosureFindingCode,
  type ClosureTool,
} from '../../../src/architecture/audit-delivery-closure.js';

const OBLIGATION: AuditDeliveryObligation = {
  id: 'fixture-obligation',
  declarationId: 'fixture_tool.fixture_action',
  actionName: 'fixture_action',
  field: 'auditPrompt',
  enumerator: 'auditInvariantIds',
  reentry: { action: 'check_review_verdict', parameter: 'pluginFindings' },
  readers: ['fixture/READER.md'],
  expectation: 'judge every id and re-enter violations',
};

/** A substantive contract. Both delivered fields are required and typed. */
const TYPED_DATA = z
  .object({
    auditPrompt: z.string(),
    auditInvariantIds: z.array(z.string()),
  })
  .passthrough();

function toolWith(dataSchema: z.ZodType): readonly ClosureTool[] {
  return [
    {
      name: 'fixture_tool',
      actions: [{ name: 'fixture_action', outputSchema: EnvelopeSchema(dataSchema) }],
    },
  ];
}

/**
 * A reader that holds every derived token inside one section. Each failing fixture changes one
 * property of this baseline, so each finding has one cause.
 */
const WIRED_READER = [
  '# Review',
  '',
  '## Something else entirely',
  '',
  'Unrelated prose.',
  '',
  '### Invariant conformance',
  '',
  'Run `fixture_action` over the diff. Answer every id in `auditInvariantIds`',
  'by reading its block in `auditPrompt`, and pass each violation in',
  '`pluginFindings` on `check_review_verdict`.',
  '',
].join('\n');

function readerCorpus(body: string | undefined) {
  return (path: string): string | undefined =>
    path === 'fixture/READER.md' ? body : undefined;
}

function codesOf(findings: readonly { code: ClosureFindingCode }[]): ClosureFindingCode[] {
  return findings.map((f) => f.code);
}

describe('audit-delivery closure — live proof (DR-4/DR-24, task 069)', () => {
  /** The counts must be non-zero, because an audit that enumerates nothing also has no findings. */
  it('AuditDeliveryClosure_LiveObligations_AreClosed', () => {
    const report = auditDeliveryClosure();

    expect(report.findings, formatDeliveryClosureReport(report)).toEqual([]);
    expect(report.ok).toBe(true);

    expect(report.obligationCount).toBeGreaterThanOrEqual(1);
    expect(report.readerCount).toBeGreaterThanOrEqual(1);
    expect(report.closed).toHaveLength(report.obligationCount);
  });

  /** The fixture tests inject the obligations and the tools. The defaults must be the live artifacts. */
  it('AuditDeliveryClosure_Defaults_AreTheLiveArtifacts', () => {
    const explicit = auditDeliveryClosure({
      obligations: AUDIT_DELIVERY_OBLIGATIONS,
      tools: TOOL_REGISTRY,
    });
    const defaulted = auditDeliveryClosure();
    expect(defaulted.obligationCount).toBe(explicit.obligationCount);
    expect(defaulted.readerCount).toBe(explicit.readerCount);
    expect([...defaulted.closed]).toEqual([...explicit.closed]);
  });

  /** The live obligations must govern `check_invariant_conformance`, the gate that returns `auditPrompt`. */
  it('AuditDeliveryClosure_LiveObligation_GovernsTheConformanceGate', () => {
    const live = AUDIT_DELIVERY_OBLIGATIONS.find(
      (o) => o.declarationId === 'exarchos_orchestrate.check_invariant_conformance',
    );
    expect(live).toBeDefined();
    expect(live?.field).toBe('auditPrompt');
    expect(live?.readers.length).toBeGreaterThanOrEqual(1);
  });
});

describe('audit-delivery closure — kill fixtures', () => {
  /**
   * The contract half. The output schema is `EnvelopeSchema(z.unknown())`, which a waived
   * declaration has by default. That schema accepts every payload, so a reader cannot rely on the
   * field. The audit reports both delivered properties, not only the first.
   */
  it('AuditDeliveryClosure_PreTask069VacuousContract_IsRed', () => {
    const report = auditDeliveryClosure({
      obligations: [OBLIGATION],
      tools: toolWith(z.unknown()),
      readReader: readerCorpus(WIRED_READER),
    });

    expect(report.ok).toBe(false);
    expect(codesOf(report.findings)).toEqual(['VACUOUS_CONTRACT', 'VACUOUS_CONTRACT']);
    expect(report.closed).toEqual([]);
  });

  /**
   * The instruction half. The reader invokes the action and never names the field that it returns.
   * An invocation is not an instruction to act on the result.
   */
  it('AuditDeliveryClosure_ReaderThatOnlyInvokesTheGate_IsRed', () => {
    const invokeOnly = [
      '# Shepherd',
      '',
      '## Request approval',
      '',
      'Run the `fixture_action` action over the PR diff before requesting approval,',
      'so the merge-gate read of the architectural invariants matches the diff.',
      '',
    ].join('\n');

    const report = auditDeliveryClosure({
      obligations: [OBLIGATION],
      tools: toolWith(TYPED_DATA),
      readReader: readerCorpus(invokeOnly),
    });

    expect(report.ok).toBe(false);
    expect(codesOf(report.findings)).toEqual(['FIELD_NOT_MENTIONED']);
  });

  /**
   * One section must hold every token. Without that rule the guard is a whole-file search, and a
   * document that names `check_review_verdict` and `auditPrompt` in different sections passes.
   */
  it('AuditDeliveryClosure_ScatteredMentions_AreNotADirective', () => {
    const scattered = [
      '# Review',
      '',
      '## Gates',
      '',
      'Run `fixture_action`. It returns `auditPrompt` and `auditInvariantIds`.',
      '',
      '## Verdict',
      '',
      'Pass `pluginFindings` to `check_review_verdict`.',
      '',
    ].join('\n');

    const report = auditDeliveryClosure({
      obligations: [OBLIGATION],
      tools: toolWith(TYPED_DATA),
      readReader: readerCorpus(scattered),
    });

    expect(report.ok).toBe(false);
    expect(codesOf(report.findings)).toEqual(['DIRECTIVE_NOT_COLOCATED']);
  });

  /**
   * A reader cannot iterate an optional field on every response. An optional `auditInvariantIds`
   * passes the type check and counts as substantive, so the contract half must reject it.
   */
  it('AuditDeliveryClosure_OptionalDeliveredField_IsRed', () => {
    const halfTyped = z
      .object({
        auditPrompt: z.string(),
        auditInvariantIds: z.array(z.string()).optional(),
      })
      .passthrough();

    const report = auditDeliveryClosure({
      obligations: [OBLIGATION],
      tools: toolWith(halfTyped),
      readReader: readerCorpus(WIRED_READER),
    });

    expect(report.ok).toBe(false);
    expect(codesOf(report.findings)).toEqual(['FIELD_OPTIONAL_IN_CONTRACT']);
  });

  /**
   * The contract and the reader each bind to the obligation record, not to each other.
   * A renamed field in the record thus fails both halves, so a rename cannot strand an instruction.
   */
  it('AuditDeliveryClosure_RenamedField_UnbindsBothRepresentations', () => {
    const renamed: AuditDeliveryObligation = { ...OBLIGATION, field: 'auditText' };
    const report = auditDeliveryClosure({
      obligations: [renamed],
      tools: toolWith(TYPED_DATA),
      readReader: readerCorpus(WIRED_READER),
    });

    expect(report.ok).toBe(false);
    expect(codesOf(report.findings)).toEqual([
      'FIELD_NOT_IN_CONTRACT',
      'FIELD_NOT_MENTIONED',
    ]);
  });

  it('AuditDeliveryClosure_ProducerRenamed_IsRedNotSkipped', () => {
    const report = auditDeliveryClosure({
      obligations: [OBLIGATION],
      tools: [{ name: 'fixture_tool', actions: [] }],
      readReader: readerCorpus(WIRED_READER),
    });
    expect(codesOf(report.findings)).toEqual(['DECLARATION_NOT_FOUND']);
  });

  it('AuditDeliveryClosure_MissingReaderFile_IsRedNotSkipped', () => {
    const report = auditDeliveryClosure({
      obligations: [OBLIGATION],
      tools: toolWith(TYPED_DATA),
      readReader: readerCorpus(undefined),
    });
    expect(codesOf(report.findings)).toEqual(['READER_MISSING']);
  });

  it('AuditDeliveryClosure_EmptyReaderDocument_IsRed', () => {
    const report = auditDeliveryClosure({
      obligations: [OBLIGATION],
      tools: toolWith(TYPED_DATA),
      readReader: readerCorpus('   \n\n  '),
    });
    expect(codesOf(report.findings)).toEqual(['READER_EMPTY']);
  });
});

describe('audit-delivery closure — non-empty denominator', () => {
  /** An audit over zero obligations passes every per-obligation check, so the empty list itself must fail. */
  it('AuditDeliveryClosure_ZeroObligations_FailsRatherThanReportsClean', () => {
    const report = auditDeliveryClosure({ obligations: [], tools: toolWith(TYPED_DATA) });
    expect(report.ok).toBe(false);
    expect(codesOf(report.findings)).toEqual(['EMPTY_OBLIGATIONS']);
    expect(report.obligationCount).toBe(0);
  });

  it('AuditDeliveryClosure_ObligationWithNoReader_Fails', () => {
    const readerless: AuditDeliveryObligation = { ...OBLIGATION, readers: [] };
    const report = auditDeliveryClosure({
      obligations: [readerless],
      tools: toolWith(TYPED_DATA),
    });
    expect(report.ok).toBe(false);
    expect(codesOf(report.findings)).toEqual(['NO_READER_DECLARED']);
  });

  /** The predicate itself rejects an empty token list. It does not rely on its caller for that check. */
  it('HasColocatedDirective_EmptyTokenList_IsNotSatisfied', () => {
    expect(hasColocatedDirective(WIRED_READER, [])).toBe(false);
    expect(hasColocatedDirective('', [])).toBe(false);
  });
});

describe('audit-delivery closure — derivations', () => {
  /**
   * The obligations load from the data module. `requiredDirectiveTokens` derives the token list
   * from each record, so one source says what an instruction must name.
   */
  it('AuditDeliveryClosure_PolicyIsData_NotTestPredicate', () => {
    expect(AUDIT_DELIVERY_OBLIGATIONS.length).toBeGreaterThanOrEqual(1);
    for (const obligation of AUDIT_DELIVERY_OBLIGATIONS) {
      expect([...requiredDirectiveTokens(obligation)]).toEqual([
        obligation.actionName,
        obligation.field,
        obligation.enumerator,
        obligation.reentry.action,
        obligation.reentry.parameter,
      ]);
    }
  });

  it('SplitIntoSections_EachHeading_OpensASection', () => {
    const sections = splitIntoSections(['pre', '# A', 'a', '## B', 'b'].join('\n'));
    expect(sections).toHaveLength(3);
    expect(sections[0]).toBe('pre');
    expect(sections[1]).toContain('# A');
    expect(sections[2]).toContain('## B');
  });

  /**
   * A `#` inside a fenced block is a shell comment or a Markdown example, not a heading.
   * A split at that line divides a directive, and then a correct reader fails.
   */
  it('SplitIntoSections_HashInsideFencedBlock_DoesNotOpenASection', () => {
    const doc = ['# A', '```bash', '# not a heading', 'echo hi', '```', 'tail'].join('\n');
    expect(splitIntoSections(doc)).toHaveLength(2);
  });

  /**
   * `withCappedShape` adds the capped-response fallback to `data`, so the live `data` is a union.
   * The inspector must read the payload branch of the action, which declares the fields.
   */
  it('InspectContractField_CappedShapeUnion_StillSeesTheRequiredField', () => {
    const declared = withCappedShape(EnvelopeSchema(TYPED_DATA));
    expect(inspectContractField(declared, 'auditPrompt')).toBe('required');
    expect(inspectContractField(declared, 'auditInvariantIds')).toBe('required');
    expect(inspectContractField(declared, 'neverDeclared')).toBe('absent');
  });

  it('InspectContractField_VacuousAndUnreadable_AreDistinguished', () => {
    expect(inspectContractField(EnvelopeSchema(z.unknown()), 'auditPrompt')).toBe('vacuous');
    expect(inspectContractField(EnvelopeSchema(z.any()), 'auditPrompt')).toBe('vacuous');
    expect(inspectContractField(z.object({ nope: z.string() }), 'auditPrompt')).toBe(
      'unreadable',
    );
  });

  it('FormatDeliveryClosureReport_StatesTheCountAgainstItsDenominator', () => {
    const red = auditDeliveryClosure({
      obligations: [OBLIGATION],
      tools: toolWith(z.unknown()),
      readReader: readerCorpus(WIRED_READER),
    });
    const rendered = formatDeliveryClosureReport(red);
    expect(rendered).toContain('0 closed of 1 obligation(s)');
    expect(rendered).toContain('VACUOUS_CONTRACT');
  });
});
