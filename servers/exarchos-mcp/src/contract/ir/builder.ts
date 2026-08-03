// ─── Shared admission IR — builder lowering (P03-06) ─────────────────────────
//
// PROGRAM-03, API-007 (transition tasks 033, 047). A small, fluent BUILDER that
// LOWERS an authoring model down to the shared admission IR wire document. The
// builder normalizes (deterministically SORTS every collection by its stable
// id, so two builds of the same inputs are byte-identical) and then validates —
// STRUCTURALLY against the authored Zod schema, and (via `build()`) REFERENTIALLY
// against the dangling-reference resolver.
//
// ## The P07-03 seam
//
// This package owns lowering *to the shared IR* and stops there. The later
// package **P07-03 "Builder lowering and decision parity"** owns comparing
// COMPILED DECISIONS: it will take the shared IR this builder produces, run it
// through the runtime admission evaluator (`policy-evaluation.ts` et al.), and
// assert the decision matches a reference. The clean seam is exactly the
// `AdmissionIrDocumentV1` value returned by {@link AdmissionIrBuilder.lower}:
//   • everything UP TO the validated wire document is P03-06 (here);
//   • everything DOWNSTREAM (decision compilation + parity) is P07-03.
// The builder therefore deliberately performs NO decision evaluation and holds
// no runtime state — it is pure lowering.
// ────────────────────────────────────────────────────────────────────────────

import type { z } from 'zod';
import {
  AdmissionIrDocumentV1Schema,
  type AdmissionIrDocumentV1,
  type EdgeDefinition,
  type PolicyDefinition,
  type RequirementDefinition,
  type WaiverDefinition,
} from './admission-ir.js';
import {
  resolveReferences,
  type ReferenceVerdict,
  type ResolveReferencesOptions,
} from './references.js';

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A structural lowering failure — the assembled document is not valid IR. */
export class AdmissionIrLoweringError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];
  constructor(error: z.ZodError) {
    super(`admission IR lowering failed: ${error.issues.length} structural issue(s)`);
    this.name = 'AdmissionIrLoweringError';
    this.issues = error.issues;
  }
}

/** The result of a full {@link AdmissionIrBuilder.build}: the lowered doc + ref verdict. */
export interface AdmissionIrBuildResult {
  readonly document: AdmissionIrDocumentV1;
  readonly references: ReferenceVerdict;
}

/**
 * A fluent builder that lowers admission-surface parts to a shared IR document.
 * Collections accumulate in insertion order and are sorted deterministically at
 * {@link lower} time, so the produced document is independent of add order.
 */
export class AdmissionIrBuilder {
  #workflowId: string | undefined;
  readonly #policies: PolicyDefinition[] = [];
  readonly #requirements: RequirementDefinition[] = [];
  readonly #edges: EdgeDefinition[] = [];
  readonly #waivers: WaiverDefinition[] = [];

  /** Set the workflow identity the IR document is scoped to. */
  workflow(workflowId: string): this {
    this.#workflowId = workflowId;
    return this;
  }

  /** Add an admission-policy definition. */
  policy(policy: PolicyDefinition): this {
    this.#policies.push(policy);
    return this;
  }

  /** Add an evidence-requirement definition. */
  requirement(requirement: RequirementDefinition): this {
    this.#requirements.push(requirement);
    return this;
  }

  /** Add a gated edge definition (closed condition + policy/action references). */
  edge(edge: EdgeDefinition): this {
    this.#edges.push(edge);
    return this;
  }

  /** Add a waiver definition. */
  waiver(waiver: WaiverDefinition): this {
    this.#waivers.push(waiver);
    return this;
  }

  /**
   * Lower the accumulated parts to a validated, deterministically-ordered shared
   * IR document. Throws {@link AdmissionIrLoweringError} if the assembled shape
   * is not structurally valid IR. This is the P03-06 → P07-03 handoff value.
   */
  lower(): AdmissionIrDocumentV1 {
    const candidate = {
      irVersion: '1',
      workflowId: this.#workflowId ?? '',
      policies: [...this.#policies].sort((a, b) => byString(a.policyId, b.policyId)),
      requirements: [...this.#requirements].sort((a, b) =>
        byString(a.requirementId, b.requirementId),
      ),
      edges: [...this.#edges].sort((a, b) => byString(a.edgeId, b.edgeId)),
      waivers: [...this.#waivers].sort((a, b) => byString(a.waiverId, b.waiverId)),
    };
    const parsed = AdmissionIrDocumentV1Schema.safeParse(candidate);
    if (!parsed.success) {
      throw new AdmissionIrLoweringError(parsed.error);
    }
    return parsed.data;
  }

  /**
   * Lower AND resolve references. Structural failure still throws; a structurally
   * valid but referentially unsound document is returned with a failing
   * {@link ReferenceVerdict} so the caller can inspect every dangling reference.
   */
  build(opts?: ResolveReferencesOptions): AdmissionIrBuildResult {
    const document = this.lower();
    return { document, references: resolveReferences(document, opts) };
  }
}

/** The result of a full consumer-side validation (structure + references). */
export type AdmissionIrValidation =
  | { readonly ok: true; readonly document: AdmissionIrDocumentV1 }
  | { readonly ok: false; readonly stage: 'structure'; readonly error: z.ZodError }
  | { readonly ok: false; readonly stage: 'references'; readonly references: ReferenceVerdict };

/**
 * The full "Exarchos consumes the shared IR" entry point: structurally validate
 * an untrusted value, then resolve its references. A document must pass BOTH to
 * be accepted — this is exactly the pairing the exit proof requires (round-trip
 * structural validity + no dangling references).
 */
export function validateAdmissionIrDocument(
  input: unknown,
  opts?: ResolveReferencesOptions,
): AdmissionIrValidation {
  const parsed = AdmissionIrDocumentV1Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, stage: 'structure', error: parsed.error };
  }
  const references = resolveReferences(parsed.data, opts);
  if (!references.ok) {
    return { ok: false, stage: 'references', references };
  }
  return { ok: true, document: parsed.data };
}
