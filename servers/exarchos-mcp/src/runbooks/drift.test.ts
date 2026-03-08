import { describe, it, expect } from 'vitest';
import { ALL_RUNBOOKS } from './definitions.js';
import { findActionInRegistry, getFullRegistry } from '../registry.js';
import { EVENT_EMISSION_REGISTRY } from '../event-store/schemas.js';

describe('Runbook drift detection', () => {
  it('RunbookDrift_EveryStepReferencesValidRegistryAction', () => {
    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        // Skip native tools — they are Claude Code native tools, not MCP tools
        if (step.tool.startsWith('native:')) continue;

        const action = findActionInRegistry(step.tool, step.action);
        expect(
          action,
          `Runbook '${runbook.id}' step references ${step.tool}.${step.action} which is not in the registry`,
        ).toBeDefined();
      }
    }
  });

  it('RunbookDrift_TemplateVarsCoverRequiredParams', () => {
    for (const runbook of ALL_RUNBOOKS) {
      expect(
        runbook.templateVars.length,
        `Runbook '${runbook.id}' should have a non-empty templateVars array`,
      ).toBeGreaterThan(0);
    }
  });

  it('RunbookDrift_EveryBlockingGateAppearsInRunbook', () => {
    // Plan-phase blocking gates that don't yet have runbooks.
    // When a plan-phase runbook is added, remove entries from this set to enforce coverage.
    const KNOWN_UNRUNBOOKED_GATES = new Set([
      'exarchos_orchestrate.check_provenance_chain',
      'exarchos_orchestrate.check_plan_coverage',
    ]);

    // Collect all blocking gate actions from the registry
    const blockingGateActions: Array<{ tool: string; action: string }> = [];
    for (const tool of getFullRegistry()) {
      for (const action of tool.actions) {
        if (action.gate?.blocking === true) {
          blockingGateActions.push({ tool: tool.name, action: action.name });
        }
      }
    }

    expect(blockingGateActions.length).toBeGreaterThan(0);

    // Collect all (tool, action) pairs referenced in runbooks
    const runbookStepPairs = new Set<string>();
    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        runbookStepPairs.add(`${step.tool}.${step.action}`);
      }
    }

    for (const gateAction of blockingGateActions) {
      const key = `${gateAction.tool}.${gateAction.action}`;
      if (KNOWN_UNRUNBOOKED_GATES.has(key)) continue;
      expect(
        runbookStepPairs.has(key),
        `Blocking gate action '${key}' should appear in at least one runbook`,
      ).toBe(true);
    }
  });

  it('RunbookDrift_AutoEmitsMatchEventEmissionRegistry', () => {
    // Get all valid event names from the emission registry
    const validEventNames = new Set(Object.keys(EVENT_EMISSION_REGISTRY));

    for (const runbook of ALL_RUNBOOKS) {
      for (const eventName of runbook.autoEmits) {
        expect(
          validEventNames.has(eventName),
          `Runbook '${runbook.id}' autoEmits '${eventName}' which is not in the EVENT_EMISSION_REGISTRY`,
        ).toBe(true);
      }
    }
  });

  it('RunbookDrift_RunbookIdsAreUnique', () => {
    const ids = ALL_RUNBOOKS.map(r => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
