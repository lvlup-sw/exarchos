/**
 * Tests that `handleSet` sends each phase update through `HSMTransitionGuard.attempt`.
 * A guarded transition appends `workflow.transition` on a pass or `workflow.guard-failed` on a fail, never both.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit, handleSet } from '../../../src/workflow/tools.js';
import { DefaultHSMTransitionGuard, buildHsmEventData } from '../../../src/workflow/hsm-transition-guard.js';
import {
  BUILT_IN_WORKFLOW_TYPES,
  LEGACY_TRANSITION_CORPUS_POSTURE,
  legacyTransitionCorpus,
} from './__fixtures__/transition-admission-corpus.js';
import { getHSMDefinition } from '../../../src/workflow/state-machine.js';
import { EventStore } from '../../../src/events/store.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { EVENT_DATA_SCHEMAS } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;
const featureId = 'hsm-guard-test';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-guard-'));
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

describe('legacy transition-decision migration baseline (DR-1)', () => {
  it('LegacyTransitionCorpus_AllFixtures_HaveStableVerdicts', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    const guard = new DefaultHSMTransitionGuard();

    expect(LEGACY_TRANSITION_CORPUS_POSTURE).toBe('audit-shadow');

    const edgeKey = (workflowType: string, from: string, to: string) =>
      `${workflowType}:${from}->${to}`;
    const builtInEdges = BUILT_IN_WORKFLOW_TYPES.flatMap((workflowType) =>
      getHSMDefinition(workflowType).transitions.map((transition) =>
        edgeKey(workflowType, transition.from, transition.to),
      ),
    ).sort();
    const representativeFixtures = legacyTransitionCorpus.filter(
      (fixture) => fixture.scenario !== 'bypass',
    );
    const representedEdges = [
      ...new Set(
        representativeFixtures.map((fixture) =>
          edgeKey(fixture.workflowType, fixture.from, fixture.to),
        ),
      ),
    ].sort();

    expect(representedEdges).toEqual(builtInEdges);
    expect(new Set(legacyTransitionCorpus.map((fixture) => fixture.id)).size).toBe(
      legacyTransitionCorpus.length,
    );
    expect(JSON.parse(JSON.stringify(legacyTransitionCorpus))).toEqual(
      legacyTransitionCorpus,
    );
    for (const edge of builtInEdges) {
      expect(
        representativeFixtures
          .filter((fixture) =>
            edgeKey(fixture.workflowType, fixture.from, fixture.to) === edge,
          )
          .map((fixture) => fixture.scenario)
          .sort(),
        edge,
      ).toEqual(['representative-fail', 'representative-pass']);
    }

    expect(
      legacyTransitionCorpus
        .filter((fixture) => fixture.scenario === 'bypass')
        .map((fixture) => fixture.id),
    ).toEqual([
      'bypass-empty-task-collection-is-complete',
      'bypass-always-pass-implementation-ignores-fail-shaped-state',
      'bypass-patched-plan-approval-is-authoritative',
      'bypass-patched-review-status-is-authoritative',
      'bypass-unknown-risk-does-not-block-plan-edge',
      'bypass-stale-gate-event-is-not-consulted',
    ]);

    for (const fixture of legacyTransitionCorpus) {
      const evaluate = async (run: number) => {
        const featureId = `${fixture.id}-run-${run}`;
        const result = await guard.attempt(featureId, fixture.from, fixture.to, {
          state: { ...fixture.state, featureId, phase: fixture.from },
          workflowType: fixture.workflowType,
          eventStore,
        });

        return result.ok
          ? {
              verdict: 'allow' as const,
              explanation: `Legacy HSM admitted ${fixture.from} -> ${fixture.to}`,
            }
          : {
              verdict: 'deny' as const,
              explanation: result.errorMessage,
            };
      };

      const first = await evaluate(1);
      const second = await evaluate(2);

      expect(first, fixture.id).toEqual(fixture.expected);
      expect(second, fixture.id).toEqual(fixture.expected);
      expect(first, fixture.id).toEqual(second);
      expect(first.explanation.length, fixture.id).toBeGreaterThan(0);
    }
  });
});

/**
 * Patch the raw state file to advance phase to `delegate` and seed tasks.
 * The feature HSM transition `delegate → review` requires the composite
 * guard `all-tasks-complete + team-disbanded` to pass. We bypass earlier
 * phases by editing the state file directly so each test isolates the
 * guard-on-set behavior, not the multi-phase walk.
 */
