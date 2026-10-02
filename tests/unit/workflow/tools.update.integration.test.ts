// End-to-end check that `update` and `transition` close the HSM guard loop.
// `update` sets the plan artifact, and then the transition to `plan-review` passes
// the `planArtifactExists` guard. A guard that reads a stale state gives
// GUARD_FAILED. A CAS write that drops the artifact fails the final `get`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleWorkflow } from '../../../src/workflow/composite.js';
import { handleInit } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);
    const initData = init.data as Record<string, unknown>;
    expect(initData.phase).toBe('plan');

    const updateResult = await handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { artifacts: { plan: 'p.md' } },
      },
      ctx,
    );
    expect(updateResult.success).toBe(true);

    const transitionResult = await handleWorkflow(
      {
        action: 'transition',
        featureId,
        target: 'plan-review',
      },
      ctx,
    );
    expect(transitionResult.success).toBe(true);

    const get = await handleWorkflow({ action: 'get', featureId }, ctx);
    expect(get.success).toBe(true);
    const data = get.data as Record<string, unknown>;
    expect(data.phase).toBe('plan-review');
    const artifacts = data.artifacts as Record<string, unknown> | undefined;
    expect(artifacts?.plan).toBe('p.md');
  });
});
