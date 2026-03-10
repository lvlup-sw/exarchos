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
import { reconcileFromEvents } from '../../workflow/state-store.js';
import { EventStore } from '../../event-store/store.js';
import { configureQueryEventStore } from '../../workflow/query.js';
import { configureNextActionEventStore } from '../../workflow/next-action.js';
import type { EventType } from '../../event-store/schemas.js';

describe('ReconcileGuardE2E', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-reconcile-guard-e2e-'));
    eventStore = new EventStore(stateDir);
    configureWorkflowEventStore(eventStore);
  });

  afterEach(async () => {
    configureWorkflowEventStore(null);
    configureWorkflowMaterializer(null);
    configureQueryEventStore(null);
    configureNextActionEventStore(null);
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  /**
   * Read raw state JSON from disk, bypassing Zod validation.
   */
  async function readRawState(featureId: string): Promise<Record<string, unknown>> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    return JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
  }

  /**
   * Write raw state JSON to disk, bypassing Zod validation.
   */
  async function writeRawState(
    featureId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  }

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

  it('ReconcileGuardE2E_DelegateToReview_SucceedsAfterReconcile', async () => {
    // Arrange: Set up workflow at delegate phase
    await setupAtDelegate('e2e-success');

    // Append team events to the JSONL store (simulating orchestrator behavior)
    await eventStore.append('e2e-success', {
      type: 'team.spawned' as EventType,
      correlationId: 'e2e-success',
      source: 'orchestrator',
      data: { featureId: 'e2e-success', agentCount: 3 },
    });
    await eventStore.append('e2e-success', {
      type: 'team.disbanded' as EventType,
      correlationId: 'e2e-success',
      source: 'orchestrator',
      data: {
        featureId: 'e2e-success',
        totalDurationMs: 5000,
        tasksCompleted: 1,
        tasksFailed: 0,
      },
    });

    // Reconcile to populate _events from event stream.
    // Note: reconciled may be false because team events don't mutate state
    // (applyEventToState only handles workflow.started/transition/checkpoint).
    // But _events hydration still runs after the event application loop.
    await reconcileFromEvents(stateDir, 'e2e-success', eventStore);

    // Verify _events was populated after reconcile
    const rawState = await readRawState('e2e-success');
    const events = rawState._events as Array<Record<string, unknown>>;
    expect(events).toBeDefined();
    expect(events.some((e) => e.type === 'team.disbanded')).toBe(true);

    // Act: Transition delegate -> review
    const result = await handleSet(
      { featureId: 'e2e-success', phase: 'review' },
      stateDir,
    );

    // Assert: Transition succeeds (guard passes because _events was hydrated)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });

  it('ReconcileGuardE2E_DelegateToReview_NoTeamSpawned_SkipsGuard', async () => {
    // Arrange: Set up workflow at delegate without team events (subagent mode)
    await setupAtDelegate('e2e-no-team');

    // Reconcile (no team events in stream)
    await reconcileFromEvents(stateDir, 'e2e-no-team', eventStore);

    // Act: Transition delegate -> review
    const result = await handleSet(
      { featureId: 'e2e-no-team', phase: 'review' },
      stateDir,
    );

    // Assert: Transition succeeds (guard auto-passes when no team was spawned)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });

  it('ReconcileGuardE2E_DelegateToReview_TeamSpawnedButNotDisbanded_Fails', async () => {
    // Arrange: Set up workflow at delegate with team.spawned but NOT team.disbanded
    await setupAtDelegate('e2e-no-disband');

    await eventStore.append('e2e-no-disband', {
      type: 'team.spawned' as EventType,
      correlationId: 'e2e-no-disband',
      source: 'orchestrator',
      data: { featureId: 'e2e-no-disband', agentCount: 2 },
    });

    // Reconcile to populate _events
    await reconcileFromEvents(stateDir, 'e2e-no-disband', eventStore);

    // Act: Attempt transition delegate -> review
    const result = await handleSet(
      { featureId: 'e2e-no-disband', phase: 'review' },
      stateDir,
    );

    // Assert: Transition fails because team was spawned but not disbanded
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe('GUARD_FAILED');
    expect(String(error.message)).toContain('team-disbanded-emitted');
  });
});
