// @oracle-sources: ../../../src/events/consumer-closure-audit.ts, ../../../src/projections/views/registry.ts
// The audit reads the annotation table; the live consumer population is
// assembled HERE, from the reducers and the view-name registry, because the
// events layer is not allowed to import the projections (the layering
// inversion `event-registration.ts` records). This file is the one place the
// two sides meet.
/**
 * Consumer closure: every declared `consumedBy` names a consumer that exists.
 *
 * `ConsumerId` is an open `string` reference — the non-empty tuple stops an
 * empty consumer list from compiling, and nothing stopped a list from naming
 * a reducer that was deleted. A registration like that boots clean and reads
 * as a live fold while pointing at nothing. This suite closes the reference:
 * the live population is enumerated from the actual reducer ids and the
 * view-name registry, and every `consumedBy` entry must resolve into it.
 */

import { describe, it, expect } from 'vitest';

import { auditConsumerClosure } from '../../../src/events/consumer-closure-audit.js';
import type { EventRegistration } from '../../../src/events/event-registration.js';
import { BUILTIN_VIEW_NAMES } from '../../../src/projections/views/registry.js';
import { rehydrationReducer } from '../../../src/projections/rehydration/reducer.js';
import { workflowStateReducer } from '../../../src/projections/workflow-state/reducer.js';
import { taskStoreReducer } from '../../../src/projections/taskstore/reducer.js';
import { mergeOrchestratorReducer } from '../../../src/projections/merge-orchestrator/reducer.js';
import { nextActionReducer } from '../../../src/projections/next-action/reducer.js';
import { createWorktreesReducer } from '../../../src/verbs/worktree/projections/worktrees.js';

/**
 * The live consumer population: every reducer id plus every registered view
 * name. Assembled by IMPORTING each consumer, so a deleted reducer breaks
 * this file at the import — the population cannot silently shrink past the
 * suite that quantifies over it.
 */
function liveConsumerPopulation(): ReadonlySet<string> {
  return new Set([
    ...BUILTIN_VIEW_NAMES,
    rehydrationReducer.id,
    workflowStateReducer.id,
    taskStoreReducer.id,
    mergeOrchestratorReducer.id,
    nextActionReducer.id,
    createWorktreesReducer().id,
  ]);
}

describe('consumer closure', () => {
  it('ConsumerClosure_LiveTree_EveryConsumedByResolves', () => {
    const population = liveConsumerPopulation();

    // The population itself gets denominators before it judges anything: it
    // must contain both kinds of consumer, or the audit is comparing the
    // annotations against a partial world and calling misses real.
    expect(population.size, 'the live population is empty').toBeGreaterThan(20);
    expect(population.has('rehydration@v1'), 'no reducer id made it into the population').toBe(
      true,
    );
    expect(population.has('pipeline'), 'no view name made it into the population').toBe(true);

    const audit = auditConsumerClosure(population);

    // DENOMINATORS FIRST. A clean verdict over zero consumer-bearing rows is
    // a check that read nothing.
    expect(audit.rowsWithConsumers, 'no registration carries a consumedBy').toBeGreaterThan(30);
    expect(audit.referencedConsumerCount, 'no consumer is referenced').toBeGreaterThan(8);

    expect(audit.unresolved, 'a consumedBy names a consumer that does not exist').toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('ConsumerClosure_DeletedConsumer_IsNamed', () => {
    // The kill probe over the LIVE annotations: remove one real consumer from
    // the population and every registration pointing at it must be named. If
    // this stops finding anything, the reducer id changed and the live test
    // above has already failed on the import.
    const population = new Set(liveConsumerPopulation());
    population.delete('rehydration@v1');

    const audit = auditConsumerClosure(population);

    expect(audit.ok).toBe(false);
    expect(audit.unresolved.length).toBeGreaterThan(0);
    expect(new Set(audit.unresolved.map((row) => row.consumer))).toEqual(
      new Set(['rehydration@v1']),
    );
  });

  it('ConsumerClosure_SeededGhostConsumer_IsNamedWithItsEvent', () => {
    // The audit itself, against seeded annotations: the finding carries the
    // event, the tier, and the ghost consumer, so the fix is one grep away.
    const annotations: Readonly<Record<string, EventRegistration>> = {
      'seeded.event': {
        lifecycle: 'active',
        tier: 'capability',
        provider: 'exarchos_orchestrate',
        consumedBy: ['ghost-consumer@v1'],
      },
    };

    const audit = auditConsumerClosure(new Set(['real-consumer@v1']), annotations);

    expect(audit.ok).toBe(false);
    expect(audit.rowsWithConsumers).toBe(1);
    expect(audit.unresolved).toHaveLength(1);
    expect(audit.unresolved[0]?.event).toBe('seeded.event');
    expect(audit.unresolved[0]?.tier).toBe('capability');
    expect(audit.unresolved[0]?.consumer).toBe('ghost-consumer@v1');
  });

  it('ConsumerClosure_EmptyPopulation_FailsClosed', () => {
    // An audit handed no population has measured nothing. Reporting a clean
    // tree from it would be the vacuous pass this layer keeps refusing.
    const audit = auditConsumerClosure(new Set<string>());

    expect(audit.ok).toBe(false);
    expect(audit.livePopulationSize).toBe(0);
  });
});
