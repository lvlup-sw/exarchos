/**
 * The structural half of the severity denominator. Each gate action of the registry goes through the severity wrapper.
 * The test reads each action with `gate` metadata from the registry and checks the mark of its handler in the real action table.
 * Thus it does not compare the registry with a set that the code derives from the registry. A text scan cannot see a wrap
 * that the table builder applies to each entry, so the test reads no source text.
 * Each row of the severity register must name a gate action of the registry.
 *
 * The test imports the action table, which loads the SQLite backend.
 * So it lives in the `unit` tier, which the `core` project collects with the `bun:sqlite` alias.
 */

import { describe, expect, it } from 'vitest';

import { TOOL_REGISTRY } from '../../../../src/registry.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import {
  GATE_SEVERITY_REGISTER,
  isSeverityWrapped,
  type GateActionHandler,
  type GateSeverityRegisterRow,
} from '../../../../src/verbs/gates/gate-severity.js';

/** The registry held 28 gate actions when this was written. A smaller count means a broken read of the registry. */
const GATE_ACTION_FLOOR = 28;

/** The names of each action with `gate` metadata, over every tool of the registry. */
function gateActionNames(): string[] {
  return TOOL_REGISTRY.flatMap((tool) => tool.actions)
    .filter((action) => action.gate !== undefined)
    .map((action) => action.name);
}

/** The gate actions whose handler in the table is absent or is not one that the severity wrapper returned. */
function unwrappedGateActions(
  names: readonly string[],
  table: Readonly<Record<string, GateActionHandler | undefined>>,
): string[] {
  return names.filter((name) => {
    const handler = table[name];
    return handler === undefined || !isSeverityWrapped(handler);
  });
}

/** The actions of the register rows that name no gate action of the registry. */
function staleRegisterRows(
  names: readonly string[],
  register: readonly GateSeverityRegisterRow[],
): string[] {
  const gateActions = new Set(names);
  return register.filter((row) => !gateActions.has(row.action)).map((row) => row.action);
}

describe('the severity denominator of the gate actions', () => {
  /**
   * Each gate action of the registry has a handler that the wrapper returned.
   * The control: an action with no `gate` metadata keeps its own handler, so the mark tells the two apart.
   */
  it('GateSeverity_EveryGateActionOfTheRegistry_IsWrapped', () => {
    const names = gateActionNames();

    expect(names.length).toBeGreaterThanOrEqual(GATE_ACTION_FLOOR);
    expect(unwrappedGateActions(names, ACTION_HANDLERS)).toEqual([]);

    const taskComplete = ACTION_HANDLERS['task_complete'];
    expect(taskComplete).toBeTypeOf('function');
    expect(taskComplete !== undefined && isSeverityWrapped(taskComplete)).toBe(false);
  });

  /** A copy of the table with one gate entry set to a raw handler fails, and names that action. */
  it('GateSeverity_ASeededUnwrappedGateAction_FailsByName', () => {
    const names = gateActionNames();
    const raw: GateActionHandler = async () => ({ success: true, data: { passed: true } });
    const seeded = { ...ACTION_HANDLERS, check_static_analysis: raw };

    expect(names).toContain('check_static_analysis');
    expect(unwrappedGateActions(names, seeded)).toEqual(['check_static_analysis']);
  });

  /**
   * A register row for an action that does not exist fails, and names that action. So does a row for an action with no `gate` metadata.
   * The control: each row of the live register names a gate action of the registry.
   */
  it('GateSeverity_ARegisterRowForNoGateAction_FailsByName', () => {
    const names = gateActionNames();
    const row = (action: string): GateSeverityRegisterRow => ({
      action,
      meaning: 'no-severity',
      reason: 'A seeded row.',
      owner: 'this test',
    });

    expect(GATE_SEVERITY_REGISTER.length).toBeGreaterThan(0);
    expect(staleRegisterRows(names, GATE_SEVERITY_REGISTER)).toEqual([]);
    expect(
      staleRegisterRows(names, [...GATE_SEVERITY_REGISTER, row('check_no_such_gate'), row('task_complete')]),
    ).toEqual(['check_no_such_gate', 'task_complete']);
  });
});
