// Runbook definitions must agree with the tool-action registry and the event emission registry.
//
// The last suite compares `runbook.autoEmits` with the emissions that the registry declares for
// the steps. `registry.ts` reaches `definitions.ts` in the static import graph, so the two sides
// are one authority, not two independent oracles. Thus the two direction checks test one element
// at a time for membership. They do not compare two full sets.
//
// The suite proves that the two declarations agree. It cannot prove that the registry is correct
// about the events that a tool emits.
import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from '../../../src/utils/json-schema.js';
import { ALL_RUNBOOKS, TASK_COMPLETION } from '../../../src/runbooks/definitions.js';
import { contractEmissionsOf, findActionInRegistry, getFullRegistry } from '../../../src/registry.js';
import { EVENT_EMISSION_REGISTRY } from '../../../src/events/schemas.js';
import type { RunbookDefinition } from '../../../src/runbooks/types.js';

/**
 * The emission edges that a derivation reads.
 *
 * `'unconditional'` holds the edges that always fire. A runbook must declare these, because an
 * agent reads `autoEmits` to know that it need not append the record.
 * `'every'` adds the conditional edges, which a runbook can declare but does not owe. For
 * example, `workflow.fix-cycle` fires only when a workflow enters a phase again.
 */
type EmissionSubject = 'unconditional' | 'every';

/**
 * The events that the steps of a runbook cause, read from the registry. No production module
 * needs this derivation, so it stays in this file.
 *
 * Native steps and decision steps make no MCP call, so they emit nothing. The function throws
 * when a step does not resolve in the registry. A silent skip gives an empty set, and an empty
 * set agrees with an empty declaration.
 */
function stepDerivedAutoEmits(
  runbook: RunbookDefinition,
  subject: EmissionSubject,
): readonly string[] {
  const events = new Set<string>();
  for (const step of runbook.steps) {
    if (step.tool.startsWith('native:') || step.tool === 'none') continue;
    const action = findActionInRegistry(step.tool, step.action);
    if (action === undefined) {
      throw new Error(
        `Runbook '${runbook.id}' step references ${step.tool}.${step.action}, which does not ` +
          'resolve in the registry — the derived emission set would silently be empty.',
      );
    }
    const emissions = contractEmissionsOf(action);
    if (emissions.length === 0) continue;
    for (const emission of emissions) {
      if (subject === 'unconditional' && emission.condition !== 'always') continue;
      events.add(emission.event);
    }
  }
  return [...events].sort();
}

