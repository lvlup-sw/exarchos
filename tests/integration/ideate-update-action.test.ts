// The unified `plan` phase, in the call sequence that `content/design/skills/plan/SKILL.md` gives
// an agent.
//
//   1. `init` with `workflowType: 'feature'` starts the workflow in `plan`.
//   2. The agent writes the spec file to disk.
//   3. `update` records the path as `artifacts.plan`.
//   4. `transition` moves the workflow to `plan-review`.
//   5. `get` shows the new phase and the artifact.
//
// `tests/unit/workflow/tools.update.integration.test.ts` covers the same actions as a contract.
// This test pins the call sequence, so it fails when the documented flow and the runtime drift
// apart.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleWorkflow } from '../../src/workflow/composite.js';
import { handleInit } from '../../src/workflow/tools.js';
import { EventStore } from '../../src/events/store.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

describe('IdeateFlow_E2E (Wave 5 / Task 5.5, #1341)', () => {
  let tmpDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;
  const featureId = 'wave5-ideate-update-smoke';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave5-ideate-e2e-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /**
   * `planArtifactExists` guards the transition from `plan` to `plan-review`. If the update does not
   * reach the projection that the guard reads, the transition returns `GUARD_FAILED`. The spec file
   * is in the temp directory of the test, and the test records its path. The last step proves that
   * the artifact survives the phase write.
   */
  it('IdeateFlow_UpdatesArtifactsPlanViaUpdateAction', async () => {
    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(initResult.success).toBe(true);
    const initData = initResult.data as Record<string, unknown>;
    expect(initData.phase).toBe('plan');

    const specPath = path.join(tmpDir, 'docs', 'specs', `${featureId}.md`);
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, '# Spec\n\nSmoke test spec content.\n');

    const updateResult = await handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { artifacts: { plan: specPath } },
      },
      ctx,
    );
    expect(
      updateResult.success,
      `expected update to succeed; got error: ${JSON.stringify(
        (updateResult as { error?: unknown }).error,
      )}`,
    ).toBe(true);

    const transitionResult = await handleWorkflow(
      { action: 'transition', featureId, target: 'plan-review' },
      ctx,
    );
    expect(
      transitionResult.success,
      `expected transition to plan-review to succeed; got error: ${JSON.stringify(
        (transitionResult as { error?: unknown }).error,
      )}`,
    ).toBe(true);

    const getResult = await handleWorkflow({ action: 'get', featureId }, ctx);
    expect(getResult.success).toBe(true);
    const data = getResult.data as Record<string, unknown>;
    expect(data.phase).toBe('plan-review');
    const artifacts = data.artifacts as Record<string, unknown> | undefined;
    expect(artifacts?.plan).toBe(specPath);
  });
});
