/**
 * Tests for the shared path of the inferred values, with a synthetic second field.
 *
 * The `featureId` guards prove the schema gate for that one field only. These tests prove that
 * each entry in the table gets the gate. A new inference reaches a payload only through this path.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  applyInferredValues,
  actionAcceptsInferredValue,
  INFERRABLE_FIELDS,
  type InferrableField,
} from '../../../../src/dispatch/core/inferred-values.js';
import type { ToolAction } from '../../../../src/registry.js';

/** A minimal action whose schema declares exactly `fields`. */
function actionWith(name: string, fields: readonly string[]): ToolAction {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) shape[f] = z.string();
  return { name, description: name, schema: z.object(shape).strict() } as unknown as ToolAction;
}

/** A synthetic entry that always resolves, so only the GATE can stop it. */
function alwaysResolves(field: string, value = 'inferred'): InferrableField {
  return {
    field,
    skipActions: new Set<string>(),
    isAvailable: () => true,
    resolve: async () => ({ kind: 'resolved', value }),
  };
}

const ctx = { eventStore: {} as never };

describe('Every inferrable field inherits one gate', () => {
  it('InferredValue_ActionDeclaringTheField_ReceivesIt', async () => {
    const result = await applyInferredValues(
      {},
      actionWith('takes-it', ['taskId']),
      'exarchos_test',
      'takes-it',
      ctx,
      [alwaysResolves('taskId')],
    );
    expect(result.kind).toBe('merged');
    if (result.kind === 'merged') expect(result.args['taskId']).toBe('inferred');
  });

  /** A new inference cannot reach an action whose schema omits the field. */
  it('InferredValue_ActionOmittingTheField_NeverReceivesIt', async () => {
    const result = await applyInferredValues(
      {},
      actionWith('forbids-it', ['somethingElse']),
      'exarchos_test',
      'forbids-it',
      ctx,
      [alwaysResolves('taskId')],
    );
    expect(result.kind).toBe('merged');
    if (result.kind === 'merged') {
      expect(
        Object.prototype.hasOwnProperty.call(result.args, 'taskId'),
        'a field the action does not declare must never be merged',
      ).toBe(false);
    }
  });

  it('InferredValue_ExplicitCallerValue_IsNeverOverwritten', async () => {
    const result = await applyInferredValues(
      { taskId: 'chosen-by-caller' },
      actionWith('takes-it', ['taskId']),
      'exarchos_test',
      'takes-it',
      ctx,
      [alwaysResolves('taskId')],
    );
    expect(result.kind).toBe('merged');
    if (result.kind === 'merged') expect(result.args['taskId']).toBe('chosen-by-caller');
  });

  it('InferredValue_LatencySkipList_SuppressesResolution', async () => {
    let resolverRan = false;
    const entry: InferrableField = {
      ...alwaysResolves('taskId'),
      skipActions: new Set(['describe']),
      resolve: async () => {
        resolverRan = true;
        return { kind: 'resolved', value: 'x' };
      },
    };
    const result = await applyInferredValues(
      {},
      actionWith('describe', ['taskId']),
      'exarchos_test',
      'describe',
      ctx,
      [entry],
    );
    expect(resolverRan, 'the skip list must short-circuit before the resolver').toBe(false);
    expect(result.kind).toBe('merged');
  });

  it('InferredValue_AmbiguousOutcome_RefusesWithTheCallersOptions', async () => {
    const entry: InferrableField = {
      ...alwaysResolves('taskId'),
      resolve: async () => ({
        kind: 'ambiguous',
        code: 'INVALID_INPUT',
        message: 'several matched',
        validTargets: ['a', 'b'],
      }),
    };
    const result = await applyInferredValues(
      {},
      actionWith('takes-it', ['taskId']),
      'exarchos_test',
      'takes-it',
      ctx,
      [entry],
    );
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.code).toBe('INVALID_INPUT');
      expect(result.validTargets).toEqual(['a', 'b']);
    }
  });

  /**
   * An `unavailable` outcome causes no merge and no refusal. The schema of the action then gives
   * the usual missing-parameter envelope.
   */
  it('InferredValue_UnavailableOutcome_FallsThroughToValidation', async () => {
    const entry: InferrableField = {
      ...alwaysResolves('taskId'),
      resolve: async () => ({ kind: 'unavailable' }),
    };
    const result = await applyInferredValues(
      {},
      actionWith('takes-it', ['taskId']),
      'exarchos_test',
      'takes-it',
      ctx,
      [entry],
    );
    expect(result.kind).toBe('merged');
    if (result.kind === 'merged') {
      expect(Object.prototype.hasOwnProperty.call(result.args, 'taskId')).toBe(false);
    }
  });
});

describe('The shipped table is well-formed', () => {
  /** The length check is the denominator: an empty table passes the distinct-field check. */
  it('InferrableFields_EveryEntry_DeclaresADistinctField', () => {
    expect(INFERRABLE_FIELDS.length).toBeGreaterThanOrEqual(1);
    const names = INFERRABLE_FIELDS.map((f) => f.field);
    expect(new Set(names).size, 'two entries claiming one field would race').toBe(names.length);
  });

  /** The gate reads only the schema and no list, so it is correct for an action not yet written. */
  it('InferrableFields_TheGate_IsAFunctionOfTheSchemaAlone', () => {
    const declares = actionWith('a', ['featureId']);
    const omits = actionWith('b', ['other']);
    expect(actionAcceptsInferredValue(declares, 'featureId')).toBe(true);
    expect(actionAcceptsInferredValue(omits, 'featureId')).toBe(false);
  });
});
