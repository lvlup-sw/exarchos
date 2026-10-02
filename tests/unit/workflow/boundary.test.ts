import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleInit,
  handleGet,
  handleSet,
  handleSummary,
} from '../../../src/workflow/tools.js';
import { executeTransition, getHSMDefinition } from '../../../src/workflow/state-machine.js';
import { getFixCycleCount, mapInternalToExternalType } from '../../../src/workflow/events.js';
import { appendEvent } from '../../../src/workflow/events.js';
import type { Event, EventType } from '../../../src/workflow/types.js';
import { EventStore } from '../../../src/events/store.js';
import type { EventType as ExternalEventType } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Cross-module boundary tests with no mocks at the boundaries.
 * Each test writes data through one module and reads it through another.
 */
describe('Cross-Module Boundary Tests', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-boundary-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  async function readRawState(featureId: string): Promise<Record<string, unknown>> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    return JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
  }

  async function writeRawState(
    featureId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  }

  async function transitionRaw(
    featureId: string,
    targetPhase: string,
    eventStore?: EventStore,
  ): Promise<{ success: boolean; errorCode?: string }> {
    const raw = await readRawState(featureId);
    const hsm = getHSMDefinition(raw.workflowType as string);
    const result = executeTransition(hsm, raw, targetPhase);

    if (!result.success) {
      return { success: false, errorCode: result.errorCode };
    }

    if (!result.idempotent && result.newPhase) {
      raw.phase = result.newPhase;

      let events = (raw._events ?? []) as Event[];
      let eventSequence = (raw._eventSequence ?? 0) as number;

      for (const te of result.events) {
        const appended = appendEvent(
          events,
          eventSequence,
          te.type as EventType,
          te.trigger,
          { from: te.from, to: te.to, metadata: te.metadata },
        );
        events = appended.events;
        eventSequence = appended.eventSequence;

        if (eventStore) {
          await eventStore.append(featureId, {
            type: mapInternalToExternalType(te.type) as ExternalEventType,
            data: {
              from: te.from,
              to: te.to,
              trigger: te.trigger,
              featureId,
              ...(te.metadata ?? {}),
            },
          });
        }
      }

      raw._events = events;
      raw._eventSequence = eventSequence;

      if (result.historyUpdates) {
        const history = (raw._history ?? {}) as Record<string, string>;
        for (const [key, value] of Object.entries(result.historyUpdates)) {
          history[key] = value;
        }
        raw._history = history;
      }

      const checkpoint = (raw._checkpoint ?? {}) as Record<string, unknown>;
      checkpoint.phase = result.newPhase;
      checkpoint.operationsSince = 0;
      checkpoint.timestamp = new Date().toISOString();
      raw._checkpoint = checkpoint;
    }

    raw.updatedAt = new Date().toISOString();
    await writeRawState(featureId, raw);
    return { success: true };
  }

  async function advanceToDelegate(featureId: string, eventStore?: EventStore): Promise<void> {
    const es = eventStore ?? null;
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      stateDir,
      es,
    );
    await handleSet({ featureId, phase: 'plan' }, stateDir, es);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'plan.md' } },
      stateDir,
      es,
    );
    await handleSet({ featureId, phase: 'plan-review' }, stateDir, es);
    await handleSet(
      { featureId, updates: { planReview: { approved: true } } },
      stateDir,
      es,
    );
    await handleSet({ featureId, phase: 'delegate' }, stateDir, es);
  }

  it('HandleSet_ThenHandleGet_RoundTrip — write then read artifact via dot-path', async () => {
    await handleInit({ featureId: 'round-trip', workflowType: 'feature' }, stateDir, null);

    await handleSet(
      { featureId: 'round-trip', updates: { 'artifacts.design': 'docs/design.md' } },
      stateDir,
      null,
    );

    const result = await handleGet(
      { featureId: 'round-trip', query: 'artifacts.design' },
      stateDir,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBe('docs/design.md');
  });

  it('HandleSet_NestedObjectUpdate_PreservesSiblings — sequential updates dont clobber', async () => {
    await handleInit({ featureId: 'siblings', workflowType: 'feature' }, stateDir, null);

    await handleSet(
      { featureId: 'siblings', updates: { 'artifacts.design': 'a' } },
      stateDir,
      null,
    );
    await handleSet(
      { featureId: 'siblings', updates: { 'artifacts.plan': 'b' } },
      stateDir,
      null,
    );

    const result = await handleGet({ featureId: 'siblings' }, stateDir, null);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const artifacts = data.artifacts as Record<string, unknown>;
    expect(artifacts.design).toBe('a');
    expect(artifacts.plan).toBe('b');
  });

  /** The guard on the plan-review to delegate transition reads `planReview.approved`. */
  it('HandleSet_PhaseTransition_WithDynamicGuardField — dynamic fields survive read for guard eval', async () => {
    await handleInit({ featureId: 'guard-dynamic', workflowType: 'feature' }, stateDir, null);

    await handleSet(
      { featureId: 'guard-dynamic', updates: { 'artifacts.design': 'design.md' } },
      stateDir,
      null,
    );
    await handleSet({ featureId: 'guard-dynamic', phase: 'plan' }, stateDir, null);
    await handleSet(
      { featureId: 'guard-dynamic', updates: { 'artifacts.plan': 'plan.md' } },
      stateDir,
      null,
    );
    await handleSet({ featureId: 'guard-dynamic', phase: 'plan-review' }, stateDir, null);

    await handleSet(
      { featureId: 'guard-dynamic', updates: { planReview: { approved: true } } },
      stateDir,
      null,
    );

    const result = await handleSet(
      { featureId: 'guard-dynamic', phase: 'delegate' },
      stateDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('delegate');
  });

  it('HandleInit_ThenHandleSet_ArtifactUpdate_FullStatePreserved — all defaults intact', async () => {
    await handleInit({ featureId: 'full-state', workflowType: 'feature' }, stateDir, null);

    await handleSet(
      { featureId: 'full-state', updates: { 'artifacts.design': 'design.md' } },
      stateDir,
      null,
    );

    const result = await handleGet({ featureId: 'full-state' }, stateDir, null);
    expect(result.success).toBe(true);

    const state = result.data as Record<string, unknown>;
    expect(state.featureId).toBe('full-state');
    expect(state.workflowType).toBe('feature');
    expect(state.phase).toBe('plan');
    expect(state.tasks).toEqual([]);
    expect(state.worktrees).toEqual({});
    expect(state.reviews).toEqual({});
    expect(state.synthesis).toBeDefined();
    expect(state._checkpoint).toBeDefined();
    const meta = result._meta as Record<string, unknown>;
    expect(meta).toBeDefined();
  });

  /**
   * Each fix cycle moves review back to delegate through `transitionRaw`.
   * That helper also appends the transition events to the event store, because `handleSummary` reads them there.
   */
  describe('HandleSummary_CircuitBreakerState_MatchesRealEvents', () => {
    it('should report correct fixCycleCount from real state-machine events', async () => {
      const eventStore = new EventStore(stateDir);
      await handleInit({ featureId: 'cb-e2e', workflowType: 'feature' }, stateDir, eventStore);

      await advanceToDelegate('cb-e2e', eventStore);

      for (let i = 0; i < 2; i++) {
        await eventStore.append('cb-e2e', {
          type: 'team.disbanded',
          data: { totalDurationMs: 5000, tasksCompleted: 1, tasksFailed: 0 },
        });
        await handleSet({ featureId: 'cb-e2e', phase: 'review' }, stateDir, eventStore);

        await handleSet(
          { featureId: 'cb-e2e', updates: { 'reviews.spec': { status: 'fail' } } },
          stateDir,
          eventStore,
        );

        const fixResult = await transitionRaw('cb-e2e', 'delegate', eventStore);
        expect(fixResult.success).toBe(true);
      }

      const summaryResult = await handleSummary({ featureId: 'cb-e2e' }, stateDir, eventStore);
      expect(summaryResult.success).toBe(true);

      const data = summaryResult.data as Record<string, unknown>;
      const circuitBreaker = data.circuitBreaker as Record<string, unknown>;
      expect(circuitBreaker).toBeDefined();
      expect(circuitBreaker.fixCycleCount).toBe(2);
      expect(circuitBreaker.open).toBe(false);
      expect(circuitBreaker.maxFixCycles).toBe(3);
    });

    /** Three fix cycles reach the limit for the implementation compound state. */
    it('should show circuit breaker open after max fix cycles', async () => {
      const eventStore = new EventStore(stateDir);
      await handleInit({ featureId: 'cb-open', workflowType: 'feature' }, stateDir, eventStore);

      await advanceToDelegate('cb-open', eventStore);

      for (let i = 0; i < 3; i++) {
        await eventStore.append('cb-open', {
          type: 'team.disbanded',
          data: { totalDurationMs: 5000, tasksCompleted: 1, tasksFailed: 0 },
        });
        await handleSet({ featureId: 'cb-open', phase: 'review' }, stateDir, eventStore);

        await handleSet(
          { featureId: 'cb-open', updates: { 'reviews.spec': { status: 'fail' } } },
          stateDir,
          eventStore,
        );

        const fixResult = await transitionRaw('cb-open', 'delegate', eventStore);
        expect(fixResult.success).toBe(true);
      }

      const summaryResult = await handleSummary({ featureId: 'cb-open' }, stateDir, eventStore);
      expect(summaryResult.success).toBe(true);

      const data = summaryResult.data as Record<string, unknown>;
      const circuitBreaker = data.circuitBreaker as Record<string, unknown>;
      expect(circuitBreaker).toBeDefined();
      expect(circuitBreaker.fixCycleCount).toBe(3);
      expect(circuitBreaker.open).toBe(true);
    });
  });

  /**
   * The events start with a `compound-entry` for `implementation`.
   * `getFixCycleCount` counts only the fix-cycle events after the last such entry.
   */
  it('CircuitBreaker_EndToEnd_StateMachineFixCycleEventsMatchReaderKey', () => {
    const hsm = getHSMDefinition('feature');

    const compoundEntry: Event = {
      sequence: 1,
      version: '1.0',
      timestamp: new Date().toISOString(),
      type: 'compound-entry',
      from: 'plan-review',
      to: 'implementation',
      trigger: 'execute-transition',
      metadata: { compoundStateId: 'implementation' },
    };

    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: { spec: { status: 'fail' } },
      _events: [compoundEntry],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);

    let events: Event[] = [compoundEntry];
    let seq = 1;
    for (const te of result.events) {
      const appended = appendEvent(
        events,
        seq,
        te.type as EventType,
        te.trigger,
        { from: te.from, to: te.to, metadata: te.metadata },
      );
      events = appended.events;
      seq = appended.eventSequence;
    }

    const count = getFixCycleCount(events, 'implementation');
    expect(count).toBe(1);
  });
});
