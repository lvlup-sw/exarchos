/**
 * Audit-delivery obligations, kept as policy data. `audit-delivery-closure.ts`
 * decides nothing. It only reports whether each obligation here is met.
 *
 * An obligation names a payload field that a reader must act on. Two places must
 * match this record. The `outputSchema` of the action must declare the field and its
 * enumerator as typed, required properties. Each reader document must name the
 * action, the field, the enumerator, and the re-entry seam inside one section.
 * The guard checks both places against this record, so a rename in either place fails the guard.
 *
 * The re-entry seam is where the judgment of the reader lands so that it changes an
 * outcome. An instruction to read a field is not an instruction to act.
 */

/** Where an audit-mode judgment must be re-entered so that it changes an outcome. */
export interface AuditReentrySeam {
  /** The action that consumes the judgment (`check_review_verdict`). */
  readonly action: string;
  /** The parameter carrying it (`pluginFindings`). */
  readonly parameter: string;
}

/**
 * One delivery obligation: a payload field that a reader must act on, and the
 * reader documents that must carry the instruction.
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
   * The success-branch `data` property that lists what the reader must answer.
   * Without this list, nobody can tell "I read it" from "I answered all of it".
   */
  readonly enumerator: string;
  /** Where the judgment lands. See the module header. */
  readonly reentry: AuditReentrySeam;
  /**
   * Repo-relative reader documents that must carry the instruction. They are
   * `content/**` sources, never rendered outputs, because the build regenerates
   * the rendered tree from the sources.
   */
  readonly readers: readonly string[];
  /** One line that says what the reader must do. The guard output quotes it. */
  readonly expectation: string;
}

/**
 * Every delivery obligation in force. The literal uses `satisfies` because the
 * cast census counts `as const` as a type assertion.
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
 * The tokens that a reader instruction must contain. The list derives from the
 * obligation, so the rule has one authority and no hand-kept copy.
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
