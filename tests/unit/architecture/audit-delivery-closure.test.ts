/**
 * Self-test for the audit-delivery closure audit (DR-4/DR-24, task 069).
 *
 * `audit-delivery-closure.ts` is a pure library, so THIS FILE IS THE GUARD: it
 * carries both the live proof and the kill fixtures, and CI hosts it on the
 * unfiltered `grep-gates` job so guard-execution failure exits non-zero here
 * rather than passing as success.
 *
 * ── The subject ─────────────────────────────────────────────────────────────
 * Before task 069, `check_invariant_conformance` computed `auditPrompt` from
 * every applicable audit-mode invariant and returned it through
 * `outputSchema: vacuityWaiver(...)`. The field occurred in exactly five files
 * repo-wide — the producer plus four of its own tests. Both halves of that state
 * are reproduced below as fixtures, and both are RED. A guard with no
 * demonstrated failing subject has not been shown to work.
 *
 * ── The two oracles (DR-30) ─────────────────────────────────────────────────
 * The obligation record is the SPECIFICATION, not an oracle — and it is not
 * independent of the registry anyway: `registry.ts` reaches it transitively
 * (`registry → views/lifecycle/inspect → core/dispatch → verbs/composite
 * → check-invariant-conformance → audit-delivery-closure.data`), because the
 * handler renders its report directive from the same record. The two authorities
 * this audit actually COMPARES are independent of each other:
 *   A. the Zod objects the live tool registry constructs at import time — what
 *      the boundary really declares;
 *   B. the reader documents on disk under content, which are not in the
 *      import graph at all and are read as text at audit time.
 * Neither is computed from the other, so their agreement is evidence.
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

/** A substantive contract: both delivered fields required and typed. */
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
 * A reader that DOES carry the instruction — every derived token inside one
 * section. The baseline the RED fixtures are varied away from, so each finding
 * is attributable to the single property that changed.
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

// ─── The live proof ──────────────────────────────────────────────────────────

describe('audit-delivery closure — live proof (DR-4/DR-24, task 069)', () => {
  it('AuditDeliveryClosure_LiveObligations_AreClosed', () => {
    const report = auditDeliveryClosure();

    expect(report.findings, formatDeliveryClosureReport(report)).toEqual([]);
    expect(report.ok).toBe(true);

    // Non-empty denominator, asserted rather than assumed: an audit that
    // enumerated nothing would satisfy `findings === []` too.
    expect(report.obligationCount).toBeGreaterThanOrEqual(1);
    expect(report.readerCount).toBeGreaterThanOrEqual(1);
    expect(report.closed).toHaveLength(report.obligationCount);
  });

  /**
   * A guard proven only through its injected seams has been proven about its
   * seams. The live defaults must BE the live artifacts.
   */
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

  /**
   * The obligation that motivated the task, named explicitly: the live gate must
   * really be the one under audit, not a fixture that happens to be green.
   */
  it('AuditDeliveryClosure_LiveObligation_GovernsTheConformanceGate', () => {
    const live = AUDIT_DELIVERY_OBLIGATIONS.find(
      (o) => o.declarationId === 'exarchos_orchestrate.check_invariant_conformance',
    );
    expect(live).toBeDefined();
    expect(live?.field).toBe('auditPrompt');
    expect(live?.readers.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Kill fixtures — the pre-069 state, both halves ──────────────────────────

describe('audit-delivery closure — kill fixtures', () => {
  /**
   * HALF 2, THE CONTRACT. `vacuityWaiver()` with no explicit schema returned
   * `EnvelopeSchema(z.unknown())`; that is reproduced verbatim here. The field
   * "exists" on every payload and on none — a reader could not rely on it.
   */
  it('AuditDeliveryClosure_PreTask069VacuousContract_IsRed', () => {
    const report = auditDeliveryClosure({
      obligations: [OBLIGATION],
      tools: toolWith(z.unknown()),
      readReader: readerCorpus(WIRED_READER),
    });

    expect(report.ok).toBe(false);
    // BOTH delivered properties are reported, not just the first.
    expect(codesOf(report.findings)).toEqual(['VACUOUS_CONTRACT', 'VACUOUS_CONTRACT']);
    expect(report.closed).toEqual([]);
  });

  /**
   * HALF 1, THE INSTRUCTION. The shape `content/synthesis/skills/shepherd/SKILL.md` had (and
   * `content/review/skills/review/SKILL.md` did not even have): the document INVOKES the
   * action and never names what it returns. Invoking is not being instructed.
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
   * The co-location rule is what separates an instruction from a coincidence.
   * Without it this guard would be a whole-file grep, and a document that
   * happens to name `check_review_verdict` in one place and `auditPrompt` three
   * sections away would read as wired.
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
   * An OPTIONAL field is not something a reader can be told to iterate. This is
   * the near-miss the contract half has to catch: `auditInvariantIds?: string[]`
   * typechecks, censuses as substantive, and still leaves the instruction
   * unsatisfiable on some responses.
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
   * The two representations are bound to the RECORD, not to each other. Renaming
   * the field in the authority unbinds both halves at once — which is what makes
   * a rename a red build instead of a silently stranded instruction.
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

// ─── Non-empty denominator ───────────────────────────────────────────────────

describe('audit-delivery closure — non-empty denominator', () => {
  /**
   * An audit over zero obligations satisfies every per-obligation check
   * vacuously. That failure mode reads green precisely when the instrument has
   * lost its subject, so it must fail instead.
   */
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

  /**
   * The tooth belongs to the PURE predicate, not to its caller — the exact
   * half-installed-tooth defect task 022 recorded against the CLI guard. An
   * empty token list must not answer `true` for every document.
   */
  it('HasColocatedDirective_EmptyTokenList_IsNotSatisfied', () => {
    expect(hasColocatedDirective(WIRED_READER, [])).toBe(false);
    expect(hasColocatedDirective('', [])).toBe(false);
  });
});

// ─── The derivations the audit rests on ──────────────────────────────────────

describe('audit-delivery closure — derivations', () => {
  /**
   * POLICY IS DATA. The rule set loads from the data module; the token list the
   * instruction check greps for is DERIVED from each record rather than written
   * beside it, so there is one authority for "what an instruction must name".
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
   * A `#` inside a fenced block is a shell comment or a Markdown example, not a
   * heading. Splitting on it would fragment a code sample and could split a
   * directive apart — turning a correctly wired reader red.
   */
  it('SplitIntoSections_HashInsideFencedBlock_DoesNotOpenASection', () => {
    const doc = ['# A', '```bash', '# not a heading', 'echo hi', '```', 'tail'].join('\n');
    expect(splitIntoSections(doc)).toHaveLength(2);
  });

  /**
   * `withCappedShape` unions the capped-response fallback into `data`, so the
   * live contract's `data` is a UNION. The inspector must see through it — the
   * action's own payload branch declares the fields, the capped branch does not.
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
