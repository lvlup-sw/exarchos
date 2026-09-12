// The authority block is DERIVED from the published kernel, not copied from it.
//
// The risk a derivation carries is different from the risk a copy carries. A
// copy drifts; a derivation silently no-ops on a shape it does not handle. So
// the assertions here are about totality and about equivalence-modulo-closure,
// and every one of them reads the installed package rather than a recorded
// constant — otherwise this file would be comparing our work to our work.
//
// @oracle-sources: @lvlup-sw/strategos-contracts read from node_modules, whose emitted JSON Schema is one side of every equivalence assertion here and is produced by a package this repository does not author, ../../../../src/contract/capsule/exarchos-capsule.ts, read as TEXT for the transform-application denominator rather than imported, so a call site added there reaches this file whether or not anyone remembers it

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import { describe, it, expect } from 'vitest';
import {
  WorkflowAuthorityStatementV1Schema,
  WorkflowAuthorityV1Schema,
  WorkflowDefinitionV1Schema,
} from '@lvlup-sw/strategos-contracts';

import {
  HANDLED_ZOD_NODE_TYPES,
  deepStrictify,
  reachableZodNodeTypes,
  requireNonEmptyArrayFields,
  unwrapOptional,
} from '../../../../src/contract/capsule/kernel-derivation.js';
import {
  CAPSULE_REQUIRED_AUTHORITY_CATEGORIES,
  ExarchosCapsuleAuthorityV1Schema,
} from '../../../../src/contract/capsule/exarchos-capsule.js';

const CAPSULE_MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/contract/capsule/exarchos-capsule.ts',
);

const KERNEL_AUTHORITY = WorkflowAuthorityV1Schema as unknown as z.ZodType;
const DERIVED_STRUCTURE = deepStrictify(KERNEL_AUTHORITY);

/** Erase ONLY openness, so what remains is every claim the kernel makes. */
function stripAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAdditionalProperties);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'additionalProperties')
        .map(([key, child]) => [key, stripAdditionalProperties(child)]),
    );
  }
  return value;
}

const emit = (schema: z.ZodType): unknown =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });

