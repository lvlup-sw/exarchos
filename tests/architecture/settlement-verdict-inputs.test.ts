/**
 * Each event type that settlement reads as an input of its verdict is reserved on the generic
 * append surface.
 *
 * Settlement trusts these rows. A prepared record pins a capsule, a decision settles held work, and
 * a completion row stands for the result of a required task. If a caller can append such a row
 * through the generic surface, the caller can fake a verdict. The list of inputs is data beside the
 * reserved lists. This test holds the list against the registry that the append handlers read.
 *
 * @oracle-sources: ../../src/events/schemas.ts, ../../src/registry/gate-metadata.ts
 */

import { describe, expect, it } from 'vitest';

import { EventTypes, SETTLEMENT_VERDICT_INPUT_EVENT_TYPES } from '../../src/events/schemas.js';
import { RESERVED_EVENT_APPEND_REGISTRY } from '../../src/registry/gate-metadata.js';

/** The verdict inputs that settlement reads today. A list that loses one fails here. */
const KNOWN_VERDICT_INPUTS: readonly string[] = [
  'capsule.recompiled',
  'design.revised',
  'deviation.decided',
  'deviation.proposed',
  'execution.settled',
  'task.completed',
  'workflow.prepared',
];

describe('settlement verdict inputs', () => {
  /**
   * The list is pinned, so an emptied list cannot pass. Each name is a catalog type, so a typo
   * cannot pass as an unreserved name that no writer uses.
   */
  it('SettlementVerdictInputs_EachOne_IsInTheReservedAppendRegistry', () => {
    expect([...SETTLEMENT_VERDICT_INPUT_EVENT_TYPES].sort()).toEqual(KNOWN_VERDICT_INPUTS);
    const catalog = new Set<string>(EventTypes);
    expect(SETTLEMENT_VERDICT_INPUT_EVENT_TYPES.filter((type) => !catalog.has(type))).toEqual([]);

    const unreserved = SETTLEMENT_VERDICT_INPUT_EVENT_TYPES.filter(
      (type) => !RESERVED_EVENT_APPEND_REGISTRY.has(type),
    );
    expect(unreserved, 'verdict inputs that the generic append can write').toEqual([]);
  });
});
