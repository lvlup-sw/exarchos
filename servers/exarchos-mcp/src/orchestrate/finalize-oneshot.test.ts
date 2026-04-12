// ─── Finalize Oneshot Handler Tests (T12) ──────────────────────────────────
//
// Exercises handleFinalizeOneshot — the orchestrate action that resolves
// the oneshot choice state at the end of `implementing`. Determines the
// next phase from the synthesisOptedIn / synthesisOptedOut guards and
// transitions via handleSet, delegating guard evaluation to the HSM.
//
// Tests use real tmpdir state + EventStore to drive the full HSM pipeline,
// ensuring the handler interacts with state-store/event-store the same way
// the production composite handler will.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleInit, handleSet } from '../workflow/tools.js';
import { EventStore } from '../event-store/store.js';
import { handleFinalizeOneshot } from './finalize-oneshot.js';

// ─── Fixture helpers ────────────────────────────────────────────────────────

let tmpDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-oneshot-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Initialize a oneshot workflow, set the plan, and advance to `implementing`.
 * Optionally set the synthesisPolicy via `oneshot.synthesisPolicy` updates.
 */
async function initOneshotInImplementing(
  featureId: string,
  synthesisPolicy?: 'always' | 'never' | 'on-request',
): Promise<void> {
  await handleInit({ featureId, workflowType: 'oneshot' }, tmpDir, eventStore);

  // Set synthesisPolicy via top-level oneshot field if specified.
  if (synthesisPolicy !== undefined) {
    await handleSet(
      {
        featureId,
        updates: { 'oneshot.synthesisPolicy': synthesisPolicy },
      },
      tmpDir,
      eventStore,
    );
  }

  // Set the plan artifact to satisfy oneshotPlanSet guard
  await handleSet(
    {
      featureId,
      updates: { 'artifacts.plan': 'one-page plan' },
    },
    tmpDir,
    eventStore,
  );

  // Transition plan -> implementing
  const result = await handleSet(
    { featureId, phase: 'implementing' },
    tmpDir,
    eventStore,
  );
  if (!result.success) {
    throw new Error(
      `Failed to advance to implementing: ${result.error?.message ?? 'unknown'}`,
    );
  }
}

async function appendSynthesizeRequested(featureId: string): Promise<void> {
  await eventStore.append(featureId, {
    type: 'synthesize.requested',
    data: {
      featureId,
      timestamp: new Date().toISOString(),
    },
  });
}

async function readPhase(featureId: string): Promise<string> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  const raw = await fs.readFile(stateFile, 'utf-8');
  const parsed = JSON.parse(raw) as { phase?: string };
  return parsed.phase ?? '';
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleFinalizeOneshot', () => {
  it('handleFinalizeOneshot_policyAlways_transitionsToSynthesize', async () => {
    const featureId = 'oneshot-always';
    await initOneshotInImplementing(featureId, 'always');

    const result = await handleFinalizeOneshot(
      { featureId, stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(true);
    const data = result.data as { previousPhase: string; newPhase: string };
    expect(data.previousPhase).toBe('implementing');
    expect(data.newPhase).toBe('synthesize');

    expect(await readPhase(featureId)).toBe('synthesize');
  });

  it('handleFinalizeOneshot_policyNever_transitionsToCompleted', async () => {
    const featureId = 'oneshot-never';
    await initOneshotInImplementing(featureId, 'never');

    const result = await handleFinalizeOneshot(
      { featureId, stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(true);
    const data = result.data as { previousPhase: string; newPhase: string };
    expect(data.previousPhase).toBe('implementing');
    expect(data.newPhase).toBe('completed');

    expect(await readPhase(featureId)).toBe('completed');
  });

  it('handleFinalizeOneshot_onRequestWithEvent_transitionsToSynthesize', async () => {
    const featureId = 'oneshot-on-request-event';
    await initOneshotInImplementing(featureId, 'on-request');
    await appendSynthesizeRequested(featureId);

    const result = await handleFinalizeOneshot(
      { featureId, stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(true);
    const data = result.data as { previousPhase: string; newPhase: string };
    expect(data.newPhase).toBe('synthesize');
    expect(await readPhase(featureId)).toBe('synthesize');
  });

  it('handleFinalizeOneshot_onRequestNoEvent_transitionsToCompleted', async () => {
    const featureId = 'oneshot-on-request-no-event';
    await initOneshotInImplementing(featureId, 'on-request');

    const result = await handleFinalizeOneshot(
      { featureId, stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(true);
    const data = result.data as { previousPhase: string; newPhase: string };
    expect(data.newPhase).toBe('completed');
    expect(await readPhase(featureId)).toBe('completed');
  });

  it('handleFinalizeOneshot_defaultsToOnRequestWhenPolicyMissing', async () => {
    // No explicit synthesisPolicy set — should default to on-request behavior.
    // Without a synthesize.requested event, the direct-commit path is taken.
    const featureId = 'oneshot-default-policy';
    await initOneshotInImplementing(featureId);

    const result = await handleFinalizeOneshot(
      { featureId, stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(true);
    const data = result.data as { newPhase: string };
    expect(data.newPhase).toBe('completed');
  });

  it('handleFinalizeOneshot_rejectsNonOneshotWorkflow', async () => {
    const featureId = 'feat-non-oneshot';
    // Initialize as feature workflow, not oneshot
    await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );

    const result = await handleFinalizeOneshot(
      { featureId, stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_WORKFLOW_TYPE');
    expect(result.error?.message).toMatch(/oneshot/);
  });

  it('handleFinalizeOneshot_rejectsFromWrongPhase', async () => {
    const featureId = 'oneshot-wrong-phase';
    // Init oneshot but stay in `plan` (do not advance to implementing)
    await handleInit(
      { featureId, workflowType: 'oneshot' },
      tmpDir,
      eventStore,
    );

    const result = await handleFinalizeOneshot(
      { featureId, stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PHASE');
    expect(result.error?.message).toMatch(/implementing/);
  });

  it('handleFinalizeOneshot_rejectsMissingState', async () => {
    const result = await handleFinalizeOneshot(
      { featureId: 'does-not-exist', stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_NOT_FOUND');
  });

  it('handleFinalizeOneshot_rejectsMissingFeatureId', async () => {
    const result = await handleFinalizeOneshot(
      { featureId: '', stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('handleFinalizeOneshot_policyAlwaysOverridesEvent', async () => {
    // Verifies that synthesisPolicy=always wins regardless of events.
    const featureId = 'oneshot-always-event';
    await initOneshotInImplementing(featureId, 'always');
    await appendSynthesizeRequested(featureId);

    const result = await handleFinalizeOneshot(
      { featureId, stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(true);
    expect((result.data as { newPhase: string }).newPhase).toBe('synthesize');
  });

  it('handleFinalizeOneshot_policyNeverOverridesEvent', async () => {
    // Verifies that synthesisPolicy=never wins even when synthesize.requested
    // was emitted (the event is recorded for audit but the policy short-
    // circuits the choice state).
    const featureId = 'oneshot-never-event';
    await initOneshotInImplementing(featureId, 'never');
    await appendSynthesizeRequested(featureId);

    const result = await handleFinalizeOneshot(
      { featureId, stateDir: tmpDir, eventStore },
    );

    expect(result.success).toBe(true);
    expect((result.data as { newPhase: string }).newPhase).toBe('completed');
  });
});