describe('deriving the capsule authority block from the kernel', () => {
  it('KernelDerivation_EveryReachableNodeType_IsHandled', () => {
    const reachable = [...reachableZodNodeTypes(KERNEL_AUTHORITY)].sort();
    const unhandled = reachable.filter((type) => !HANDLED_ZOD_NODE_TYPES.has(type));
    expect(
      unhandled,
      `the kernel introduced ${unhandled.join(', ')}; deepStrictify passes an unhandled node ` +
        'through untouched, so openness would leak back in silence. Teach the transform.',
    ).toEqual([]);
    // The denominator, asserted: a walk that resolved nothing would also report
    // no unhandled types.
    expect(reachable.length).toBeGreaterThan(2);
  });

  it('KernelDerivation_EveryEmittedObject_IsClosed', () => {
    const walk = (node: unknown, path: string, open: string[]): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`, open));
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (record.properties !== undefined && record.additionalProperties !== false) {
        open.push(path);
      }
      for (const [key, child] of Object.entries(record)) walk(child, `${path}.${key}`, open);
    };
    const open: string[] = [];
    walk(emit(DERIVED_STRUCTURE), '$', open);
    expect(open, `these emitted objects are still open: ${open.join(', ')}`).toEqual([]);
  });

  // The load-bearing assertion. One side is emitted from `node_modules`, the
  // other from our derivation, so it cannot pass by comparing a copy to itself.
  //
  // Run over EVERY schema the transform is applied to, not just the one. The
  // transform rebuilds array and optional nodes — `z.array(deepStrictify(el))`,
  // `deepStrictify(inner).optional()` — and a rebuild constructed that way
  // carries no `.min()`, `.max()`, `.default()` or `.catch()` the source node
  // had. So "changes only openness" is a property of each APPLICATION, not of
  // the function, and an application with no equivalence check behind it is an
  // unproven claim wearing a proven one's header.
  it.each([
    ['the authority block', KERNEL_AUTHORITY],
    ['one authority statement', WorkflowAuthorityStatementV1Schema as unknown as z.ZodType],
  ])('KernelDerivation_ChangesOnlyOpenness_AndNothingElse_%s', (_name, source) => {
    expect(stripAdditionalProperties(emit(deepStrictify(source)))).toEqual(
      stripAdditionalProperties(emit(source)),
    );
  });

  it('KernelDerivation_TheEquivalenceProof_CoversEveryApplicationOfTheTransform', () => {
    // The denominator for the case above. The proof is per-application, so the
    // set of applications is itself the thing that can go stale: a third
    // `deepStrictify(...)` call site added to the contract and not added here
    // would be an unchecked rebuild, and nothing else would say so.
    const source = readFileSync(CAPSULE_MODULE, 'utf8');
    const applications = [...source.matchAll(/deepStrictify\(\s*([A-Za-z0-9_]+)/g)].map(
      (match) => match[1],
    );
    expect(new Set(applications)).toEqual(
      new Set(['WorkflowAuthorityStatementV1Schema', 'WorkflowAuthorityV1Schema']),
    );
  });

  // If the kernel ever tightens upstream, this wrapper becomes redundant and
  // someone should be told rather than left carrying it.
  it('KernelDerivation_TheVacuityHazard_IsStillRealInTheInstalledPackage', () => {
    expect(KERNEL_AUTHORITY.safeParse({}).success).toBe(true);
    expect(KERNEL_AUTHORITY.safeParse({ invariants: [{ statement: 'x', extra: 1 }] }).success).toBe(
      true,
    );
    expect(ExarchosCapsuleAuthorityV1Schema.safeParse({}).success).toBe(false);
  });

  it('KernelDerivation_RequiredCategories_AreNamesTheKernelStillCarries', () => {
    const kernelFields = Object.keys(
      (KERNEL_AUTHORITY as unknown as { shape: Record<string, unknown> }).shape,
    );
    for (const category of CAPSULE_REQUIRED_AUTHORITY_CATEGORIES) {
      expect(kernelFields, `the kernel no longer carries ${category}`).toContain(category);
    }
    expect(kernelFields).toContain('goals');
  });

  it('KernelDerivation_Goals_StayOptional', () => {
    // The capsule keeps goals under `intent`. Leaving the kernel's own `goals`
    // optional is what keeps the block assignable to the kernel's authority.
    const good = {
      invariants: [{ statement: 'i' }],
      assumptions: [{ statement: 'a' }],
      delegatedDecisions: [{ statement: 'd' }],
      escalationBoundaries: [{ statement: 'e' }],
    };
    expect(ExarchosCapsuleAuthorityV1Schema.safeParse(good).success).toBe(true);
  });

  it('KernelDerivation_PromotingAMissingField_Throws', () => {
    expect(() => requireNonEmptyArrayFields(DERIVED_STRUCTURE, ['notAField'])).toThrow(
      /no field "notAField"/,
    );
  });

  it.each([
    ['an array with a length bound', z.object({ xs: z.array(z.string()).min(1) })],
    ['an object with a refinement', z.object({ a: z.string() }).superRefine(() => undefined)],
  ])('KernelDerivation_ARebuiltNodeCarryingChecks_Throws_%s', (_name, source) => {
    // A rebuild constructs the node fresh, so a check on it would vanish. The
    // equivalence proof above covers only the applications it names; this is
    // what stops a check added upstream from being dropped in silence.
    expect(() => deepStrictify(source)).toThrow(/carries 1 check/);
  });

  it('KernelDerivation_UnwrappingANonOptional_Throws', () => {
    expect(() => unwrapOptional(z.string())).toThrow(/expected an optional/);
  });

  it('KernelDerivation_TheBorrowedDigestVocabulary_IsTheKernels', () => {
    const digest = unwrapOptional(WorkflowDefinitionV1Schema.shape.contentHash);
    expect(digest.safeParse('a'.repeat(64)).success).toBe(true);
    expect(digest.safeParse('a'.repeat(63)).success).toBe(false);
    expect(digest.safeParse('nope').success).toBe(false);
  });
});
