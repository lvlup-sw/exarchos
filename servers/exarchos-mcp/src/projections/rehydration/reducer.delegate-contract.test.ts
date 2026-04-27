import { describe, it, expect } from 'vitest';
import { getRegisteredEventTypes } from './reducer.js';
import { PHASE_EXPECTED_EVENTS } from '../../orchestrate/check-event-emissions.js';
import { getPlaybook } from '../../workflow/playbooks.js';
import { EVENT_EMISSION_REGISTRY, type EventType } from '../../event-store/schemas.js';

/**
 * Filter a reducer-registry list to the model-emitted subset — the contract
 * surface visible to hints and playbook. Auto-emitted events (task.completed,
 * task.failed) are recognised by the reducer for state folding but never
 * advertised to the model, so they live in the SoT but not in either
 * downstream surface.
 */
function modelEmittedRegisteredEventTypes(phase: string): readonly EventType[] {
  return getRegisteredEventTypes(phase).filter(
    (t) => EVENT_EMISSION_REGISTRY[t as EventType] === 'model',
  ) as readonly EventType[];
}

/**
 * Fix 3 (#1180) — DIM-3 single-source-of-truth for the delegate event contract.
 *
 * The rehydration reducer's set of registered event handlers is the canonical
 * source of truth for which events MATTER on a given phase. Two downstream
 * surfaces — the `_eventHints.missing` generator (PHASE_EXPECTED_EVENTS in
 * orchestrate/check-event-emissions.ts) and the delegate-phase playbook events
 * list (workflow/playbooks.ts) — used to maintain INDEPENDENT lists of event
 * types and drifted silently. For example, prior to this fix:
 *
 *   - reducer handlers:        task.assigned, task.completed, task.failed
 *   - PHASE_EXPECTED_EVENTS:   team.spawned, team.task.planned,
 *                              team.teammate.dispatched, task.progressed
 *   - playbook events:         task.assigned, team.spawned,
 *                              team.teammate.dispatched, team.disbanded,
 *                              gate.executed, task.progressed
 *
 * `team.task.planned` was recommended by hints, absent from the playbook, and
 * unhandled by the reducer — silent drift that the test below now catches.
 *
 * After Fix 3, all three surfaces derive from `getRegisteredEventTypes(phase)`
 * exposed by reducer.ts; this test asserts the equality of the contract.
 */
describe('delegate event contract — single source of truth (#1180, DIM-3)', () => {
  it('PHASE_EXPECTED_EVENTS_delegate_EqualsReducerRegisteredSet', () => {
    // GIVEN: the reducer's registered event-type set for the delegate phase
    const reducerSet = new Set<string>(modelEmittedRegisteredEventTypes('delegate'));

    // AND: the eventHints generator's expected-event list for the delegate phase
    const hintsSet = new Set<string>(PHASE_EXPECTED_EVENTS['delegate'] ?? []);

    // THEN: the two sets are exactly equal — no drift in either direction.
    // We compute the symmetric difference explicitly so a failing assertion
    // surfaces the offending event types in the diff (rather than just
    // "expected 8 to equal 4").
    const onlyInReducer = [...reducerSet].filter((t) => !hintsSet.has(t)).sort();
    const onlyInHints = [...hintsSet].filter((t) => !reducerSet.has(t)).sort();

    expect({ onlyInReducer, onlyInHints }).toEqual({
      onlyInReducer: [],
      onlyInHints: [],
    });
  });

  it('PHASE_EXPECTED_EVENTS_overhaulDelegate_EqualsReducerRegisteredSet', () => {
    // Same SoT contract for the refactor-workflow `overhaul-delegate` phase.
    const reducerSet = new Set<string>(modelEmittedRegisteredEventTypes('overhaul-delegate'));
    const hintsSet = new Set<string>(PHASE_EXPECTED_EVENTS['overhaul-delegate'] ?? []);

    const onlyInReducer = [...reducerSet].filter((t) => !hintsSet.has(t)).sort();
    const onlyInHints = [...hintsSet].filter((t) => !reducerSet.has(t)).sort();

    expect({ onlyInReducer, onlyInHints }).toEqual({
      onlyInReducer: [],
      onlyInHints: [],
    });
  });

  it('Playbook_delegate_EventTypes_EqualReducerRegisteredSet', () => {
    // GIVEN: the reducer's registered event-type set for the delegate phase
    const reducerSet = new Set<string>(modelEmittedRegisteredEventTypes('delegate'));

    // AND: the delegate playbook's declared event-emission contract
    const playbook = getPlaybook('feature', 'delegate');
    expect(playbook).not.toBeNull();
    const playbookSet = new Set<string>(
      (playbook?.events ?? []).map((e) => e.type),
    );

    // THEN: the two sets are exactly equal — playbook advertises exactly the
    // events the reducer/hints contract recognises.
    const onlyInReducer = [...reducerSet].filter((t) => !playbookSet.has(t)).sort();
    const onlyInPlaybook = [...playbookSet].filter((t) => !reducerSet.has(t)).sort();

    expect({ onlyInReducer, onlyInPlaybook }).toEqual({
      onlyInReducer: [],
      onlyInPlaybook: [],
    });
  });

  it('Playbook_overhaulDelegate_EventTypes_EqualReducerRegisteredSet', () => {
    const reducerSet = new Set<string>(modelEmittedRegisteredEventTypes('overhaul-delegate'));
    const playbook = getPlaybook('refactor', 'overhaul-delegate');
    expect(playbook).not.toBeNull();
    const playbookSet = new Set<string>(
      (playbook?.events ?? []).map((e) => e.type),
    );

    const onlyInReducer = [...reducerSet].filter((t) => !playbookSet.has(t)).sort();
    const onlyInPlaybook = [...playbookSet].filter((t) => !reducerSet.has(t)).sort();

    expect({ onlyInReducer, onlyInPlaybook }).toEqual({
      onlyInReducer: [],
      onlyInPlaybook: [],
    });
  });
});
