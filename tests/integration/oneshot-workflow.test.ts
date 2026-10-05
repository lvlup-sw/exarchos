// End-to-end integration tests for the `oneshot` workflow type.
//
// The tests run the chain from init through plan and implementing to finalize, with a real temp
// state directory and a real EventStore. They cover four combinations of `synthesisPolicy` and the
// `synthesize.requested` event, and a cancel in `implementing`.
//
// The unit tests in `tests/unit/verbs/tasks/finalize-oneshot.test.ts` stop at the handler boundary.
// These tests call the handlers in the runtime order: `handleInit`, `handleSet` (plan artifact),
// `handleSet` (phase transition), `handleRequestSynthesize` (optional), then
// `handleFinalizeOneshot` or `handleCancel`. Thus the choice state resolves through the real HSM.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleInit, handleSet } from '../../src/workflow/tools.js';
import { handleCancel } from '../../src/workflow/cancel.js';
import { EventStore } from '../../src/events/store.js';
import { handleFinalizeOneshot } from '../../src/verbs/tasks/finalize-oneshot.js';
import { handleRequestSynthesize } from '../../src/verbs/team/request-synthesize.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

let tmpDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-integration-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

/**
 * Starts a oneshot workflow and moves it from `plan` to `implementing`. `handleInit` takes
 * `synthesisPolicy` and seeds `state.oneshot.synthesisPolicy`. The plan artifact satisfies the
 * `oneshotPlanSet` guard on the transition.
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

/** Reads the phase from the state file on disk, not from a projection or a view. */
async function readPhase(featureId: string): Promise<string> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  const raw = await fs.readFile(stateFile, 'utf-8');
  const parsed = JSON.parse(raw) as { phase?: string };
  return parsed.phase ?? '';
}

describe('oneshot workflow integration (T16)', () => {
  /**
   * With no policy at init, the schema default is `on-request`. No `synthesize.requested` event
   * exists, so the `synthesisOptedOut` guard passes and the workflow completes.
   */
  it('oneshotIntegration_defaultPolicy_directCommitPath', async () => {
    const featureId = 'oneshot-default';

    await setupOneshotInImplementing(featureId);

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

  /** A `synthesize.requested` event selects the synthesize branch. */
  it('oneshotIntegration_onRequestPolicyWithEvent_synthesizePath', async () => {
    const featureId = 'oneshot-on-request-event';

    await setupOneshotInImplementing(featureId, 'on-request');

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

  /** The `always` policy selects the synthesize branch with no event. */
  it('oneshotIntegration_policyAlways_synthesizePathWithoutEvent', async () => {
    const featureId = 'oneshot-always';

    await setupOneshotInImplementing(featureId, 'always');

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

  /**
   * `handleRequestSynthesize` does not read the policy, so it appends the event. For the `never`
   * policy, each guard decides before it reads the events. Thus the workflow still completes
   * directly.
   */
  it('oneshotIntegration_policyNeverWithEvent_stillDirectCommit', async () => {
    const featureId = 'oneshot-never-with-event';

    await setupOneshotInImplementing(featureId, 'never');

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

  /** The cancel uses the universal `cancelled` transition, which each non-final phase has. */
  it('oneshotIntegration_cancelMidImplementing_transitionsToCancelled', async () => {
    const featureId = 'oneshot-cancel-mid';

    await setupOneshotInImplementing(featureId);

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
