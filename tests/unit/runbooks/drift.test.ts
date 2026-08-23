// ── A DR-30 note on the bijection at the foot of this file ──────────────────
//
// The two things it compares — `runbook.autoEmits` in `./definitions.ts` and the
// `ToolAction.autoEmits` the registry declares — are hand-written in two places,
// but `../registry.ts` REACHES `./definitions.ts` in the static import graph, so
// DR-30 counts them as one authority wearing two names. That is why the
// assertions are per-element membership checks rather than
// `expect(missingIds).toEqual([])`: a census-diff assertion claims two
// independent oracles, and this comparison has one. Same form as the emission
// registry containment check above, for the same reason.
//
// This is a real limit on what the check proves. It cannot witness that the
// REGISTRY is right about what a tool emits — only that the runbook's summary
// and the registry's own declaration agree.
import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from '../../../src/utils/json-schema.js';
import { ALL_RUNBOOKS, TASK_COMPLETION } from '../../../src/runbooks/definitions.js';
import { findActionInRegistry, getFullRegistry } from '../../../src/registry.js';
import { EVENT_EMISSION_REGISTRY } from '../../../src/events/schemas.js';
import type { RunbookDefinition } from '../../../src/runbooks/types.js';

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
 *
 * ── The two directions do NOT range over the same edges ─────────────────────
 *
 * `condition: 'conditional'` means the edge fires on a predicate the registry
 * cannot evaluate here — `workflow.fix-cycle` lands only when a phase is
 * re-entered rather than advanced. That asymmetry is the whole reason the
 * subject is a parameter:
 *
 *   `'unconditional'` — what a runbook OWES a declaration. `autoEmits` is read
 *      by an agent to decide it need not append the record itself, and that
 *      inference is only safe for an edge that always fires. Demanding a
 *      conditional edge be declared would force the runbook to promise a record
 *      the tool may never write.
 *   `'every'` — what a declaration is ALLOWED to name. Declaring a conditional
 *      emission is legitimate: it tells the agent the tool covers that event
 *      when the predicate holds. Only an event no step can emit under any
 *      condition is a phantom.
 *
 * Reading one subject for both directions is what made this check wrong: a
 * newly declared conditional edge read as an undeclared emission, which is the
 * same conflation `interceptors/emission-verifier.ts` calls out — a conditional
 * edge is not required, and its absence is not evidence of anything.
 */
type EmissionSubject = 'unconditional' | 'every';

function stepDerivedAutoEmits(
  runbook: RunbookDefinition,
  subject: EmissionSubject,
): readonly string[] {
  const events = new Set<string>();
  for (const step of runbook.steps) {
    if (step.tool.startsWith('native:') || step.tool === 'none') continue;
    const action = findActionInRegistry(step.tool, step.action);
    // `action?.autoEmits === undefined` folded two different facts into one
    // `continue`: "this action emits nothing" and "there is no such action".
    // Under the second, a runbook whose steps had all stopped resolving derived
    // an EMPTY emission set — and an empty set agrees with an empty declaration
    // in both directions, so the bijection below passed by having nothing to
    // compare. An unresolved step is a broken runbook, not a quiet one.
    if (action === undefined) {
      throw new Error(
        `Runbook '${runbook.id}' step references ${step.tool}.${step.action}, which does not ` +
          'resolve in the registry — the derived emission set would silently be empty.',
      );
    }
    if (action.autoEmits === undefined) continue;
    for (const emission of action.autoEmits) {
      if (subject === 'unconditional' && emission.condition !== 'always') continue;
      events.add(emission.event);
    }
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

/**
 * The two directions as callables, so the negative fixtures can RUN them.
 *
 * They were inline `expect`s over `ALL_RUNBOOKS`, and the fixtures below only
 * re-checked their own preconditions — that the phantom event is absent from the
 * derived set, that the under-declarer derives something. Neither ever put a
 * malformed runbook through the assertion it was built to trip, so deleting the
 * assertion entirely would have left both fixtures green. Throwing rather than
 * `expect`ing is what makes them executable against a subject expected to fail.
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

describe('Runbook autoEmits ⇄ step-derived emissions (bijection)', () => {
  it('RunbookAutoEmits_EventDeclaredButNoStepEmits_FailsBijection', () => {
    // FORWARD: nothing is advertised that the steps do not produce. This is the
    // direction the deletion lost.
    for (const runbook of ALL_RUNBOOKS) {
      expect(() => assertNothingDeclaredThatNoStepEmits(runbook)).not.toThrow();
    }

    // The fixture proves the assertion can fail: a runbook that declares one more
    // event than its steps produce is rejected. Built from a REAL runbook so the
    // only difference from a passing subject is the phantom entry — and put
    // THROUGH the assertion, not merely inspected.
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

  it('RunbookAutoEmits_StepEmitsButNotDeclared_FailsBijection', () => {
    // REVERSE: nothing the steps produce goes unadvertised. An undeclared
    // emission is the mirror failure — the agent appends a duplicate record
    // because the runbook did not say the tool already had.
    for (const runbook of ALL_RUNBOOKS) {
      expect(() => assertNothingEmittedThatIsNotDeclared(runbook)).not.toThrow();
    }

    const underDeclarer: RunbookDefinition = { ...TASK_COMPLETION, autoEmits: [] };
    expect(stepDerivedAutoEmits(underDeclarer, 'unconditional').length).toBeGreaterThan(0);
    expect(() => assertNothingEmittedThatIsNotDeclared(underDeclarer)).toThrow(
      /which it does not declare in autoEmits/,
    );

    // The narrowing is load-bearing, so prove it is what carries the pass and
    // not an empty subject. `agent-teams-saga` steps through
    // `exarchos_workflow.transition`, which declares `workflow.fix-cycle`
    // CONDITIONALLY and does not name it in the runbook's `autoEmits`. Under the
    // `'every'` subject that reads as an undeclared emission; under
    // `'unconditional'` it is correctly out of subject. Both halves are asserted:
    // drop the condition filter and the first expectation fails.
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

  it('RunbookAutoEmits_DerivationHasANonEmptySubject', () => {
    // The denominator. Both assertions above are vacuously true if the derivation
    // resolves nothing — a moved registry, a renamed action, a `findActionInRegistry`
    // that started returning `undefined`. At least one runbook must actually
    // derive emissions, and the whole set must be non-trivial.
    const emitting = ALL_RUNBOOKS.filter((r) => stepDerivedAutoEmits(r, 'unconditional').length > 0);
    expect(emitting.length).toBeGreaterThan(0);
    expect(ALL_RUNBOOKS.length).toBeGreaterThan(emitting.length);

    // Cardinality both ways on a concrete runbook, so "every declared entry is
    // derived" cannot be satisfied by a derivation that returns everything.
    const derived = stepDerivedAutoEmits(TASK_COMPLETION, 'unconditional');
    expect(derived.length).toBe(TASK_COMPLETION.autoEmits.length);
    expect(derived.length).toBeGreaterThan(1);
  });
});