/** A `native:` step and a `none` step are not MCP tool calls, so the registry checks skip them. */
describe('Runbook drift detection', () => {
  it('RunbookDrift_EveryStepReferencesValidRegistryAction', () => {
    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        if (step.tool.startsWith('native:')) continue;
        if (step.tool === 'none') continue;

        const action = findActionInRegistry(step.tool, step.action);
        expect(
          action,
          `Runbook '${runbook.id}' step references ${step.tool}.${step.action} which is not in the registry`,
        ).toBeDefined();
      }
    }
  });

  /**
   * `RunbookDrift_EveryStepReferencesValidRegistryAction` covers a step that does not resolve, so
   * this test skips such a step. The composite router fills the `action` field, so the test
   * does not require coverage for that field.
   */
  it('RunbookDrift_TemplateVarsCoverRequiredParams', () => {
    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        if (step.tool.startsWith('native:')) continue;
        if (step.tool === 'none') continue;

        const action = findActionInRegistry(step.tool, step.action);
        if (!action) continue;

        const jsonSchema = zodToJsonSchema(action.schema) as {
          required?: string[];
        };
        const required = jsonSchema.required ?? [];

        for (const field of required) {
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

  /**
   * `KNOWN_UNRUNBOOKED_GATES` lists the blocking gates that no runbook holds. When a runbook
   * gets one of these gates, remove that gate from the list so the test covers it.
   */
  it('RunbookDrift_EveryBlockingGateAppearsInRunbook', () => {
    const KNOWN_UNRUNBOOKED_GATES = new Set([
      'exarchos_orchestrate.check_exploration_depth',
      'exarchos_orchestrate.debug_review_gate',
      'exarchos_orchestrate.pre_synthesis_check',
    ]);

    const blockingGateActions: Array<{ tool: string; action: string }> = [];
    for (const tool of getFullRegistry()) {
      for (const action of tool.actions) {
        if (action.gate?.blocking === true) {
          blockingGateActions.push({ tool: tool.name, action: action.name });
        }
      }
    }

    expect(blockingGateActions.length).toBeGreaterThan(0);

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

/**
 * Throws when the runbook declares an event that no step can emit. It throws and does not call
 * `expect`, so a test can run it on a runbook that must fail.
 */
function assertNothingDeclaredThatNoStepEmits(runbook: RunbookDefinition): void {
  const derived = new Set(stepDerivedAutoEmits(runbook, 'every'));
  for (const event of runbook.autoEmits) {
    if (!derived.has(event)) {
      throw new Error(
        `Runbook '${runbook.id}' declares autoEmits '${event}' that no step produces. An agent ` +
          'reads autoEmits to decide it need not append the record itself, so a phantom entry ' +
          'means the record is never written and nobody is told.',
      );
    }
  }
}

/** Throws when a step always emits an event that the runbook does not declare. */
function assertNothingEmittedThatIsNotDeclared(runbook: RunbookDefinition): void {
  const declared = new Set(runbook.autoEmits);
  for (const event of stepDerivedAutoEmits(runbook, 'unconditional')) {
    if (!declared.has(event)) {
      throw new Error(
        `Runbook '${runbook.id}' steps emit '${event}' which it does not declare in autoEmits.`,
      );
    }
  }
}

/**
 * `RunbookDrift_AutoEmitsMatchEventEmissionRegistry` proves only that each declared name is a
 * registered `'auto'` event. This suite also compares the declaration with the events that the
 * steps of the runbook cause, in the two directions.
 */
describe('Runbook autoEmits ⇄ step-derived emissions (bijection)', () => {
  /**
   * No runbook declares an event that its steps cannot emit. The fixture is `TASK_COMPLETION`
   * with one added event that no step emits. The assertion rejects the fixture, which proves
   * that the assertion can fail.
   */
  it('RunbookAutoEmits_EventDeclaredButNoStepEmits_FailsBijection', () => {
    for (const runbook of ALL_RUNBOOKS) {
      expect(() => assertNothingDeclaredThatNoStepEmits(runbook)).not.toThrow();
    }

    const phantomDeclarer: RunbookDefinition = {
      ...TASK_COMPLETION,
      autoEmits: [...TASK_COMPLETION.autoEmits, 'workflow.transition'],
    };
    expect(new Set(stepDerivedAutoEmits(phantomDeclarer, 'every')).has('workflow.transition')).toBe(
      false,
    );
    expect(() => assertNothingDeclaredThatNoStepEmits(phantomDeclarer)).toThrow(
      /declares autoEmits 'workflow\.transition'/,
    );
  });

  /**
   * If a runbook does not declare an emission, the agent appends a second record.
   *
   * The `agent-teams-saga` runbook proves that the condition filter does the work. The registry
   * declares `workflow.fix-cycle` as conditional for its transition step, and the runbook does not
   * declare that event. The `'every'` subject reports the event, and `'unconditional'` does not.
   */
  it('RunbookAutoEmits_StepEmitsButNotDeclared_FailsBijection', () => {
    for (const runbook of ALL_RUNBOOKS) {
      expect(() => assertNothingEmittedThatIsNotDeclared(runbook)).not.toThrow();
    }

    const underDeclarer: RunbookDefinition = { ...TASK_COMPLETION, autoEmits: [] };
    expect(stepDerivedAutoEmits(underDeclarer, 'unconditional').length).toBeGreaterThan(0);
    expect(() => assertNothingEmittedThatIsNotDeclared(underDeclarer)).toThrow(
      /which it does not declare in autoEmits/,
    );

    const conditionalUnderDeclarer = ALL_RUNBOOKS.find((r) => r.id === 'agent-teams-saga');
    expect(conditionalUnderDeclarer).toBeDefined();
    if (conditionalUnderDeclarer !== undefined) {
      const declared = new Set(conditionalUnderDeclarer.autoEmits);
      expect(
        stepDerivedAutoEmits(conditionalUnderDeclarer, 'every').filter((e) => !declared.has(e)),
      ).toContain('workflow.fix-cycle');
      expect(
        stepDerivedAutoEmits(conditionalUnderDeclarer, 'unconditional').filter(
          (e) => !declared.has(e),
        ),
      ).toEqual([]);
    }
  });

  /**
   * A derivation that returns no event passes the check for undeclared emissions with no
   * evidence. Thus some runbooks must derive emissions, and some must derive none. For
   * `TASK_COMPLETION` the derived count equals the declared count, so a derivation that returns
   * every event also fails.
   */
  it('RunbookAutoEmits_DerivationHasANonEmptySubject', () => {
    const emitting = ALL_RUNBOOKS.filter((r) => stepDerivedAutoEmits(r, 'unconditional').length > 0);
    expect(emitting.length).toBeGreaterThan(0);
    expect(ALL_RUNBOOKS.length).toBeGreaterThan(emitting.length);

    const derived = stepDerivedAutoEmits(TASK_COMPLETION, 'unconditional');
    expect(derived.length).toBe(TASK_COMPLETION.autoEmits.length);
    expect(derived.length).toBeGreaterThan(1);
  });
});
