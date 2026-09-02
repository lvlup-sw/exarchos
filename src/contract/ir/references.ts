// ─── Shared admission IR — dangling-reference resolver (P03-06) ──────────────
//
// PROGRAM-03, API-007 (exit-proof half 2: "reject dangling references"). The
// structural schema (`admission-ir.ts`) proves a document is CLOSED; this module
// proves it is REFERENTIALLY SOUND. JSON Schema / Zod cannot express cross-object
// resolution, so reference checking is a distinct SEMANTIC layer that runs over
// an already-structurally-valid document.
//
// Three reference classes are resolved:
//
//   • POLICY refs      (`edge.admits`)                    → a policy DEFINED in
//                                                            the same document.
//   • REQUIREMENT refs (`policy.requires`, `waiver.waives`,
//                        `corroboration.sourceRequirementId`)
//                                                          → a requirement
//                                                            DEFINED in the doc.
//   • ACTION refs      (`edge.effect.actionRef`,
//                        `policy.onDeny`)                  → a REAL Exarchos
//                                                            ActionId (P03-04).
//
// The ActionId source is the LIVE registry projection (`deriveRegistrationFrom
// Registry` + `registrationActionRefs`, P03-04) — the same `<tool>.<action>`
// set the binding verifier resolves against — so a reference to an action that
// does not exist is caught here rather than at some later binding step. A
// custom set is injectable for deterministic tests.
//
// Duplicate DEFINITION ids are also a violation: an ambiguous ref target (two
// policies / requirements sharing an id) cannot be soundly resolved.
// ────────────────────────────────────────────────────────────────────────────

import {
  deriveRegistrationFromRegistry,
  registrationActionRefs,
} from '../bindings/generate-registration.js';
import type { AdmissionIrDocumentV1 } from './admission-ir.js';

/** The kind of reference-integrity violation found. */
export type ReferenceViolationKind =
  | 'dangling-policy'
  | 'dangling-requirement'
  | 'dangling-action'
  | 'duplicate-policy-id'
  | 'duplicate-requirement-id';

/** A single, path-annotated reference-integrity violation. */
export interface ReferenceViolation {
  readonly kind: ReferenceViolationKind;
  /** The offending reference / id value. */
  readonly ref: string;
  /** A JSON-ish path locating where the offending reference lives. */
  readonly at: string;
  readonly message: string;
}

/** The verdict from resolving every reference in a document. */
export interface ReferenceVerdict {
  /** `true` iff there are zero violations — the document is referentially sound. */
  readonly ok: boolean;
  readonly violations: readonly ReferenceViolation[];
}

/** Options for {@link resolveReferences}. */
export interface ResolveReferencesOptions {
  /**
   * The set of resolvable Exarchos ActionIds. Defaults (lazily) to the live
   * registry projection (P03-04). Injectable so tests are deterministic and do
   * not depend on the exact live registry contents.
   */
  readonly actionIds?: ReadonlySet<string>;
}

let cachedActionIds: ReadonlySet<string> | undefined;

/**
 * The live set of resolvable Exarchos ActionIds — the P03-04
 * `<tool>.<action>` set, derived from the registry projection. Memoized: the
 * projection is pure and stable within a process.
 */
export function liveActionIdSet(): ReadonlySet<string> {
  if (cachedActionIds === undefined) {
    const refs = registrationActionRefs(deriveRegistrationFromRegistry());
    cachedActionIds = new Set(refs.map((r) => r.actionId));
  }
  return cachedActionIds;
}

function collectDefinitionIds(
  ids: readonly string[],
  kind: 'duplicate-policy-id' | 'duplicate-requirement-id',
  at: string,
  violations: ReferenceViolation[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      violations.push({
        kind,
        ref: id,
        at,
        message: `duplicate definition id ${JSON.stringify(id)} — an ambiguous reference target`,
      });
    }
    seen.add(id);
  }
  return seen;
}

/**
 * Resolve every policy / requirement / action reference in a
 * STRUCTURALLY-VALID document. Returns all violations (never short-circuits) so
 * a single pass reports every dangling reference. Purely functional: no
 * document mutation, no I/O beyond the (memoized) ActionId projection.
 */
export function resolveReferences(
  doc: AdmissionIrDocumentV1,
  opts: ResolveReferencesOptions = {},
): ReferenceVerdict {
  const violations: ReferenceViolation[] = [];
  const actionIds = opts.actionIds ?? liveActionIdSet();

  const policyIds = collectDefinitionIds(
    doc.policies.map((p) => p.policyId),
    'duplicate-policy-id',
    'policies',
    violations,
  );
  const requirementIds = collectDefinitionIds(
    doc.requirements.map((r) => r.requirementId),
    'duplicate-requirement-id',
    'requirements',
    violations,
  );

  const requireRequirement = (ref: string, at: string): void => {
    if (!requirementIds.has(ref)) {
      violations.push({
        kind: 'dangling-requirement',
        ref,
        at,
        message: `requirement reference ${JSON.stringify(ref)} resolves to no defined requirement`,
      });
    }
  };
  const requireAction = (ref: string, at: string): void => {
    if (!actionIds.has(ref)) {
      violations.push({
        kind: 'dangling-action',
        ref,
        at,
        message: `action reference ${JSON.stringify(ref)} resolves to no known Exarchos ActionId`,
      });
    }
  };

  doc.policies.forEach((policy, i) => {
    policy.requires.forEach((ref, j) =>
      requireRequirement(ref, `policies[${i}].requires[${j}]`),
    );
    policy.onDeny.forEach((ref, j) => requireAction(ref, `policies[${i}].onDeny[${j}]`));
  });

  doc.requirements.forEach((req, i) => {
    if (req.kind === 'corroboration') {
      requireRequirement(req.sourceRequirementId, `requirements[${i}].sourceRequirementId`);
    }
  });

  doc.edges.forEach((edge, i) => {
    if (!policyIds.has(edge.admits)) {
      violations.push({
        kind: 'dangling-policy',
        ref: edge.admits,
        at: `edges[${i}].admits`,
        message: `policy reference ${JSON.stringify(edge.admits)} resolves to no defined policy`,
      });
    }
    requireAction(edge.effect.actionRef, `edges[${i}].effect.actionRef`);
  });

  doc.waivers.forEach((waiver, i) => {
    waiver.waives.forEach((ref, j) => requireRequirement(ref, `waivers[${i}].waives[${j}]`));
  });

  return { ok: violations.length === 0, violations };
}
