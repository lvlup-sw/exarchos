// ─── Task 0.1 (Wave 0): exarchos_workflow.update canonical surface ────────
//
// `update` is the agent-facing surface that supersedes the v2.10
// `set({updates})` rerouting path. The replacement guidance in the v2.11
// runbook directs callers to emit `state.patched` directly via
// `event.append`, but that bypasses input validation, output enveloping,
// idempotency, and `next_actions`. This restores a canonical, validated,
// output-enveloped action that delegates to the existing internal
// `workflow.update()` helper (`handleSet` with `updates` only) so the
// state-mutation surface is once again model-callable.
//
// Wave 0 covers six tasks:
//   0.1 — register the action handler
//   0.2 — reject `updates.phase` with INVALID_INPUT + suggestedFix
//   0.3 — output envelope per INV-5b (next_actions + _meta + _perf)
//   0.4 — register WorkflowUpdateOutputSchema (envelope-version discipline)
//   0.5 — race fixture (separate file)
//   0.6 — end-to-end smoke with transition (separate file)
//
// Iron-law TDD: each task lands as a separate RED → GREEN commit pair.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleWorkflow } from './composite.js';
import { handleInit } from './tools.js';
import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

let tmpDir: string;
let eventStore: EventStore;
let ctx: DispatchContext;
const featureId = 'wf-update-canonical';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-update-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('exarchos_workflow.update — canonical state-mutation action (Wave 0)', () => {
  it('WorkflowUpdate_PersistsArtifactsViaCanonicalStatePatchedEvent', async () => {
    // Setup: initialize a feature workflow.
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    // Call exarchos_workflow.update({featureId, updates: {artifacts: {design: 'p.md'}}}).
    const result = await handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { artifacts: { design: 'p.md' } },
      },
      ctx,
    );

    // Surface assertion: action exists in the registry enum and dispatches
    // through the composite handler.
    expect(result.success).toBe(true);

    // State assertion: subsequent get returns the persisted artifact.
    const get = await handleWorkflow(
      { action: 'get', featureId },
      ctx,
    );
    expect(get.success).toBe(true);
    const getData = get.data as Record<string, unknown>;
    const artifacts = getData.artifacts as Record<string, unknown> | undefined;
    expect(artifacts?.design).toBe('p.md');

    // Event-store assertion: a state.patched event was appended to the
    // stream with data.patch.artifacts.design === 'p.md'. This is the
    // load-bearing invariant — the canonical action must flow through the
    // event-first path (not bypass it like a direct event.append would).
    const events = await eventStore.query(featureId);
    const patched = events.filter((e) => e.type === 'state.patched');
    expect(patched.length).toBeGreaterThanOrEqual(1);
    const patch = (patched[patched.length - 1].data as Record<string, unknown>).patch as
      | Record<string, unknown>
      | undefined;
    const patchedArtifacts = patch?.artifacts as Record<string, unknown> | undefined;
    expect(patchedArtifacts?.design).toBe('p.md');
  });
});
