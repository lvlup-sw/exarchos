import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from '../adapters/json-schema.js';
import { ALL_RUNBOOKS, TASK_COMPLETION } from './definitions.js';
import { findActionInRegistry, getFullRegistry } from '../registry.js';
import { EVENT_EMISSION_REGISTRY } from '../event-store/schemas.js';
import type { RunbookDefinition } from './types.js';

/**
 * The events a runbook's STEPS actually cause, derived from the registry.
 *
 * This lived in `runbooks/compute.ts` until it was deleted as dead production
 * code — correctly, since its only callers were tests. Deleting the module took
 * the bijection with it, which is the part that was not dead: what survived is
 * one-directional (every declared name is a real `'auto'` event) and that
 * direction cannot see a runbook declaring an event no step emits. So the
 * derivation is re-homed HERE, where its only caller lives, rather than restored
 * as a production module with no production importer.
 *
 * Native steps (`native:` tools) and decision steps (`none`) are skipped: they
 * are not MCP calls and emit nothing through the registry.
 */
function stepDerivedAutoEmits(runbook: RunbookDefinition): readonly string[] {
  const events = new Set<string>();
  for (const step of runbook.steps) {
    if (step.tool.startsWith('native:') || step.tool === 'none') continue;
    const action = findActionInRegistry(step.tool, step.action);
    if (action?.autoEmits === undefined) continue;
    for (const emission of action.autoEmits) events.add(emission.event);
  }
  return [...events].sort();
}

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
      'exarchos_orchestrate.check_exploration_depth',
      'exarchos_orchestrate.debug_review_gate',
      'exarchos_orchestrate.pre_synthesis_check',
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
});

// ─── The bijection, re-homed (task 085) ─────────────────────────────────────
//
// `RunbookDrift_AutoEmitsMatchEventEmissionRegistry` above checks CONTAINMENT in
// one direction: every declared name is a registered `'auto'` event. It says
// nothing about whether the runbook's own steps produce that event, so a runbook
// advertising an emission no step causes reads as correct — and `autoEmits` is
// what an agent consults to decide it need not append the record itself.
//
// Both directions are asserted below, against a set DERIVED from the registry
// rather than transcribed.

describe('Runbook autoEmits ⇄ step-derived emissions (bijection)', () => {
  it('RunbookAutoEmits_EventDeclaredButNoStepEmits_FailsBijection', () => {
    // FORWARD: nothing is advertised that the steps do not produce. This is the
    // direction the deletion lost.
    for (const runbook of ALL_RUNBOOKS) {
      const derived = new Set(stepDerivedAutoEmits(runbook));
      const phantom = [...runbook.autoEmits].filter((event) => !derived.has(event)).sort();
      expect(
        phantom,
        `Runbook '${runbook.id}' declares autoEmits ${JSON.stringify(phantom)} that no step ` +
          'produces. An agent reads autoEmits to decide it need not append the record itself, so ' +
          'a phantom entry means the record is never written and nobody is told.',
      ).toEqual([]);
    }

    // The fixture proves the assertion can fail: a runbook that declares one more
    // event than its steps produce is rejected. Built from a REAL runbook so the
    // only difference from a passing subject is the phantom entry.
    const phantomDeclarer: RunbookDefinition = {
      ...TASK_COMPLETION,
      autoEmits: [...TASK_COMPLETION.autoEmits, 'workflow.transition'],
    };
    const derived = new Set(stepDerivedAutoEmits(phantomDeclarer));
    expect([...phantomDeclarer.autoEmits].filter((e) => !derived.has(e))).toEqual([
      'workflow.transition',
    ]);
  });

  it('RunbookAutoEmits_StepEmitsButNotDeclared_FailsBijection', () => {
    // REVERSE: nothing the steps produce goes unadvertised. An undeclared
    // emission is the mirror failure — the agent appends a duplicate record
    // because the runbook did not say the tool already had.
    for (const runbook of ALL_RUNBOOKS) {
      const declared = new Set(runbook.autoEmits);
      const undeclared = stepDerivedAutoEmits(runbook).filter((event) => !declared.has(event));
      expect(
        undeclared,
        `Runbook '${runbook.id}' steps emit ${JSON.stringify(undeclared)} which it does not ` +
          'declare in autoEmits.',
      ).toEqual([]);
    }

    const underDeclarer: RunbookDefinition = { ...TASK_COMPLETION, autoEmits: [] };
    expect(stepDerivedAutoEmits(underDeclarer).length).toBeGreaterThan(0);
  });

  it('RunbookAutoEmits_DerivationHasANonEmptySubject', () => {
    // The denominator. Both assertions above are vacuously true if the derivation
    // resolves nothing — a moved registry, a renamed action, a `findActionInRegistry`
    // that started returning `undefined`. At least one runbook must actually
    // derive emissions, and the whole set must be non-trivial.
    const emitting = ALL_RUNBOOKS.filter((r) => stepDerivedAutoEmits(r).length > 0);
    expect(emitting.length).toBeGreaterThan(0);
    expect(ALL_RUNBOOKS.length).toBeGreaterThan(emitting.length);
    expect(stepDerivedAutoEmits(TASK_COMPLETION)).toEqual([...TASK_COMPLETION.autoEmits].sort());
  });
});
