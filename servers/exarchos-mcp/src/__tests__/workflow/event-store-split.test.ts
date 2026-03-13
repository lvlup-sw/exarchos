/**
 * Regression test for GitHub #1009: _events hydration fails silently
 * when the event tools module creates a separate EventStore instance
 * from the workflow tools module.
 *
 * Root cause: event-store/tools.ts:getStore() lazily creates a new
 * EventStore without the StorageBackend, while workflow/tools.ts uses
 * a pre-configured instance with the backend. Events appended via
 * exarchos_event are written to JSONL only, but hydration queries
 * the backend (which doesn't have them).
 *
 * Fix: export configureEventToolsEventStore() from event-store/tools.ts
 * and call it during server initialization with the shared EventStore.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleInit,
  handleSet,
  configureWorkflowEventStore,
  configureWorkflowMaterializer,
} from '../../workflow/tools.js';
import {
  handleEventAppend,
  resetModuleEventStore as resetEventToolsStore,
  configureEventToolsEventStore,
} from '../../event-store/tools.js';
import { EventStore } from '../../event-store/store.js';
import { InMemoryBackend } from '../../storage/memory-backend.js';
import { configureStateStoreBackend } from '../../workflow/state-store.js';
import { configureQueryEventStore } from '../../workflow/query.js';
import { configureNextActionEventStore } from '../../workflow/next-action.js';

// ─── Valid event data matching type-specific schemas ─────────────────────────

const TEAM_SPAWNED_DATA = {
  featureId: 'test',
  teamSize: 2,
  teammateNames: ['agent-a', 'agent-b'],
  taskCount: 1,
  dispatchMode: 'agent-team',
};

const TEAM_DISBANDED_DATA = {
  totalDurationMs: 3000,
  tasksCompleted: 1,
  tasksFailed: 0,
};

describe('EventStoreSplit_Regression_GH1009', () => {
  let stateDir: string;
  let backend: InMemoryBackend;
  let sharedEventStore: EventStore;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-split-store-'));
    backend = new InMemoryBackend();
    // Create EventStore WITH backend — matches production configuration
    sharedEventStore = new EventStore(stateDir, { backend });
    configureStateStoreBackend(backend);
    configureWorkflowEventStore(sharedEventStore);
  });

  afterEach(async () => {
    configureWorkflowEventStore(null);
    configureWorkflowMaterializer(null);
    configureQueryEventStore(null);
    configureNextActionEventStore(null);
    configureStateStoreBackend(undefined);
    resetEventToolsStore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  /**
   * Set up a feature workflow at delegate phase with tasks complete.
   */
  async function setupAtDelegate(featureId: string): Promise<void> {
    await handleInit({ featureId, workflowType: 'feature' }, stateDir);
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
      stateDir,
    );
    await handleSet({ featureId, phase: 'plan' }, stateDir);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/plan.md' } },
      stateDir,
    );
    await handleSet({ featureId, phase: 'plan-review' }, stateDir);
    await handleSet(
      { featureId, updates: { 'planReview.approved': true } },
      stateDir,
    );
    await handleSet({ featureId, phase: 'delegate' }, stateDir);
    await handleSet(
      { featureId, updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      stateDir,
    );
  }

  async function appendTeamSpawned(stream: string): Promise<void> {
    const result = await handleEventAppend(
      {
        stream,
        event: {
          type: 'team.spawned',
          correlationId: stream,
          source: 'orchestrator',
          data: { ...TEAM_SPAWNED_DATA, featureId: stream },
        },
      },
      stateDir,
    );
    expect(result.success).toBe(true);
  }

  async function appendTeamDisbanded(stream: string): Promise<void> {
    const result = await handleEventAppend(
      {
        stream,
        event: {
          type: 'team.disbanded',
          correlationId: stream,
          source: 'orchestrator',
          data: TEAM_DISBANDED_DATA,
        },
      },
      stateDir,
    );
    expect(result.success).toBe(true);
  }

  it('GH1009_WithSharedStore_EventsVisibleToWorkflowHydration', async () => {
    // Fix applied: event tools share the same EventStore as workflow tools
    configureEventToolsEventStore(sharedEventStore);

    await setupAtDelegate('shared-test');

    // Append events via handleEventAppend (the event tools path)
    await appendTeamSpawned('shared-test');
    await appendTeamDisbanded('shared-test');

    // Verify: events ARE in the backend (dual-write via shared store)
    const backendEvents = backend.queryEvents('shared-test');
    expect(backendEvents.some((e) => e.type === 'team.spawned')).toBe(true);
    expect(backendEvents.some((e) => e.type === 'team.disbanded')).toBe(true);

    // Act: Transition delegate -> review
    const result = await handleSet(
      { featureId: 'shared-test', phase: 'review' },
      stateDir,
    );

    // Assert: Transition succeeds (events visible via shared backend)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });

  it('GH1009_WithSeparateStore_EventsNotInBackend', async () => {
    // Reproduce the bug: event tools NOT configured, creates own store
    // without the backend. Events go to JSONL only.
    resetEventToolsStore();
    // Do NOT call configureEventToolsEventStore — simulating pre-fix behavior

    await setupAtDelegate('split-test');
    await appendTeamSpawned('split-test');
    await appendTeamDisbanded('split-test');

    // Verify the events are NOT in the backend (proving the split)
    const backendEvents = backend.queryEvents('split-test');
    const teamEvents = backendEvents.filter(
      (e) => e.type === 'team.spawned' || e.type === 'team.disbanded',
    );
    expect(teamEvents).toHaveLength(0);

    // Workflow hydration queries backend → no team events → guard
    // auto-passes (no team.spawned means subagent mode). This is the
    // subtle form of the bug: guard passes for the wrong reason.
    const result = await handleSet(
      { featureId: 'split-test', phase: 'review' },
      stateDir,
    );
    // Succeeds, but only because hydration missed all team events
    expect(result.success).toBe(true);
  });

  it('GH1009_PartialHydration_GuardFailsWhenEventsSpanStoreInstances', async () => {
    // Reproduce the exact GUARD_FAILED from the bug report:
    // team.spawned in backend (from earlier append with shared store),
    // team.disbanded only in JSONL (appended after store split).
    // Guard sees team.spawned → expects team.disbanded → not found → GUARD_FAILED.

    configureEventToolsEventStore(sharedEventStore);
    await setupAtDelegate('partial-test');

    // Append team.spawned via shared store → dual-written to backend + JSONL
    await appendTeamSpawned('partial-test');

    // Verify team.spawned IS in backend
    expect(backend.queryEvents('partial-test').some((e) => e.type === 'team.spawned')).toBe(true);

    // Simulate the split: reset event tools store so subsequent appends
    // create a separate EventStore without backend
    resetEventToolsStore();

    // Append team.disbanded via separate store → JSONL only, NOT in backend
    await appendTeamDisbanded('partial-test');

    // Verify: team.spawned in backend, team.disbanded NOT in backend
    const backendEvents = backend.queryEvents('partial-test');
    expect(backendEvents.some((e) => e.type === 'team.spawned')).toBe(true);
    expect(backendEvents.some((e) => e.type === 'team.disbanded')).toBe(false);

    // Act: Transition delegate -> review
    // Hydration queries backend: sees team.spawned but NOT team.disbanded
    const result = await handleSet(
      { featureId: 'partial-test', phase: 'review' },
      stateDir,
    );

    // Assert: THIS is the exact failure from the bug report
    expect(result.success).toBe(false);
    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe('GUARD_FAILED');
    expect(String(error.message)).toContain('team-disbanded-emitted');
  });
});
