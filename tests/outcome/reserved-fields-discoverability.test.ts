/**
 * Outcome tests for the two surfaces that show the reserved fields of `exarchos_workflow` `update`.
 *
 * The `describe` output of the `update` action holds a `reservedFields` block from
 * `RESERVED_FIELDS_DESCRIPTOR`, with the alternate write path for each reserved key. When
 * `applyDotPath` rejects a reserved key, the error holds a `data` block with `rejectedPath`, `rule`
 * and `alternateWritePath`. A caller can then use the alternate path and does not parse the
 * message.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../src/events/store.js';
import {
  handleInit,
  handleUpdate,
} from '../../src/workflow/tools.js';
import { handleDescribe } from '../../src/describe/handler.js';

/**
 * Reads the `ReservedFieldErrorData` block from an envelope error. The declared error type has no
 * `data` field, so the function narrows to it. An absent block gives `undefined`, so the test
 * fails visibly.
 */
function reservedFieldData(
  err: unknown,
): { rejectedPath?: unknown; rule?: unknown; alternateWritePath?: unknown } | undefined {
  if (err === null || typeof err !== 'object' || !('data' in err)) return undefined;
  const data = err.data;
  if (data === null || typeof data !== 'object') return undefined;
  return { ...data };
}
import { TOOL_REGISTRY } from '../../src/registry.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const workflowTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow');

describe('reserved-fields discoverability outcome (#1360)', () => {
  /**
   * The describe output and the runtime guard read the same descriptor. Each of its four keys must
   * be present and not empty. The alternate path for `phase` must name the `transition` action.
   */
  it('Describe_UpdateAction_EnumeratesReservedFields', async () => {
    expect(workflowTool).toBeDefined();
    const result = await handleDescribe(
      { actions: ['update'] },
      workflowTool!.actions,
    );
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('update');
    const updateDesc = data.update as Record<string, unknown>;
    expect(updateDesc).toHaveProperty('reservedFields');

    const reservedFields = updateDesc.reservedFields as Record<string, unknown>;

    expect(reservedFields).toHaveProperty('topLevelImmutable');
    expect(reservedFields).toHaveProperty('underscorePrefixRule');
    expect(reservedFields).toHaveProperty('examples');
    expect(reservedFields).toHaveProperty('alternateWritePaths');

    const topLevel = reservedFields.topLevelImmutable as readonly string[];
    expect(Array.isArray(topLevel)).toBe(true);
    expect(topLevel.length).toBeGreaterThan(0);
    expect(topLevel).toContain('phase');
    expect(topLevel).toContain('workflowType');
    expect(topLevel).toContain('featureId');

    expect(typeof reservedFields.underscorePrefixRule).toBe('string');
    expect((reservedFields.underscorePrefixRule as string).length).toBeGreaterThan(0);

    const examples = reservedFields.examples as readonly string[];
    expect(Array.isArray(examples)).toBe(true);
    expect(examples.length).toBeGreaterThan(0);

    const alternates = reservedFields.alternateWritePaths as Record<string, string>;
    expect(typeof alternates).toBe('object');
    expect(Object.keys(alternates).length).toBeGreaterThan(0);
    expect(alternates.phase).toMatch(/transition/);
  });

  /**
   * `workflowType` is a top-level immutable key, so `applyDotPath` throws `RESERVED_FIELD` with the
   * data block. The test does not use `phase`, because `handleUpdate` rejects it earlier with
   * `INVALID_INPUT`. The test accepts a string or `null` for `alternateWritePath`.
   */
  it('Update_WithReservedTopLevelField_ReturnsStructuredErrorData', async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outcome-reserved-fields-'),
    );
    try {
      const eventStore = new EventStore(stateDir);
      const featureId = 'outcome-1360-toplevel';

      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      const updateResult = await handleUpdate(
        { featureId, updates: { workflowType: 'debug' } },
        stateDir,
        eventStore,
      );

      expect(updateResult.success).toBe(false);
      expect(updateResult.error?.code).toBe('RESERVED_FIELD');

      const errData = reservedFieldData(updateResult.error);
      expect(errData, 'no typed data block on the RESERVED_FIELD error').toBeDefined();
      expect(errData?.rejectedPath).toBe('workflowType');
      expect(typeof errData?.rule).toBe('string');
      expect(String(errData?.rule).length).toBeGreaterThan(0);
      const altPath = errData?.alternateWritePath;
      expect(altPath === null || typeof altPath === 'string').toBe(true);
      if (typeof altPath === 'string') {
        expect(altPath.length).toBeGreaterThan(0);
      }
    } finally {
      await rmrfAsync(stateDir);
    }
  });

  /**
   * A key that starts with `_` is reserved for projection and event-store metadata. The `rule` of
   * the error is the `underscorePrefixRule` of the descriptor, and its `^_.*` entry gives the
   * alternate path. The test asserts the type of each value, not its text.
   */
  it('Update_WithUnderscorePrefixedField_ReturnsStructuredErrorData', async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outcome-reserved-fields-underscore-'),
    );
    try {
      const eventStore = new EventStore(stateDir);
      const featureId = 'outcome-1360-underscore';

      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      const updateResult = await handleUpdate(
        { featureId, updates: { _meta: 'x' } },
        stateDir,
        eventStore,
      );

      expect(updateResult.success).toBe(false);
      expect(updateResult.error?.code).toBe('RESERVED_FIELD');

      const errData = reservedFieldData(updateResult.error);
      expect(errData, 'no typed data block on the RESERVED_FIELD error').toBeDefined();
      expect(errData?.rejectedPath).toBe('_meta');
      expect(typeof errData?.rule).toBe('string');
      expect(String(errData?.rule).length).toBeGreaterThan(0);

      const altPath = errData?.alternateWritePath;
      expect(altPath === null || typeof altPath === 'string').toBe(true);
      if (typeof altPath === 'string') {
        expect(altPath.length).toBeGreaterThan(0);
      }
    } finally {
      await rmrfAsync(stateDir);
    }
  });
});
