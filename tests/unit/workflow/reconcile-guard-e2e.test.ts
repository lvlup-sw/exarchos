import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleInit,
  handleSet,
  } from '../../../src/workflow/tools.js';
import { reconcileFromEvents } from '../../../src/workflow/state-store.js';
import { EventStore } from '../../../src/events/store.js';
import type { EventType } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('ReconcileGuardE2E', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-reconcile-guard-e2e-'));
    eventStore = new EventStore(stateDir);
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

  async function setupAtDelegate(featureId: string): Promise<void> {
    await handleInit({ featureId, workflowType: 'feature' }, stateDir, eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
      stateDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'plan' }, stateDir, eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/plan.md' } },
      stateDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'plan-review' }, stateDir, eventStore);
    await handleSet(
      { featureId, updates: { 'planReview.approved': true } },
      stateDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'delegate' }, stateDir, eventStore);
    await handleSet(
      { featureId, updates: { tasks: [{ id: 't1', title: 't1', status: 'complete' }] } },
      stateDir,
      eventStore,
    );
  }

  /**
   * Reconcile hydrates `_events` from the event stream, also when the team events change no other state field.
   * The guard on the transition to review reads `_events`.
   */
  it('ReconcileGuardE2E_DelegateToReview_SucceedsAfterReconcile', async () => {
    await setupAtDelegate('e2e-success');

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

    await reconcileFromEvents(stateDir, 'e2e-success', eventStore);

    const rawState = await readRawState('e2e-success');
    const events = rawState._events as Array<Record<string, unknown>>;
    expect(events).toBeDefined();
    expect(events.some((e) => e.type === 'team.disbanded')).toBe(true);

    const result = await handleSet(
      { featureId: 'e2e-success', phase: 'review' },
      stateDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });

  /** With no team events in the stream, as in subagent mode, the team guard passes. */
  it('ReconcileGuardE2E_DelegateToReview_NoTeamSpawned_SkipsGuard', async () => {
    await setupAtDelegate('e2e-no-team');

    await reconcileFromEvents(stateDir, 'e2e-no-team', eventStore);

    const result = await handleSet(
      { featureId: 'e2e-no-team', phase: 'review' },
      stateDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });

  it('ReconcileGuardE2E_DelegateToReview_TeamSpawnedButNotDisbanded_Fails', async () => {
    await setupAtDelegate('e2e-no-disband');

    await eventStore.append('e2e-no-disband', {
      type: 'team.spawned' as EventType,
      correlationId: 'e2e-no-disband',
      source: 'orchestrator',
      data: { featureId: 'e2e-no-disband', agentCount: 2 },
    });

    await reconcileFromEvents(stateDir, 'e2e-no-disband', eventStore);

    const result = await handleSet(
      { featureId: 'e2e-no-disband', phase: 'review' },
      stateDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe('GUARD_FAILED');
    expect(String(error.message)).toContain('team-disbanded-emitted');
  });
});
