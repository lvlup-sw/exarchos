// @oracle-sources: ../../../src/events/consumer-closure-audit.ts, ../../../src/projections/views/registry.ts
// The audit reads the annotation table. This file builds the live consumer population
// from the reducers and the view-name registry, because the events layer cannot import
// the projections. This file is the one place where the two sides meet.
/**
 * Consumer closure: every declared `consumedBy` names a consumer that exists.
 *
 * `ConsumerId` is an open `string` reference. The non-empty tuple rejects an empty consumer
 * list, but a list can name a deleted reducer. Such a registration boots clean and points at
 * nothing. Each `consumedBy` entry must resolve into the live population.
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
 * The live consumer population: every reducer id and every registered view name.
 * This file imports each reducer, so a deleted reducer breaks the file at the import.
 * The population cannot shrink without a failure of this suite.
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
  /**
   * The case first checks the population, which must hold a reducer id and a view name.
   * With a partial population, the audit reports a miss for a consumer that exists.
   * The case then checks the counts of the audit. A clean verdict over zero rows read nothing.
   */
  it('ConsumerClosure_LiveTree_EveryConsumedByResolves', () => {
    const population = liveConsumerPopulation();

    expect(population.size, 'the live population is empty').toBeGreaterThan(20);
    expect(population.has('rehydration@v1'), 'no reducer id made it into the population').toBe(
      true,
    );
    expect(population.has('pipeline'), 'no view name made it into the population').toBe(true);

    const audit = auditConsumerClosure(population);

    expect(audit.rowsWithConsumers, 'no registration carries a consumedBy').toBeGreaterThan(30);
    expect(audit.referencedConsumerCount, 'no consumer is referenced').toBeGreaterThan(8);

    expect(audit.unresolved, 'a consumedBy names a consumer that does not exist').toEqual([]);
    expect(audit.ok).toBe(true);
  });

  /**
   * The kill probe over the live annotations. The case removes one real consumer from the
   * population, and the audit must report that consumer and no other.
   */
  it('ConsumerClosure_DeletedConsumer_IsNamed', () => {
    const population = new Set(liveConsumerPopulation());
    population.delete('rehydration@v1');

    const audit = auditConsumerClosure(population);

    expect(audit.ok).toBe(false);
    expect(audit.unresolved.length).toBeGreaterThan(0);
    expect(new Set(audit.unresolved.map((row) => row.consumer))).toEqual(
      new Set(['rehydration@v1']),
    );
  });

  /** The audit over seeded annotations. The finding carries the event, the tier, and the missing consumer. */
  it('ConsumerClosure_SeededGhostConsumer_IsNamedWithItsEvent', () => {
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

  /** An audit with no population measured nothing, so it must not report a clean tree. */
  it('ConsumerClosure_EmptyPopulation_FailsClosed', () => {
    const audit = auditConsumerClosure(new Set<string>());

    expect(audit.ok).toBe(false);
    expect(audit.livePopulationSize).toBe(0);
  });
});
