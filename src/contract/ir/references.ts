/**
 * The dangling-reference resolver of the shared admission IR. The schema in `admission-ir.ts` proves
 * that a document is closed. This module proves that its references resolve, which JSON Schema and
 * Zod cannot express. It runs over a document that is already structurally valid.
 *
 * - Policy refs (`edge.admits`) resolve to a policy in the same document.
 * - Requirement refs (`policy.requires`, `waiver.waives`, `corroboration.sourceRequirementId`)
 *   resolve to a requirement in the same document.
 * - Action refs (`edge.effect.actionRef`, `policy.onDeny`) resolve to a live Exarchos ActionId from
 *   the registry projection. Tests can inject their own set.
 *
 * A duplicate policy or requirement id is also a violation, because it makes the target ambiguous.
 */

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
   * The set of resolvable Exarchos ActionIds. The default is the live registry projection. Tests
   * inject a set, so they do not depend on the live registry.
   */
  readonly actionIds?: ReadonlySet<string>;
}

let cachedActionIds: ReadonlySet<string> | undefined;

/**
 * The live `<tool>.<action>` set from the registry projection. It is memoized, because the
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
 * Resolves every policy, requirement, and action reference in a structurally valid document. It
 * returns every violation, so one pass reports every dangling reference. It does not change the
 * document.
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
