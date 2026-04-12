// ─── Oneshot Workflow — End-to-End Integration Tests (T16) ─────────────────
//
// Exercises the full init → plan → implementing → finalize chain for the
// `oneshot` workflow type against real tmpdir state + a real EventStore,
// covering the four synthesisPolicy × event combinations and the mid-
// implementing cancel path.
//
// Unlike the unit tests in `orchestrate/finalize-oneshot.test.ts`, these
// tests wire the orchestrate handlers together exactly as the composite
// dispatcher does at runtime: `handleInit` → `handleSet` (plan artifact) →
// `handleSet` (phase transition) → `handleRequestSynthesize` (optional) →
// `handleFinalizeOneshot` / `handleCancel`. This verifies the choice-state
// mechanism resolves correctly through the real HSM pipeline, not just at
// the handler boundary.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleInit, handleSet } from '../../workflow/tools.js';
import { handleCancel } from '../../workflow/cancel.js';
import { EventStore } from '../../event-store/store.js';
import { handleFinalizeOneshot } from '../../orchestrate/finalize-oneshot.js';
import { handleRequestSynthesize } from '../../orchestrate/request-synthesize.js';

// ─── Shared fixtures ────────────────────────────────────────────────────────

let tmpDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-integration-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Initialize a oneshot workflow and drive it through plan → implementing.
 *
 * `synthesisPolicy` is passed directly to `handleInit` — the init schema
 * accepts it for oneshot workflows and seeds `state.oneshot.synthesisPolicy`
 * before the workflow exits `plan`. The `handleSet` mid-workflow override
 * path is still supported for runtime policy changes; these tests use the
 * init-time path because that is the primary documented API.
 */
async function setupOneshotInImplementing(
  featureId: string,
  synthesisPolicy?: 'always' | 'never' | 'on-request',
): Promise<void> {
  const initResult = await handleInit(
    {
      featureId,
      workflowType: 'oneshot',
      ...(synthesisPolicy !== undefined ? { synthesisPolicy } : {}),
    },
    tmpDir,
    eventStore,
  );
  if (!initResult.success) {
    throw new Error(
      `init failed: ${initResult.error?.message ?? 'unknown error'}`,
    );
  }

  // Satisfy the `oneshotPlanSet` guard on plan → implementing
  const planResult = await handleSet(
    {
      featureId,
      updates: { 'artifacts.plan': 'one-page plan content' },
    },
    tmpDir,
    eventStore,
  );
  if (!planResult.success) {
    throw new Error(
      `set plan artifact failed: ${planResult.error?.message ?? 'unknown error'}`,
    );
  }

  const transitionResult = await handleSet(
    { featureId, phase: 'implementing' },
    tmpDir,
    eventStore,
  );
  if (!transitionResult.success) {
    throw new Error(
      `advance to implementing failed: ${transitionResult.error?.message ?? 'unknown error'}`,
    );
  }
}

/**
 * Read the raw phase directly from the state file on disk, bypassing any
 * projection or view-layer caching. Tests assert against this to verify
 * the HSM persisted the expected transition.
 */
async function readPhase(featureId: string): Promise<string> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  const raw = await fs.readFile(stateFile, 'utf-8');
  const parsed = JSON.parse(raw) as { phase?: string };
  return parsed.phase ?? '';
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('oneshot workflow integration (T16)', () => {
  it('oneshotIntegration_defaultPolicy_directCommitPath', async () => {
    const featureId = 'oneshot-default';

    // Init with no policy override — schema default is `on-request`.
    await setupOneshotInImplementing(featureId);

    // No synthesize.requested event emitted; default policy = on-request
    // with no opt-in event → synthesisOptedOut guard passes → completed.
    const result = await handleFinalizeOneshot({
      featureId,
      stateDir: tmpDir,
      eventStore,
    });

    expect(result.success).toBe(true);
    const data = result.data as { previousPhase: string; newPhase: string };
    expect(data.previousPhase).toBe('implementing');
    expect(data.newPhase).toBe('completed');
    expect(await readPhase(featureId)).toBe('completed');
  });

  it('oneshotIntegration_onRequestPolicyWithEvent_synthesizePath', async () => {
    const featureId = 'oneshot-on-request-event';

    await setupOneshotInImplementing(featureId, 'on-request');

    // Runtime opt-in: appending synthesize.requested flips the guard toward
    // the synthesize branch.
    const requestResult = await handleRequestSynthesize({
      featureId,
      reason: 'needs review before commit',
      stateFile: path.join(tmpDir, `${featureId}.state.json`),
      eventStore,
    });
    expect(requestResult.success).toBe(true);

    const result = await handleFinalizeOneshot({
      featureId,
      stateDir: tmpDir,
      eventStore,
    });

    expect(result.success).toBe(true);
    const data = result.data as { previousPhase: string; newPhase: string };
    expect(data.previousPhase).toBe('implementing');
    expect(data.newPhase).toBe('synthesize');
    expect(await readPhase(featureId)).toBe('synthesize');
  });

  it('oneshotIntegration_policyAlways_synthesizePathWithoutEvent', async () => {
    const featureId = 'oneshot-always';

    await setupOneshotInImplementing(featureId, 'always');

    // Policy `always` should route to synthesize with no event needed.
    const result = await handleFinalizeOneshot({
      featureId,
      stateDir: tmpDir,
      eventStore,
    });

    expect(result.success).toBe(true);
    const data = result.data as { newPhase: string };
    expect(data.newPhase).toBe('synthesize');
    expect(await readPhase(featureId)).toBe('synthesize');
  });

  it('oneshotIntegration_policyNeverWithEvent_stillDirectCommit', async () => {
    const featureId = 'oneshot-never-with-event';

    await setupOneshotInImplementing(featureId, 'never');

    // Attempt runtime opt-in. The event will be appended to the stream
    // (request-synthesize does not inspect policy) — but the downstream
    // guard short-circuits on `never`, so the direct-commit path wins.
    const requestResult = await handleRequestSynthesize({
      featureId,
      reason: 'policy should override this',
      stateFile: path.join(tmpDir, `${featureId}.state.json`),
      eventStore,
    });
    expect(requestResult.success).toBe(true);

    const result = await handleFinalizeOneshot({
      featureId,
      stateDir: tmpDir,
      eventStore,
    });

    expect(result.success).toBe(true);
    const data = result.data as { newPhase: string };
    expect(data.newPhase).toBe('completed');
    expect(await readPhase(featureId)).toBe('completed');
  });

  it('oneshotIntegration_cancelMidImplementing_transitionsToCancelled', async () => {
    const featureId = 'oneshot-cancel-mid';

    await setupOneshotInImplementing(featureId);

    // Mid-flight cancel via the universal cancelled transition that the
    // HSM base installs on every workflow type.
    const cancelResult = await handleCancel(
      { featureId, reason: 'abandoning mid-implement for test' },
      tmpDir,
      eventStore,
    );

    expect(cancelResult.success).toBe(true);
    const data = cancelResult.data as { phase: string; previousPhase: string };
    expect(data.phase).toBe('cancelled');
    expect(data.previousPhase).toBe('implementing');
    expect(await readPhase(featureId)).toBe('cancelled');
  });
});
