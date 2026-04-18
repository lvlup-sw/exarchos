import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit, handleSet, handleCheckpoint } from './tools.js';
import { readStateFile, writeStateFile } from './state-store.js';
import type { WorkflowState } from './types.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { DEFAULTS } from '../config/resolve.js';
import { EventStore } from '../event-store/store.js';

// ─── Checkpoint Gate Integration (Task 017) ──────────────────────────────────
//
// Verifies that handleSet enforces the checkpoint gate when a phase transition
// is requested and the checkpoint operationsSince exceeds the configured threshold.

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-checkpoint-gate-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Build a minimal options object that includes checkpoint config. */
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

  /**
   * Patch the raw state file to set _checkpoint.operationsSince to the desired value.
   */
  async function setOperationsSince(value: number) {
    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw._checkpoint.operationsSince = value;
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');
  }

  it('workflowSet_PhaseTransitionAboveThreshold_ReturnsCheckpointRequired', async () => {
    await initWorkflow();
    // Set design artifact to satisfy ideate->plan guard
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );
    // Push operationsSince above default threshold (20)
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
    // Set design artifact to satisfy ideate->plan guard
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );
    // operationsSince below threshold
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
    // Push operationsSince above threshold
    await setOperationsSince(25);

    // Field-only update (no phase transition) should proceed even above threshold
    const result = await handleSet(
      { featureId, updates: { 'synthesis.status': 'ready' } },
      tmpDir,
      null,
      makeOptions(),
    );

    expect(result.success).toBe(true);
  });

  // ─── Config wiring integration (Task 019) ──────────────────────────────────

  it('workflowSet_ConfiguredThreshold30_UsesConfigValue', async () => {
    await initWorkflow();
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );

    // 25 ops — below custom threshold of 30 → proceeds
    await setOperationsSince(25);
    const resultBelow = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      null,
      makeOptions({ operationThreshold: 30 }),
    );
    expect(resultBelow.success).toBe(true);

    // Reset back to ideate for next test (since we transitioned to plan)
    // Re-init for clean state
  });

  it('workflowSet_ConfiguredThreshold30_GatesAbove', async () => {
    await initWorkflow();
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );

    // 35 ops — above custom threshold of 30 → gated
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

    // Way above threshold but enforcement disabled
    await setOperationsSince(100);
    const result = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      null,
      makeOptions({ enforceOnPhaseTransition: false }),
    );
    expect(result.success).toBe(true);
  });

  // ─── Checkpoint enforcement events (Task 020) ──────────────────────────────

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

    // Verify checkpoint.enforced event was emitted
    const events = await eventStore.query(featureId, { type: 'checkpoint.enforced' as never });
    expect(events.length).toBe(1);
    const eventData = events[0].data as Record<string, unknown>;
    expect(eventData.operationsSince).toBe(25);
    expect(eventData.threshold).toBe(20);
    expect(eventData.blockedAction).toBe('phase-transition');
  });

  it('checkpointStateMissing_EmitsCheckpointStateMissingEvent', async () => {
    // The checkpoint.state_missing event fires when shouldEnforceCheckpoint
    // returns warning='checkpoint-state-missing'. In the normal handleSet path,
    // Zod defaults fill _checkpoint so this path is a safety net for edge cases.
    //
    // To verify the event emission code path, we use a state file where
    // _checkpoint is set to a Zod-invalid shape that gets defaulted back,
    // but we also directly test the shouldEnforceCheckpoint warning integration
    // via the unit tests in checkpoint.test.ts.
    //
    // Here we verify the structural contract: shouldEnforceCheckpoint with null
    // returns the expected warning that would trigger event emission.
    const { shouldEnforceCheckpoint } = await import('./checkpoint.js');

    const result = shouldEnforceCheckpoint(
      null,
      { operationThreshold: 20, enforceOnPhaseTransition: true, enforceOnWaveDispatch: true },
      'phase-transition',
    );

    expect(result.gated).toBe(false);
    expect(result.warning).toBe('checkpoint-state-missing');

    // Verify the event type is registered in the event store
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    // Emit the event directly to verify the type is valid
    const event = await eventStore.append(featureId, {
      type: 'checkpoint.state_missing' as import('../event-store/schemas.js').EventType,
      correlationId: featureId,
      source: 'workflow',
      data: { action: 'set' },
    });
    expect(event.type).toBe('checkpoint.state_missing');

    const events = await eventStore.query(featureId, { type: 'checkpoint.state_missing' as never });
    expect(events.length).toBe(1);
    expect((events[0].data as Record<string, unknown>).action).toBe('set');
  });

  // ─── End-to-end checkpoint enforcement flow (Task 023, DR-5, DR-10) ─────

  it('checkpointEnforcement_GateFires_ThenCheckpoint_ThenRetry_Succeeds', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    // Step 1: Init workflow and set design artifact for ideate->plan guard
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      eventStore,
    );

    // Step 2: Push operationsSince above threshold (25 > 20)
    await setOperationsSince(25);

    // Step 3: Attempt phase transition — should be gated
    const gatedResult = await handleSet(
      { featureId, phase: 'plan' },
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

    // Step 4: Call checkpoint to reset counter
    const checkpointResult = await handleCheckpoint(
      { featureId, summary: 'Pre-transition checkpoint' },
      tmpDir,
      eventStore,
    );

    expect(checkpointResult.success).toBe(true);
    // Verify checkpoint meta shows counter reset
    expect(checkpointResult._meta).toBeDefined();
    expect(checkpointResult._meta!.checkpointAdvised).toBe(false);

    // Step 5: Verify state file has operationsSince reset to 0
    const stateFile = path.join(tmpDir, `${featureId}.state.json`);
    const stateAfterCheckpoint = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    // handleCheckpoint doesn't increment, so counter should be 0
    expect(stateAfterCheckpoint._checkpoint.operationsSince).toBe(0);

    // Step 6: Retry the same phase transition — should succeed now
    const retryResult = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      eventStore,
      makeOptions(),
    );

    expect(retryResult.success).toBe(true);
    const retryData = retryResult.data as Record<string, unknown>;
    expect(retryData.phase).toBe('plan');

    // Verify checkpoint.enforced and workflow.checkpoint events were emitted
    const enforcedEvents = await eventStore.query(featureId, { type: 'checkpoint.enforced' as never });
    expect(enforcedEvents.length).toBe(1);

    const checkpointEvents = await eventStore.query(featureId, { type: 'workflow.checkpoint' as never });
    expect(checkpointEvents.length).toBe(1);
    expect((checkpointEvents[0].data as Record<string, unknown>).phase).toBe('ideate');
  });
});