async function patchStateForDelegatePhase(opts: {
  tasks?: Array<{ id: string; title: string; status: string }>;
}): Promise<void> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
  raw.phase = 'delegate';
  if (opts.tasks !== undefined) raw.tasks = opts.tasks;
  await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');
}

/** Count events of a given type in the JSONL store for `featureId`. */
async function countEvents(
  store: EventStore,
  type: string,
  filter?: (e: WorkflowEvent) => boolean,
): Promise<number> {
  const events = await store.query(featureId, { type: type as never });
  return filter ? events.filter(filter).length : events.length;
}

describe('HSMTransitionGuard.fail_closed (C7, closes #1225)', () => {
  /** An incomplete task fails the `delegate` to `review` guard, so no `workflow.transition` to `review` lands. */
  it('workflowSet_phaseUpdateWithFailedGuard_doesNotEmitTransition', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await patchStateForDelegatePhase({
      tasks: [{ id: 't1', title: 'task one', status: 'in_progress' }],
    });

    const result = await handleSet(
      { featureId, phase: 'review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(false);

    const transitionsToReview = await countEvents(
      eventStore,
      'workflow.transition',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(transitionsToReview).toBe(0);
  });

  it('workflowSet_phaseUpdateWithFailedGuard_emitsGuardFailedOnly', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await patchStateForDelegatePhase({
      tasks: [{ id: 't1', title: 'task one', status: 'in_progress' }],
    });

    const result = await handleSet(
      { featureId, phase: 'review' },
      tmpDir,
      eventStore,
    );
    expect(result.success).toBe(false);

    const guardFailures = await countEvents(
      eventStore,
      'workflow.guard-failed',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(guardFailures).toBe(1);

    const transitions = await countEvents(
      eventStore,
      'workflow.transition',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(transitions).toBe(0);
  });

  /** An update without a `phase` key must not run the guard, so it appends no transition and no guard-failed event. */
  it('workflowSet_nonPhaseUpdates_passThroughUnchanged', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);

    const result = await handleSet(
      { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const transitions = await countEvents(eventStore, 'workflow.transition');
    expect(transitions).toBe(0);
    const guardFailures = await countEvents(eventStore, 'workflow.guard-failed');
    expect(guardFailures).toBe(0);
  });

  /**
   * An empty task list passes `allTasksComplete`.
   * A log without `team.spawned` passes `teamDisbandedEmitted`.
   * So the `delegate` to `review` guard passes.
   */
  it('workflowSet_phaseUpdateWithPassingGuard_emitsSingleTransition', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await patchStateForDelegatePhase({ tasks: [] });

    const result = await handleSet(
      { featureId, phase: 'review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');

    const transitions = await countEvents(
      eventStore,
      'workflow.transition',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(transitions).toBe(1);

    const guardFailures = await countEvents(
      eventStore,
      'workflow.guard-failed',
      (e) => (e.data as Record<string, unknown>).to === 'review',
    );
    expect(guardFailures).toBe(0);
  });
});

/**
 * A passing transition persists one `phase.entered` event with a schema-valid frozen obligation.
 * The event keeps its canonical type and does not get the `workflow.` prefix of the `mapInternalToExternalType` fallback.
 */
describe('HSMTransitionGuard phase.entered freeze (DR-13)', () => {
  it('passingTransition_PersistsOnePhaseEnteredWithFrozenObligation', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await patchStateForDelegatePhase({ tasks: [] });

    const result = await handleSet({ featureId, phase: 'review' }, tmpDir, eventStore);
    expect(result.success).toBe(true);

    const entered = await eventStore.query(featureId, { type: 'phase.entered' as never });
    const toReview = entered.filter(
      (e) => (e.data as Record<string, unknown>).phase === 'review',
    );
    expect(toReview).toHaveLength(1);

    const data = toReview[0].data as Record<string, unknown>;
    expect(data.kind).toBe('REVIEW');
    expect(data.resolver).toBe('review-contract');
    expect(data.policySource).toBe('builtin');
    expect(data.mode).toBe('enforce');
    expect(Array.isArray(data.resolvedGates)).toBe(true);
    const schema = EVENT_DATA_SCHEMAS['phase.entered'];
    expect(schema?.safeParse(data).success).toBe(true);

    const mangled = await countEvents(eventStore, 'workflow.phase.entered');
    expect(mangled).toBe(0);
  });
});

/**
 * A faulting gate-set resolver makes `executeTransition` return `PHASE_BLOCKED` and a `phase.blocked` event.
 * The guard must keep the `PHASE_BLOCKED` code and must not change it to `GUARD_FAILED`.
 * It must persist one schema-valid event of the canonical `phase.blocked` type.
 */
describe('HSMTransitionGuard phase.blocked fail-closed (DR-7)', () => {
  /** The real resolver does not throw for valid input, so the test injects a faulting `resolveGatesFn`. */
  it('blockedTransition_PreservesPhaseBlockedCode_PersistsCanonicalSchemaValidEvent', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await patchStateForDelegatePhase({ tasks: [] });
    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

    const guard = new DefaultHSMTransitionGuard();
    const result = await guard.attempt(featureId, 'delegate', 'review', {
      state,
      workflowType: 'feature',
      eventStore,
      resolveGatesFn: () => {
        throw new Error('resolver boom');
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('PHASE_BLOCKED');
    }

    const blocked = await eventStore.query(featureId, {
      type: 'phase.blocked' as never,
    });
    expect(blocked).toHaveLength(1);

    const data = blocked[0].data as Record<string, unknown>;
    expect(EVENT_DATA_SCHEMAS['phase.blocked']?.safeParse(data).success).toBe(true);
    expect(data.kind).toBe('REVIEW');
    expect(data.phase).toBe('review');

    expect(await countEvents(eventStore, 'workflow.phase.blocked')).toBe(0);

    const enteredReview = await countEvents(
      eventStore,
      'phase.entered',
      (e) => (e.data as Record<string, unknown>).phase === 'review',
    );
    expect(enteredReview).toBe(0);
  });
});

/**
 * `allRequiredGatesPassed` is a required boolean of `PhaseExitedData`.
 * `buildHsmEventData` must not coerce a missing or non-boolean value to `false`, because that records a wrong exit status.
 * It returns `undefined`, and the schema rejects that value.
 */
describe('buildHsmEventData phase.exited gate-status integrity (DR-13)', () => {
  const exitEvt = (allRequiredGatesPassed: unknown) => ({
    type: 'phase.exited',
    from: 'delegate',
    to: 'review',
    trigger: 'execute-transition',
    metadata: { phase: 'delegate', allRequiredGatesPassed },
  });

  it('preserves an explicit boolean gate status', () => {
    expect(buildHsmEventData(exitEvt(true), featureId, {}).allRequiredGatesPassed).toBe(true);
    expect(buildHsmEventData(exitEvt(false), featureId, {}).allRequiredGatesPassed).toBe(false);
  });

  it('surfaces undefined (NOT false) for a missing/non-boolean gate status, failing the schema', () => {
    for (const bad of [undefined, 'true', 1, null]) {
      const data = buildHsmEventData(exitEvt(bad), featureId, {});
      expect(data.allRequiredGatesPassed).toBeUndefined();
      expect(EVENT_DATA_SCHEMAS['phase.exited']?.safeParse(data).success).toBe(false);
    }
  });
});

/**
 * `EventStore.append` checks only the envelope and skips `EVENT_DATA_SCHEMAS`.
 * The HSM emission boundary must check event data against `EVENT_DATA_SCHEMAS`, so invalid data never reaches the log.
 */
describe('HSM emission boundary schema-validates event data (T-03, #1339)', () => {
  /** In the feature HSM, `review` to `delegate` is a fix cycle. A failed review makes the `anyReviewFailed` guard pass. */
  it('LegacyAppendPath_SchemaInvalidWorkflowEvent_IsRejected', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);

    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'review';
    raw.reviews = { 'reviewer-a': { status: 'failed' } };
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleSet(
      { featureId, phase: 'delegate' },
      tmpDir,
      eventStore,
    );
    expect(result.success).toBe(true);

    const fixCycleEvents = await eventStore.query(featureId, {
      type: 'workflow.fix-cycle' as never,
    });
    expect(fixCycleEvents.length).toBeGreaterThanOrEqual(1);

    const fixCycleSchema = EVENT_DATA_SCHEMAS['workflow.fix-cycle'];
    expect(fixCycleSchema).toBeDefined();
    for (const evt of fixCycleEvents) {
      const parsed = fixCycleSchema!.safeParse(evt.data);
      expect(parsed.success).toBe(true);
    }
  });
});
