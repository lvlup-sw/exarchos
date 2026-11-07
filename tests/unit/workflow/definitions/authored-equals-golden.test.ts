// These tests compare each loaded built-in definition with a projection of the golden.
// The golden recorded the machine, the admission IR, the valid targets and the lowered kernel
// before the definition files existed. So a definition file that drifts from that record fails here.
//
// @oracle-sources: ../__fixtures__/built-in.golden.json, ../../../../src/workflow/definitions/built-in.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { definitionsFromGolden } from '../../../helpers/definitions/definitions-from-golden.js';
import { BUILT_IN_WORKFLOW_TYPES, builtInDefinition } from '../../../../src/workflow/definitions/built-in.js';

/** The golden that the code before the definition files wrote. No test writes it. */
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/built-in.golden.json',
);

/** The definitions that the golden projects. */
const PROJECTION = definitionsFromGolden(fs.readFileSync(GOLDEN_PATH, 'utf8'));

/** The number of edges of each built-in type, in roster order. */
const EDGE_COUNTS = [12, 16, 17, 4, 2];

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The edge keys of a projected definition. */
function projectedEdgeKeys(type: string): readonly string[] {
  const extension = PROJECTION[type]?.exarchos;
  if (!isRecord(extension) || !isRecord(extension.edges)) throw new Error(`${type} has no projected edges`);
  return Object.keys(extension.edges);
}

describe('the authored built-in definitions against the golden', () => {
  /** Each loaded definition equals the projection of the golden, field for field. */
  it.each(BUILT_IN_WORKFLOW_TYPES)('AuthoredDefinition_%s_EqualsTheGoldenProjection', (type) => {
    expect(PROJECTION[type]).toBeDefined();
    expect(builtInDefinition(type)).toStrictEqual(PROJECTION[type]);
  });

  /**
   * The projection holds the five built-in types in roster order, with 51 edges in the order 12, 16, 17, 4, 2.
   * The edge keys of each loaded definition are the kernel transition ids in the same order.
   */
  it('AuthoredDefinition_TheProjection_HoldsFiveDefinitionsAnd51Edges', () => {
    expect(Object.keys(PROJECTION)).toEqual(BUILT_IN_WORKFLOW_TYPES);
    const counts = BUILT_IN_WORKFLOW_TYPES.map((type) => projectedEdgeKeys(type).length);
    expect(counts).toEqual(EDGE_COUNTS);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(51);
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const definition = builtInDefinition(type);
      const transitionIds = definition.transitions.map((transition) => transition.transitionId);
      expect(Object.keys(definition.exarchos.edges), type).toEqual(transitionIds);
      expect(projectedEdgeKeys(type), type).toEqual(transitionIds);
    }
  });
});
