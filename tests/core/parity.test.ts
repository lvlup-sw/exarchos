/**
 * The CLI and MCP parity gate for the `exarchos_workflow` composite. Each action in `ACTION_TABLE`
 * must give the same envelope through the CLI adapter and through MCP dispatch, after the
 * normalization of durations, timestamps and UUIDs.
 *
 * `./parity-actions.ts` holds the table, `assertActionParity` and the fixture helpers. The bare
 * import of the rehydration barrel registers the reducer with the default projection registry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import '../../src/projections/rehydration/index.js';

import {
  ACTION_TABLE,
  WORKFLOW_ACTIONS,
  assertActionParity,
  setupFixture,
  teardownFixture,
  type ParityFixture,
} from './parity-actions.js';

let fixture: ParityFixture;

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  await teardownFixture(fixture);
});

describe('CliMcpParity_AllWorkflowActions_ByteIdenticalEnvelope (T045, DR-11)', () => {
  /**
   * Each row of `ACTION_TABLE` is one test case with its own name, so a parity break names its
   * action in the report.
   */
  it.each(ACTION_TABLE)(
    'parity for action "$action"',
    async (spec) => {
      await assertActionParity(fixture, spec);
    },
  );

  /**
   * Fails when `ACTION_TABLE` and `WORKFLOW_ACTIONS` hold different action sets. Both lists are in
   * `parity-actions.ts`, and the test does not read the registry.
   */
  it('ACTION_TABLE_Covers_All_Workflow_Actions', () => {
    const expected = new Set(WORKFLOW_ACTIONS);
    const covered = new Set(ACTION_TABLE.map((s) => s.action));
    expect(covered).toEqual(expected);
  });
});
