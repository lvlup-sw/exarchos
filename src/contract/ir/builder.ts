/**
 * A fluent builder that lowers an authoring model to the shared admission IR document.
 * It sorts every collection by its stable id, so two builds of the same inputs are byte-identical.
 * It then validates the structure against the Zod schema, and `build()` also resolves references.
 * The builder does no decision evaluation and holds no runtime state.
 */

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

/** The result of {@link AdmissionIrBuilder.build}: the lowered document and the reference verdict. */
export interface AdmissionIrBuildResult {
  readonly document: AdmissionIrDocumentV1;
  readonly references: ReferenceVerdict;
}

/**
 * A fluent builder that lowers admission-surface parts to a shared IR document.
 * {@link lower} sorts the collections, so the add order does not change the document.
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

  /** Add a gated edge definition. */
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
   * Lowers the parts to a validated, sorted shared IR document.
   * It throws {@link AdmissionIrLoweringError} when the shape is not valid IR.
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
   * Lowers the parts and resolves references. A structural failure throws.
   * A document with dangling references returns with a failing {@link ReferenceVerdict}.
   */
  build(opts?: ResolveReferencesOptions): AdmissionIrBuildResult {
    const document = this.lower();
    return { document, references: resolveReferences(document, opts) };
  }
}

/** The result of a consumer-side validation of structure and references. */
export type AdmissionIrValidation =
  | { readonly ok: true; readonly document: AdmissionIrDocumentV1 }
  | { readonly ok: false; readonly stage: 'structure'; readonly error: z.ZodError }
  | { readonly ok: false; readonly stage: 'references'; readonly references: ReferenceVerdict };

/**
 * The entry point for an Exarchos consumer of the shared IR. It validates the structure of an
 * untrusted value, then resolves its references. A document must pass both checks.
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
