// The authority block is derived from the published kernel, not copied from it.
//
// A copy drifts. A derivation does nothing, in silence, on a shape that it does
// not handle. Thus these tests assert totality and equivalence modulo closure.
// Those assertions read the installed package and not a recorded constant, so
// they do not compare our work to our work.
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

/** Removes only `additionalProperties`, so the result holds every claim that the kernel makes. */
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
  /** The last assertion pins the denominator: a walk that resolves nothing also reports no unhandled type. */
  it('KernelDerivation_EveryReachableNodeType_IsHandled', () => {
    const reachable = [...reachableZodNodeTypes(KERNEL_AUTHORITY)].sort();
    const unhandled = reachable.filter((type) => !HANDLED_ZOD_NODE_TYPES.has(type));
    expect(
      unhandled,
      `the kernel introduced ${unhandled.join(', ')}; deepStrictify passes an unhandled node ` +
        'through untouched, so openness would leak back in silence. Teach the transform.',
    ).toEqual([]);
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

  /**
   * One side comes from `node_modules` and the other from our derivation, so the test does not compare a copy with itself.
   * The transform rebuilds array and optional nodes, and a rebuilt node keeps no check of its source, such as `.min()` or `.max()`.
   * Thus "changes only openness" is a property of each application, and each application needs this proof.
   */
  it.each([
    ['the authority block', KERNEL_AUTHORITY],
    ['one authority statement', WorkflowAuthorityStatementV1Schema as unknown as z.ZodType],
  ])('KernelDerivation_ChangesOnlyOpenness_AndNothingElse_%s', (_name, source) => {
    expect(stripAdditionalProperties(emit(deepStrictify(source)))).toEqual(
      stripAdditionalProperties(emit(source)),
    );
  });

  /**
   * The equivalence proof is per application, so the set of applications can go stale.
   * A third `deepStrictify(...)` call site in the contract that this file does not list is a rebuild without a proof.
   */
  it('KernelDerivation_TheEquivalenceProof_CoversEveryApplicationOfTheTransform', () => {
    const source = readFileSync(CAPSULE_MODULE, 'utf8');
    const applications = [...source.matchAll(/deepStrictify\(\s*([A-Za-z0-9_]+)/g)].map(
      (match) => match[1],
    );
    expect(new Set(applications)).toEqual(
      new Set(['WorkflowAuthorityStatementV1Schema', 'WorkflowAuthorityV1Schema']),
    );
  });

  /** If the kernel closes its schema upstream, the derivation is redundant, and a failure of this test reports that. */
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

  /** The capsule keeps goals under `intent`. An optional `goals` keeps the block assignable to the kernel authority. */
  it('KernelDerivation_Goals_StayOptional', () => {
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

  /**
   * A rebuild makes a new node, so a check on the source node does not carry over.
   * The equivalence proof covers only the applications that it names.
   * This refusal stops the silent loss of a check that the kernel adds upstream.
   */
  it.each([
    ['an array with a length bound', z.object({ xs: z.array(z.string()).min(1) })],
    ['an object with a refinement', z.object({ a: z.string() }).superRefine(() => undefined)],
  ])('KernelDerivation_ARebuiltNodeCarryingChecks_Throws_%s', (_name, source) => {
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
