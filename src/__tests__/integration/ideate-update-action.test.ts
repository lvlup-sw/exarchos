// ─── Wave 5 / Task 5.5 (#1341): ideate flow E2E using canonical update ───
//
// This test mirrors the agent-facing sequence documented in
// `commands/ideate.md` and `skills-src/ideate/SKILL.md` after the
// Wave 5 markdown migration:
//
//   1. exarchos_workflow.init({featureId, workflowType: 'feature'})
//   2. Write design file to disk (docs/designs/<feature>.md)
//   3. exarchos_workflow.update({featureId, updates: {artifacts: {design: '<path>'}}})
//   4. exarchos_workflow.transition({featureId, target: 'plan'})
//   5. Assert phase == 'plan' AND artifacts.design persists
//
// Why a fresh test even though `tools.update.integration.test.ts` covers
// the same actions: this test is anchored in the AGENT'S documented flow,
// not the action contract in isolation. The skill markdown tells an agent
// to call `action: "update"` after saving a design — this test proves the
// documented call sequence still works end-to-end after the migration.
// Future-proofing: if the documented flow ever drifts from what the
// runtime accepts (e.g., a renamed action, a new required prerequisite),
// this gate catches it where contract tests would not.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleWorkflow } from '../../workflow/composite.js';
import { handleInit } from '../../workflow/tools.js';
import { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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

  it('IdeateFlow_UpdatesArtifactsPlanViaUpdateAction', async () => {
    // DR-4 (#1581): GATHER collapsed into PLAN. The unified flow's guarded
    // transition is now plan → plan-review (planArtifactExists); the deeper
    // /ideate command + brainstorming rewrite is task 016. This smoke still
    // locks that an `update` lands in the projection the guard reads.
    // ─── 1. init: feature workflow lands in phase 'plan' ──────────────
    const initResult = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(initResult.success).toBe(true);
    const initData = initResult.data as Record<string, unknown>;
    expect(initData.phase).toBe('plan');

    // ─── 2. write the unified spec artifact to disk ───────────────────
    //
    // The documented agent flow saves the spec markdown BEFORE calling
    // exarchos_workflow.update. Use the workflow's tmpDir so the file
    // lives within the test fixture's sandbox; the path is what we record.
    const specPath = path.join(tmpDir, 'docs', 'specs', `${featureId}.md`);
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, '# Spec\n\nSmoke test spec content.\n');

    // ─── 3. update: record the plan artifact via canonical action ─────
    //
    // The skill instructions tell agents to call:
    //   exarchos_workflow({
    //     action: "update",
    //     featureId: "<id>",
    //     updates: { "artifacts": { "plan": "<path>" } }
    //   })
    // — this assertion locks that exact agent-facing shape.
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

    // ─── 4. transition: plan → plan-review, gated by planArtifactExists ──
    //
    // If the update from step 3 didn't land in the projection the guard
    // reads, this transition would return GUARD_FAILED with
    // planArtifactExists named in the failure envelope.
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

    // ─── 5. confirm phase + artifact both persist post-transition ─────
    //
    // A successful transition that loses the artifact would mean the
    // CAS write overwrote it during the phase swap; an unsuccessful
    // transition would mean the guard saw a stale snapshot.
    const getResult = await handleWorkflow({ action: 'get', featureId }, ctx);
    expect(getResult.success).toBe(true);
    const data = getResult.data as Record<string, unknown>;
    expect(data.phase).toBe('plan-review');
    const artifacts = data.artifacts as Record<string, unknown> | undefined;
    expect(artifacts?.plan).toBe(specPath);
  });
});
