// Checks that `handleSet` enforces the checkpoint gate on a phase transition when `operationsSince` is above the threshold.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit, handleSet, handleCheckpoint } from '../../../src/workflow/tools.js';
import { readStateFile, writeStateFile } from '../../../src/workflow/state-store.js';
import type { WorkflowState } from '../../../src/workflow/types.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import { DEFAULTS } from '../../../src/config/resolve.js';
import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-checkpoint-gate-'));
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

/** Builds `handleSet` options from the default checkpoint config and the given overrides. */
function makeOptions(checkpointOverrides?: Partial<ResolvedProjectConfig['checkpoint']>) {
  return {
    checkpoint: {
      ...DEFAULTS.checkpoint,
      ...checkpointOverrides,
    },
  };
}

describe('handleSet checkpoint gate', () => {
  const featureId = 'gate-test';

  async function initWorkflow() {
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, null);
  }

  async function setOperationsSince(value: number) {
    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw._checkpoint.operationsSince = value;
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');
  }

  /** The default threshold is 20. */
  it('workflowSet_PhaseTransitionAboveThreshold_ReturnsCheckpointRequired', async () => {
    await initWorkflow();
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );
    await setOperationsSince(25);

    const result = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      null,
      makeOptions(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('CHECKPOINT_REQUIRED');
    const errorData = result.error as Record<string, unknown>;
    expect(errorData.gate).toBe('checkpoint_required');
    expect(errorData.operationsSince).toBe(25);
    expect(errorData.threshold).toBe(20);
  });

  it('workflowSet_PhaseTransitionBelowThreshold_ProceedsNormally', async () => {
    await initWorkflow();
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );
    await setOperationsSince(5);

    const result = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      null,
      makeOptions(),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');
  });

  it('workflowSet_NoPhaseParam_SkipsCheckpointGate', async () => {
    await initWorkflow();
    await setOperationsSince(25);

    const result = await handleSet(
      { featureId, updates: { 'synthesis.status': 'ready' } },
      tmpDir,
      null,
      makeOptions(),
    );

    expect(result.success).toBe(true);
  });

  it('workflowSet_ConfiguredThreshold30_UsesConfigValue', async () => {
    await initWorkflow();
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );

    await setOperationsSince(25);
    const resultBelow = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      null,
      makeOptions({ operationThreshold: 30 }),
    );
    expect(resultBelow.success).toBe(true);
  });

  it('workflowSet_ConfiguredThreshold30_GatesAbove', async () => {
    await initWorkflow();
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );

    await setOperationsSince(35);
    const result = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      null,
      makeOptions({ operationThreshold: 30 }),
    );
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('CHECKPOINT_REQUIRED');
    const errorData = result.error as Record<string, unknown>;
    expect(errorData.threshold).toBe(30);
    expect(errorData.operationsSince).toBe(35);
  });

  it('workflowSet_ConfigDisablesPhaseTransition_SkipsGate', async () => {
    await initWorkflow();
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );

    await setOperationsSince(100);
    const result = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      null,
      makeOptions({ enforceOnPhaseTransition: false }),
    );
    expect(result.success).toBe(true);
  });

  it('workflowSet_CheckpointGateFires_EmitsCheckpointEnforcedEvent', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      eventStore,
    );
    await setOperationsSince(25);

    const result = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      eventStore,
      makeOptions(),
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('CHECKPOINT_REQUIRED');

    const events = await eventStore.query(featureId, { type: 'checkpoint.enforced' as never });
    expect(events.length).toBe(1);
    const eventData = events[0].data as Record<string, unknown>;
    expect(eventData.operationsSince).toBe(25);
    expect(eventData.threshold).toBe(20);
    expect(eventData.blockedAction).toBe('phase-transition');
  });

  /**
   * In `handleSet`, Zod defaults fill `_checkpoint`, so this test does not drive the event through `handleSet`.
   * It checks that `shouldEnforceCheckpoint` returns the `checkpoint-state-missing` warning for a null checkpoint.
   * Then it appends a `checkpoint.state_missing` event directly to prove that the store accepts the type.
   */
  it('checkpointStateMissing_EmitsCheckpointStateMissingEvent', async () => {
    const { shouldEnforceCheckpoint } = await import('../../../src/workflow/checkpoint.js');

    const result = shouldEnforceCheckpoint(
      null,
      { operationThreshold: 20, enforceOnPhaseTransition: true, enforceOnWaveDispatch: true },
      'phase-transition',
    );

    expect(result.gated).toBe(false);
    expect(result.warning).toBe('checkpoint-state-missing');

    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    const event = await eventStore.append(featureId, {
      type: 'checkpoint.state_missing' as import('../../../src/events/schemas.js').EventType,
      correlationId: featureId,
      source: 'workflow',
      data: { action: 'set' },
    });
    expect(event.type).toBe('checkpoint.state_missing');

    const events = await eventStore.query(featureId, { type: 'checkpoint.state_missing' as never });
    expect(events.length).toBe(1);
    expect((events[0].data as Record<string, unknown>).action).toBe('set');
  });

  /**
   * The plan artifact satisfies the guard on the plan to plan-review transition.
   * `handleCheckpoint` resets `operationsSince` to 0 and does not count as an operation itself.
   * The checkpoint event records `plan`, the phase before the blocked transition.
   */
  it('checkpointEnforcement_GateFires_ThenCheckpoint_ThenRetry_Succeeds', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      tmpDir,
      eventStore,
    );

    await setOperationsSince(25);

    const gatedResult = await handleSet(
      { featureId, phase: 'plan-review' },
      tmpDir,
      eventStore,
      makeOptions(),
    );

    expect(gatedResult.success).toBe(false);
    expect(gatedResult.error).toBeDefined();
    expect(gatedResult.error!.code).toBe('CHECKPOINT_REQUIRED');
    const gatedErrorData = gatedResult.error as Record<string, unknown>;
    expect(gatedErrorData.gate).toBe('checkpoint_required');
    expect(gatedErrorData.operationsSince).toBe(25);
    expect(gatedErrorData.threshold).toBe(20);

    const checkpointResult = await handleCheckpoint(
      { featureId, summary: 'Pre-transition checkpoint' },
      tmpDir,
      eventStore,
    );

    expect(checkpointResult.success).toBe(true);
    expect(checkpointResult._meta).toBeDefined();
    expect(checkpointResult._meta!.checkpointAdvised).toBe(false);

    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const stateAfterCheckpoint = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(stateAfterCheckpoint._checkpoint.operationsSince).toBe(0);

    const retryResult = await handleSet(
      { featureId, phase: 'plan-review' },
      tmpDir,
      eventStore,
      makeOptions(),
    );

    expect(retryResult.success).toBe(true);
    const retryData = retryResult.data as Record<string, unknown>;
    expect(retryData.phase).toBe('plan-review');

    const enforcedEvents = await eventStore.query(featureId, { type: 'checkpoint.enforced' as never });
    expect(enforcedEvents.length).toBe(1);

    const checkpointEvents = await eventStore.query(featureId, { type: 'workflow.checkpoint' as never });
    expect(checkpointEvents.length).toBe(1);
    expect((checkpointEvents[0].data as Record<string, unknown>).phase).toBe('plan');
  });
});
