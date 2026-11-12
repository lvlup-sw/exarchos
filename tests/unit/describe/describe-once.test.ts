// The `describe` reply of one action holds its output schema once, under `outputSchemaJson`.
// Each copy of the schema counts against the response budget of `describe`. The largest action,
// `settle`, must keep room under that budget for the text that later work adds.
//
// @oracle-sources: ../../../src/describe/handler.ts, the zod schema of each action
//
// The handler builds the reply. The zod schema of each action in the live registry is the second
// authority. The test converts that schema to JSON Schema on its own side.

import { describe, it, expect } from 'vitest';
import { handleDescribe } from '../../../src/describe/handler.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import type { ToolAction } from '../../../src/registry.js';
import { estimateOutputTokens } from '../../../src/dispatch/core/economy.js';
import { zodToJsonSchema } from '../../../src/utils/json-schema.js';

/** The highest estimated token count that the `describe` reply of `settle` can have. */
const SETTLE_DESCRIBE_CEILING_TOKENS = 7500;

/** Gives true when a value is a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One action of the live registry that declares an output schema, with the name of its tool. */
interface DescribedAction {
  readonly key: string;
  readonly action: ToolAction;
  readonly actions: readonly ToolAction[];
}

/** Lists each action of each registered tool that declares an output schema. */
function actionsWithAnOutputSchema(): DescribedAction[] {
  const found: DescribedAction[] = [];
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      if (action.outputSchema === undefined) continue;
      found.push({ key: `${tool.name}.${action.name}`, action, actions: tool.actions });
    }
  }
  return found;
}

/** Gives the `describe` entry of one action, or throws when the reply holds none. */
async function describedEntryOf(
  actionName: string,
  actions: readonly ToolAction[],
): Promise<Record<string, unknown>> {
  const result = await handleDescribe({ actions: [actionName] }, actions);
  if (!result.success || !isRecord(result.data)) {
    throw new Error(`describe of ${actionName} failed`);
  }
  const entry = result.data[actionName];
  if (!isRecord(entry)) throw new Error(`describe of ${actionName} holds no entry`);
  return entry;
}

describe('describe returns each output schema once', () => {
  /**
   * Each entry holds `outputSchemaJson` and no `outputSchema`. No other top-level slot of the
   * entry holds a second copy of the same schema under another key.
   */
  it('DescribeAction_ReturnsTheOutputSchemaOnce', async () => {
    const described = actionsWithAnOutputSchema();
    expect(described.length).toBeGreaterThan(100);
    expect(described.map((entry) => entry.key)).toContain('exarchos_orchestrate.settle');

    for (const { key, action, actions } of described) {
      const entry = await describedEntryOf(action.name, actions);
      expect(Object.keys(entry), key).toContain('outputSchemaJson');
      expect(Object.keys(entry), key).not.toContain('outputSchema');
      const schemaText = JSON.stringify(entry.outputSchemaJson);
      const copies = Object.values(entry).filter((value) => JSON.stringify(value) === schemaText);
      expect(copies.length, key).toBe(1);
    }
  });

  /**
   * The `describe` reply of `settle` is at most 7500 estimated tokens. A second copy of its output
   * schema takes the reply near the shared describe budget of 8000.
   */
  it('DescribeAction_Settle_LeavesRoomUnderTheBudget', async () => {
    const orchestrate = TOOL_REGISTRY.find((tool) => tool.name === 'exarchos_orchestrate');
    if (orchestrate === undefined) throw new Error('exarchos_orchestrate is not registered');
    const result = await handleDescribe({ actions: ['settle'] }, orchestrate.actions);
    expect(result.success).toBe(true);

    const tokens = estimateOutputTokens(result.data);
    expect(tokens).toBeLessThanOrEqual(SETTLE_DESCRIBE_CEILING_TOKENS);
  });

  /**
   * The one copy is the JSON Schema of the zod output schema of the action. So the removal of the
   * second key loses no part of the schema.
   */
  it('DescribeAction_OutputSchemaJson_EqualsTheSchemaOfTheAction', async () => {
    const described = actionsWithAnOutputSchema();
    expect(described.length).toBeGreaterThan(100);

    for (const { key, action, actions } of described) {
      if (action.outputSchema === undefined) throw new Error(`${key} has no output schema`);
      const entry = await describedEntryOf(action.name, actions);
      expect(entry.outputSchemaJson, key).toEqual(zodToJsonSchema(action.outputSchema));
    }
  });
});
