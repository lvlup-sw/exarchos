import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit, handleSet } from './tools.js';
import { readStateFile, writeStateFile } from './state-store.js';
import type { WorkflowState } from './types.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { DEFAULTS } from '../config/resolve.js';

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
});
