import { describe, it, expect } from 'vitest';
import {
  resolveReferences,
  liveActionIdSet,
  type ReferenceViolationKind,
} from '../../../../src/contract/ir/references.js';
import { parseAdmissionIrDocument } from '../../../../src/contract/ir/admission-ir.js';
import { baseValidDoc } from '../../../../src/contract/ir/admission-ir-fixtures.js';
import {
  deriveRegistrationFromRegistry,
  registrationActionRefs,
} from '../../../../src/contract/bindings/generate-registration.js';

/** Parse a raw fixture into a typed document, failing the test if it is malformed. */
function parse(raw: unknown) {
  const result = parseAdmissionIrDocument(raw);
  if (!result.ok) {
    throw new Error(`fixture is not structurally valid: ${result.error.message}`);
  }
  return result.document;
}

/**
 * A fixed action-id set, so the dangling and resolve assertions do not depend on the live registry.
 * The base fixture references `exarchos_event.append`.
 */
const ACTION_IDS = new Set(['exarchos_event.append', 'exarchos_event.query']);

function kinds(violations: readonly { kind: ReferenceViolationKind }[]): ReferenceViolationKind[] {
  return violations.map((v) => v.kind);
}

describe('shared admission IR — dangling-reference rejection (exit proof half 2)', () => {
  it('a referentially sound document resolves with zero violations', () => {
    const verdict = resolveReferences(parse(baseValidDoc()), { actionIds: ACTION_IDS });
    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it('a dangling POLICY reference (edge.admits) FAILS', () => {
    const raw = baseValidDoc();
    const edges = raw['edges'] as Record<string, unknown>[];
    (edges[0] as Record<string, unknown>)['admits'] = 'pol.does-not-exist';
    const verdict = resolveReferences(parse(raw), { actionIds: ACTION_IDS });
    expect(verdict.ok).toBe(false);
    expect(kinds(verdict.violations)).toContain('dangling-policy');
    expect(verdict.violations.some((v) => v.ref === 'pol.does-not-exist')).toBe(true);
  });

  it('a dangling ACTION reference (edge.effect.actionRef) FAILS', () => {
    const raw = baseValidDoc();
    const edges = raw['edges'] as Record<string, unknown>[];
    (edges[0] as Record<string, unknown>)['effect'] = { actionRef: 'nonexistent_tool.nope' };
    const verdict = resolveReferences(parse(raw), { actionIds: ACTION_IDS });
    expect(verdict.ok).toBe(false);
    expect(kinds(verdict.violations)).toContain('dangling-action');
    expect(verdict.violations.some((v) => v.ref === 'nonexistent_tool.nope')).toBe(true);
  });

  it('a dangling ACTION reference in policy.onDeny FAILS', () => {
    const raw = baseValidDoc();
    const policies = raw['policies'] as Record<string, unknown>[];
    (policies[0] as Record<string, unknown>)['onDeny'] = ['definitely.not_an_action'];
    const verdict = resolveReferences(parse(raw), { actionIds: ACTION_IDS });
    expect(verdict.ok).toBe(false);
    expect(kinds(verdict.violations)).toContain('dangling-action');
  });

  it('a dangling REQUIREMENT reference (policy.requires) FAILS', () => {
    const raw = baseValidDoc();
    const policies = raw['policies'] as Record<string, unknown>[];
    (policies[0] as Record<string, unknown>)['requires'] = ['req.ghost'];
    const verdict = resolveReferences(parse(raw), { actionIds: ACTION_IDS });
    expect(verdict.ok).toBe(false);
    expect(kinds(verdict.violations)).toContain('dangling-requirement');
    expect(verdict.violations.some((v) => v.ref === 'req.ghost')).toBe(true);
  });

  it('a dangling REQUIREMENT reference (waiver.waives) FAILS', () => {
    const raw = baseValidDoc();
    const waivers = raw['waivers'] as Record<string, unknown>[];
    (waivers[0] as Record<string, unknown>)['waives'] = ['req.ghost'];
    const verdict = resolveReferences(parse(raw), { actionIds: ACTION_IDS });
    expect(verdict.ok).toBe(false);
    expect(kinds(verdict.violations)).toContain('dangling-requirement');
  });

  it('a dangling REQUIREMENT reference (corroboration.sourceRequirementId) FAILS', () => {
    const raw = baseValidDoc();
    const requirements = raw['requirements'] as Record<string, unknown>[];
    (requirements[2] as Record<string, unknown>)['sourceRequirementId'] = 'req.ghost';
    const verdict = resolveReferences(parse(raw), { actionIds: ACTION_IDS });
    expect(verdict.ok).toBe(false);
    expect(kinds(verdict.violations)).toContain('dangling-requirement');
  });

  /** `policies[1]` and `requirements[1]` each take the id of the first entry in their list. */
  it('duplicate policy/requirement definition ids FAIL (ambiguous ref targets)', () => {
    const raw = baseValidDoc();
    const policies = raw['policies'] as Record<string, unknown>[];
    (policies[1] as Record<string, unknown>)['policyId'] = 'pol.release';
    const requirements = raw['requirements'] as Record<string, unknown>[];
    (requirements[1] as Record<string, unknown>)['requirementId'] = 'req.gate';
    const verdict = resolveReferences(parse(raw), { actionIds: ACTION_IDS });
    expect(verdict.ok).toBe(false);
    expect(kinds(verdict.violations)).toContain('duplicate-policy-id');
    expect(kinds(verdict.violations)).toContain('duplicate-requirement-id');
  });

  it('reports EVERY dangling reference in one pass (does not short-circuit)', () => {
    const raw = baseValidDoc();
    const edges = raw['edges'] as Record<string, unknown>[];
    (edges[0] as Record<string, unknown>)['admits'] = 'pol.ghost';
    (edges[0] as Record<string, unknown>)['effect'] = { actionRef: 'ghost.action' };
    const policies = raw['policies'] as Record<string, unknown>[];
    (policies[0] as Record<string, unknown>)['requires'] = ['req.ghost'];
    const verdict = resolveReferences(parse(raw), { actionIds: ACTION_IDS });
    expect(verdict.violations.length).toBeGreaterThanOrEqual(3);
    expect(new Set(kinds(verdict.violations))).toEqual(
      new Set<ReferenceViolationKind>(['dangling-policy', 'dangling-action', 'dangling-requirement']),
    );
  });

  /**
   * The live set equals the `<tool>.<action>` set of the registry projection.
   * The second half passes no custom set, so `resolveReferences` uses its default source.
   * A live id resolves, and an invented id dangles.
   */
  it('resolves action refs against the REAL P03-04 ActionId source by default', () => {
    const live = liveActionIdSet();
    const projected = new Set(
      registrationActionRefs(deriveRegistrationFromRegistry()).map((r) => r.actionId),
    );
    expect(live).toEqual(projected);
    expect(live.size).toBeGreaterThan(0);

    const realActionId = [...live][0] as string;
    const raw = baseValidDoc();
    const edges = raw['edges'] as Record<string, unknown>[];
    (edges[0] as Record<string, unknown>)['effect'] = { actionRef: realActionId };
    const policies = raw['policies'] as Record<string, unknown>[];
    (policies[0] as Record<string, unknown>)['onDeny'] = [realActionId];
    expect(resolveReferences(parse(raw)).ok).toBe(true);

    (edges[0] as Record<string, unknown>)['effect'] = { actionRef: 'not_a_real.action_id' };
    const verdict = resolveReferences(parse(raw));
    expect(verdict.ok).toBe(false);
    expect(kinds(verdict.violations)).toContain('dangling-action');
  });
});
