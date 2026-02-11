import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleInit,
  handleGet,
  handleSet,
  handleSummary,
} from '../../workflow/tools.js';
import { executeTransition, getHSMDefinition } from '../../workflow/state-machine.js';
import { getFixCycleCount, mapInternalToExternalType } from '../../workflow/events.js';
import { appendEvent } from '../../workflow/events.js';
import type { Event, EventType } from '../../workflow/types.js';
import { EventStore } from '../../event-store/store.js';
import type { EventType as ExternalEventType } from '../../event-store/schemas.js';

/**
 * Cross-module boundary integration tests (Gap 2 from audit).
 *
 * These tests exercise real module boundaries — no mocks at boundaries.
 * Each test validates that data written through one module is correctly
 * read and interpreted by another module.
 */
describe('Cross-Module Boundary Tests', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-boundary-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

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

        // Also emit to external event store for handleSummary compatibility
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

  /** Advance feature workflow: ideate → plan → plan-review → delegate */
  async function advanceToDelegate(featureId: string, eventStore?: EventStore): Promise<void> {
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      stateDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'plan' }, stateDir, eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'plan.md' } },
      stateDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'plan-review' }, stateDir, eventStore);
    await handleSet(
      { featureId, updates: { planReview: { approved: true } } },
      stateDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'delegate' }, stateDir, eventStore);
  }

  // ─── Test 1: handleSet → handleGet round-trip ─────────────────────────────

  it('HandleSet_ThenHandleGet_RoundTrip — write then read artifact via dot-path', async () => {
    await handleInit({ featureId: 'round-trip', workflowType: 'feature' }, stateDir);

    await handleSet(
      { featureId: 'round-trip', updates: { 'artifacts.design': 'docs/design.md' } },
      stateDir,
    );

    const result = await handleGet(
      { featureId: 'round-trip', query: 'artifacts.design' },
      stateDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBe('docs/design.md');
  });

  // ─── Test 2: Nested object updates preserve siblings ──────────────────────

  it('HandleSet_NestedObjectUpdate_PreservesSiblings — sequential updates dont clobber', async () => {
    await handleInit({ featureId: 'siblings', workflowType: 'feature' }, stateDir);

    await handleSet(
      { featureId: 'siblings', updates: { 'artifacts.design': 'a' } },
      stateDir,
    );
    await handleSet(
      { featureId: 'siblings', updates: { 'artifacts.plan': 'b' } },
      stateDir,
    );

    const result = await handleGet({ featureId: 'siblings' }, stateDir);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const artifacts = data.artifacts as Record<string, unknown>;
    expect(artifacts.design).toBe('a');
    expect(artifacts.plan).toBe('b');
  });

  // ─── Test 3: Phase transition with dynamic guard field ────────────────────

  it('HandleSet_PhaseTransition_WithDynamicGuardField — dynamic fields survive read for guard eval', async () => {
    await handleInit({ featureId: 'guard-dynamic', workflowType: 'feature' }, stateDir);

    // Advance to plan-review
    await handleSet(
      { featureId: 'guard-dynamic', updates: { 'artifacts.design': 'design.md' } },
      stateDir,
    );
    await handleSet({ featureId: 'guard-dynamic', phase: 'plan' }, stateDir);
    await handleSet(
      { featureId: 'guard-dynamic', updates: { 'artifacts.plan': 'plan.md' } },
      stateDir,
    );
    await handleSet({ featureId: 'guard-dynamic', phase: 'plan-review' }, stateDir);

    // Set dynamic field via handleSet
    await handleSet(
      { featureId: 'guard-dynamic', updates: { planReview: { approved: true } } },
      stateDir,
    );

    // Transition to delegate — guard reads planReview.approved (dynamic field)
    const result = await handleSet(
      { featureId: 'guard-dynamic', phase: 'delegate' },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('delegate');
  });

  // ─── Test 4: Init → Set → Get preserves all default fields ───────────────

  it('HandleInit_ThenHandleSet_ArtifactUpdate_FullStatePreserved — all defaults intact', async () => {
    await handleInit({ featureId: 'full-state', workflowType: 'feature' }, stateDir);

    await handleSet(
      { featureId: 'full-state', updates: { 'artifacts.design': 'design.md' } },
      stateDir,
    );

    const result = await handleGet({ featureId: 'full-state' }, stateDir);
    expect(result.success).toBe(true);

    const state = result.data as Record<string, unknown>;
    expect(state.featureId).toBe('full-state');
    expect(state.workflowType).toBe('feature');
    expect(state.phase).toBe('ideate');
    expect(state.tasks).toEqual([]);
    expect(state.worktrees).toEqual({});
    expect(state.reviews).toEqual({});
    expect(state.synthesis).toBeDefined();
    // _events and _eventSequence removed from schema — events now in external JSONL store
    expect(state._checkpoint).toBeDefined();
    // Event summary is available in _meta
    const meta = result._meta as Record<string, unknown>;
    expect(typeof meta.eventCount).toBe('number');
  });

  // ─── Test 5: Circuit breaker end-to-end with real events ──────────────────

  describe('HandleSummary_CircuitBreakerState_MatchesRealEvents', () => {
    it('should report correct fixCycleCount from real state-machine events', async () => {
      const eventStore = new EventStore(stateDir);
      await handleInit({ featureId: 'cb-e2e', workflowType: 'feature' }, stateDir);

      // Advance to delegate (pass eventStore so transitions are recorded)
      await advanceToDelegate('cb-e2e', eventStore);

      // Perform 2 fix cycles: delegate → review (fail) → delegate
      for (let i = 0; i < 2; i++) {
        // delegate → review (all tasks complete — empty array passes)
        await handleSet({ featureId: 'cb-e2e', phase: 'review' }, stateDir, eventStore);

        // Set review as failed
        await handleSet(
          { featureId: 'cb-e2e', updates: { 'reviews.spec': { status: 'fail' } } },
          stateDir,
          eventStore,
        );

        // review → delegate (fix cycle) — reviews is in Zod schema, so handleSet works
        const fixResult = await transitionRaw('cb-e2e', 'delegate', eventStore);
        expect(fixResult.success).toBe(true);
      }

      // Verify circuit breaker state via handleSummary (pass eventStore)
      const summaryResult = await handleSummary({ featureId: 'cb-e2e' }, stateDir, eventStore);
      expect(summaryResult.success).toBe(true);

      const data = summaryResult.data as Record<string, unknown>;
      const circuitBreaker = data.circuitBreaker as Record<string, unknown>;
      expect(circuitBreaker).toBeDefined();
      expect(circuitBreaker.fixCycleCount).toBe(2);
      expect(circuitBreaker.open).toBe(false);
      expect(circuitBreaker.maxFixCycles).toBe(3);
    });

    it('should show circuit breaker open after max fix cycles', async () => {
      const eventStore = new EventStore(stateDir);
      await handleInit({ featureId: 'cb-open', workflowType: 'feature' }, stateDir);

      await advanceToDelegate('cb-open', eventStore);

      // Perform 3 fix cycles (max for implementation compound): delegate → review (fail) → delegate
      for (let i = 0; i < 3; i++) {
        // delegate → review (all tasks complete — empty array passes)
        await handleSet({ featureId: 'cb-open', phase: 'review' }, stateDir, eventStore);

        // Set review as failed
        await handleSet(
          { featureId: 'cb-open', updates: { 'reviews.spec': { status: 'fail' } } },
          stateDir,
          eventStore,
        );

        // review → delegate (fix cycle)
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

  // ─── Test 6: executeTransition events → getFixCycleCount consistency ──────

  it('CircuitBreaker_EndToEnd_StateMachineFixCycleEventsMatchReaderKey', () => {
    const hsm = getHSMDefinition('feature');

    // Simulate: at review phase with a failed review.
    // Must include compound-entry for 'implementation' because getFixCycleCount
    // only counts fix-cycle events AFTER the last compound-entry anchor.
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

    // Execute fix-cycle transition: review → delegate
    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);

    // Build event array starting with the compound-entry anchor
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

    // getFixCycleCount (from events.ts) should find the fix-cycle event
    const count = getFixCycleCount(events, 'implementation');
    expect(count).toBe(1);
  });
});
