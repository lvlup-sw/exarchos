import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ALL_RUNBOOKS, TASK_COMPLETION } from './definitions.js';
import { findActionInRegistry, getFullRegistry } from '../registry.js';
import { EVENT_EMISSION_REGISTRY } from '../event-store/schemas.js';
import { computeRunbookAutoEmits } from './compute.js';

describe('Runbook drift detection', () => {
  it('RunbookDrift_EveryStepReferencesValidRegistryAction', () => {
    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        // Skip native tools — they are Claude Code native tools, not MCP tools
        if (step.tool.startsWith('native:')) continue;
        // Skip decision steps — they are advisory-only, not MCP tool calls
        if (step.tool === 'none') continue;

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
      for (const step of runbook.steps) {
        if (step.tool.startsWith('native:')) continue;
        if (step.tool === 'none') continue;

        const action = findActionInRegistry(step.tool, step.action);
        if (!action) continue; // covered by EveryStepReferencesValidRegistryAction

        const jsonSchema = zodToJsonSchema(action.schema) as {
          required?: string[];
        };
        const required = jsonSchema.required ?? [];

        for (const field of required) {
          // The 'action' field is the discriminator — auto-filled by the composite router
          if (field === 'action') continue;

          const covered =
            runbook.templateVars.includes(field) ||
            (step.params != null && field in step.params);
          expect(
            covered,
            `Runbook '${runbook.id}' missing coverage for required field '${field}' ` +
            `in ${step.tool}.${step.action} — add to templateVars or step.params`,
          ).toBe(true);
        }
      }
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

        const source = EVENT_EMISSION_REGISTRY[eventName as keyof typeof EVENT_EMISSION_REGISTRY];
        expect(
          source,
          `Runbook '${runbook.id}' autoEmits '${eventName}' but its source is '${source}', expected 'auto'`,
        ).toBe('auto');
      }
    }
  });

  it('RunbookDrift_RunbookIdsAreUnique', () => {
    const ids = ALL_RUNBOOKS.map(r => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('ComputeRunbookAutoEmits_TaskCompletion_MatchesDeclared', () => {
    const computed = computeRunbookAutoEmits(TASK_COMPLETION);
    const declared = [...TASK_COMPLETION.autoEmits].sort();
    expect(computed).toEqual(declared);
  });

  it('RunbookDrift_AutoEmitsMatchComputedFromToolActions', () => {
    for (const runbook of ALL_RUNBOOKS) {
      const computed = computeRunbookAutoEmits(runbook);
      const declared = [...runbook.autoEmits].sort();
      expect(
        computed,
        `Runbook '${runbook.id}' declared autoEmits ${JSON.stringify(declared)} ` +
        `does not match computed ${JSON.stringify(computed)} from ToolAction.autoEmits`,
      ).toEqual(declared);
    }
  });
});
