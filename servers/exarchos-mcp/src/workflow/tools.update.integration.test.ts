// ─── Task 0.6 (Wave 0): update + transition close the HSM guard loop ─────
//
// End-to-end smoke: an init→update→transition sequence where the
// transition is gated by an artifact guard that the update populates.
// Specifically: the feature workflow's `ideate → plan` transition is
// gated by `designArtifactExists` (state.artifacts.design != null),
// so a successful round-trip is:
//
//   init({featureId, workflowType: 'feature'})
//   update({featureId, updates: {artifacts: {design: 'p.md'}}})
//   transition({featureId, target: 'plan'})  // guard now passes
//   get({featureId})                          // observes phase: 'plan'
//
// This proves Wave 0's restoration of `update` actually closes the
// existing HSM guard loop — the state-file projection used by the
// guard contract reflects the update before the next transition reads
// it. If `update`'s state-write didn't land or the guard read a stale
// snapshot, the transition would surface GUARD_FAILED with
// designArtifactExists in the failure envelope.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleWorkflow } from './composite.js';
import { handleInit } from './tools.js';
import { EventStore } from '../events/store.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

let tmpDir: string;
let eventStore: EventStore;
let ctx: DispatchContext;
const featureId = 'wf-update-transition-integration';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-update-integration-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

describe('exarchos_workflow.update + transition — HSM guard loop (Wave 0, Task 0.6)', () => {
  it('WorkflowUpdate_ThenTransition_SatisfiesPlanArtifactExistsGuard', async () => {
    // Step 1: init feature workflow at phase: 'plan' (DR-4 #1581: plan is initial).
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);
    const initData = init.data as Record<string, unknown>;
    expect(initData.phase).toBe('plan');

    // Step 2: populate the plan artifact via the canonical update
    // surface. Without this, transition('plan-review') below would return
    // GUARD_FAILED with planArtifactExists.
    const updateResult = await handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { artifacts: { plan: 'p.md' } },
      },
      ctx,
    );
    expect(updateResult.success).toBe(true);

    // Step 3: transition plan → plan-review. The HSM guard reads the
    // state-file projection (loaded by handleSet/applyTransition for
    // its CAS attempt); the update from step 2 must already be
    // visible there.
    const transitionResult = await handleWorkflow(
      {
        action: 'transition',
        featureId,
        target: 'plan-review',
      },
      ctx,
    );
    expect(transitionResult.success).toBe(true);

    // Step 4: confirm both the phase change and the artifact persist.
    // A successful transition that loses the artifact would mean the
    // CAS write overwrote it; an unsuccessful transition would mean
    // the guard read a stale snapshot.
    const get = await handleWorkflow({ action: 'get', featureId }, ctx);
    expect(get.success).toBe(true);
    const data = get.data as Record<string, unknown>;
    expect(data.phase).toBe('plan-review');
    const artifacts = data.artifacts as Record<string, unknown> | undefined;
    expect(artifacts?.plan).toBe('p.md');
  });
});
