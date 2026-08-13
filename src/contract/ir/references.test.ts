import { describe, it, expect } from 'vitest';
import {
  resolveReferences,
  liveActionIdSet,
  type ReferenceViolationKind,
} from './references.js';
import { parseAdmissionIrDocument } from './admission-ir.js';
import { baseValidDoc } from './admission-ir-fixtures.js';
import {
  deriveRegistrationFromRegistry,
  registrationActionRefs,
} from '../bindings/generate-registration.js';

/** Parse a raw fixture into a typed document, failing the test if it is malformed. */
function parse(raw: unknown) {
  const result = parseAdmissionIrDocument(raw);
  if (!result.ok) {
    throw new Error(`fixture is not structurally valid: ${result.error.message}`);
  }
  return result.document;
}

// A deterministic action-id set for the precise dangling/resolve assertions, so
// the tests do not depend on the exact live registry contents. The base fixture
// references `exarchos_event.append`, which is a real ActionId (proven live in
// the last test), but here we inject it explicitly.
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

  it('duplicate policy/requirement definition ids FAIL (ambiguous ref targets)', () => {
    const raw = baseValidDoc();
    const policies = raw['policies'] as Record<string, unknown>[];
    (policies[1] as Record<string, unknown>)['policyId'] = 'pol.release'; // dup of policies[0]
    const requirements = raw['requirements'] as Record<string, unknown>[];
    (requirements[1] as Record<string, unknown>)['requirementId'] = 'req.gate'; // dup of req[0]
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

  it('resolves action refs against the REAL P03-04 ActionId source by default', () => {
    // The live set is derived from the registry projection (P03-04) — the same
    // <tool>.<action> set the binding verifier resolves against.
    const live = liveActionIdSet();
    const projected = new Set(
      registrationActionRefs(deriveRegistrationFromRegistry()).map((r) => r.actionId),
    );
    expect(live).toEqual(projected);
    expect(live.size).toBeGreaterThan(0);

    // A real live ActionId resolves; a fabricated one is dangling — WITHOUT
    // injecting a custom set (exercises the real default source).
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
