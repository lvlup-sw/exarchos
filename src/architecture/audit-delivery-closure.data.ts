// ─── Audit-delivery obligations — POLICY AS DATA (DR-4/DR-24, task 069) ──────
//
// THE DEFECT THIS DESCRIBES
//
// `check_invariant_conformance` computed an `auditPrompt` from every applicable
// `enforcement.mode: 'audit'` invariant and returned it. `findings[]`, meanwhile,
// were produced ONLY from `mode: 'check'` combinator trees. So an audit-mode
// invariant contributed text to a field that no skill, command, rule or doc told
// anyone to read — the field occurred in exactly five files repo-wide, of which
// four were its own tests. The render path was live and correct; what was missing
// was a reader under instruction. A prompt nobody is directed to act on is a
// mechanism that ships and is never called, which is this program's declared
// dominant risk (R-11).
//
// WHY THE POLICY IS DATA
//
// The alternative is a test body that says `expect(skillText).toContain('auditPrompt')`.
// That buries the rule inside an assertion, where it cannot be enumerated, cannot
// be reviewed as policy, and cannot be extended without editing a test. This
// module is the single AUTHORITY; `audit-delivery-closure.ts` is a mechanism that
// decides nothing and only reports whether each declared obligation is met.
//
// WHAT AN OBLIGATION BINDS TOGETHER
//
// One authority, two bound representations (the DR-6 authority-topology shape):
//
//   authority        this record
//   representation 1 the action's registered `outputSchema` — must declare the
//                    delivered field AND its enumerator as typed, required
//                    properties, so a reader can rely on them
//   representation 2 the reader document(s) — must carry an instruction that
//                    names the producing action, the field, the enumerator, and
//                    the re-entry seam, ALL INSIDE ONE SECTION
//
// Because both representations are checked against THIS record rather than
// against each other, renaming the field in either place unbinds it and reddens
// the guard, instead of quietly stranding the instruction.
//
// WHY `reentry` IS PART OF THE OBLIGATION
//
// "Read this field" is not an instruction to act; it is an instruction to look.
// An audit-mode judgment has to land somewhere that changes an outcome, and the
// gate's own header comment already named where: the review subagent's answers
// re-enter as `pluginFindings`. That seam exists on `check_review_verdict` and
// always did — the only thing missing was anyone being told to use it. Recording
// it here makes "instructed to act" a checkable property rather than a claim.

/** Where an audit-mode judgment must be re-entered so that it changes an outcome. */
export interface AuditReentrySeam {
  /** The action that consumes the judgment (`check_review_verdict`). */
  readonly action: string;
  /** The parameter carrying it (`pluginFindings`). */
  readonly parameter: string;
}

/**
 * One delivery obligation: a payload field whose whole purpose is to be acted on
 * by a reader, and the reader(s) required to be instructed to do so.
 */
export interface AuditDeliveryObligation {
  /** Stable id, so a finding can be traced back to the record that produced it. */
  readonly id: string;
  /** Census id of the producing declaration — `<tool>.<action>`. */
  readonly declarationId: string;
  /** The action name as a reader document spells it. */
  readonly actionName: string;
  /** The success-branch `data` property carrying the prompt. */
  readonly field: string;
  /**
   * The success-branch `data` property enumerating what the reader must answer.
   * A prompt without an enumerable checklist cannot be audited for completeness:
   * "I read it" and "I answered all of it" would be indistinguishable.
   */
  readonly enumerator: string;
  /** Where the judgment lands. See the module header. */
  readonly reentry: AuditReentrySeam;
  /**
   * Repo-relative reader documents that MUST carry the instruction. These are
   * SOURCES (`content/**`), never rendered outputs — the rendered tree is
   * generated from them and a rule pinned to a generated file would be repaired
   * by re-running the generator.
   */
  readonly readers: readonly string[];
  /** One line naming what the reader is expected to DO, quoted in guard output. */
  readonly expectation: string;
}

/**
 * Every delivery obligation in force.
 *
 * `satisfies` rather than `as const`: it type-checks the literal against the
 * interface without minting a type assertion, which the DR-14 cast census counts
 * (`as const` is an `as` expression; `satisfies` is not).
 */
export const AUDIT_DELIVERY_OBLIGATIONS: readonly AuditDeliveryObligation[] =
  Object.freeze([
    {
      id: 'invariant-conformance-audit-prompt',
      declarationId: 'exarchos_orchestrate.check_invariant_conformance',
      actionName: 'check_invariant_conformance',
      field: 'auditPrompt',
      enumerator: 'auditInvariantIds',
      reentry: { action: 'check_review_verdict', parameter: 'pluginFindings' },
      readers: ['content/review/skills/review/SKILL.md'],
      expectation:
        'judge every id in auditInvariantIds against the diff and re-enter each ' +
        'violation as a pluginFinding on check_review_verdict',
    },
  ]) satisfies readonly AuditDeliveryObligation[];

/**
 * The tokens a reader's instruction must contain, DERIVED from the obligation
 * rather than listed beside it. Two hand-maintained copies of one rule is the
 * multiple-authority defect DR-6 exists to detect, so the token list is computed
 * and never written down.
 */
export function requiredDirectiveTokens(
  obligation: AuditDeliveryObligation,
): readonly string[] {
  return Object.freeze([
    obligation.actionName,
    obligation.field,
    obligation.enumerator,
    obligation.reentry.action,
    obligation.reentry.parameter,
  ]);
}
