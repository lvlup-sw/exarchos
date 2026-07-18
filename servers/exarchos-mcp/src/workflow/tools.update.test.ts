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
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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
  await rmrfAsync(tmpDir);
});

describe('exarchos_workflow.update — canonical state-mutation action (Wave 0)', () => {
  it('WorkflowUpdate_RejectsUpdatesContainingPhaseField', async () => {
    // Setup: initialize a feature workflow.
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    // Call update with `phase` smuggled inside `updates`. The action's
    // contract is non-phase mutation only — phase changes go through
    // `transition` and its HSM-guarded code path. Allowing `phase`
    // through here would silently bypass guard evaluation, valid-target
    // enumeration, and the workflow.transition event emission.
    const result = await handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { phase: 'plan' },
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');

    // The structured `suggestedFix` is the load-bearing piece of this
    // contract — agents auto-correct off it without parsing the message
    // string (INV-5a). Must point at the canonical phase-mutation
    // surface (`exarchos_workflow.transition`) so the fix is one tool
    // call away.
    const suggestedFix = result.error?.suggestedFix as
      | { tool?: string; params?: { action?: string } }
      | undefined;
    expect(suggestedFix?.tool).toBe('exarchos_workflow');
    expect(suggestedFix?.params?.action).toBe('transition');
  });

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
    const patch = (patched[patched.length - 1]!.data as Record<string, unknown>).patch as
      | Record<string, unknown>
      | undefined;
    const patchedArtifacts = patch?.artifacts as Record<string, unknown> | undefined;
    expect(patchedArtifacts?.design).toBe('p.md');
  });

  it('WorkflowUpdate_ReturnsCanonicalEnvelopePerInv5b', async () => {
    // Setup: initialize a feature workflow.
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    // Call update with a non-phase field.
    const result = await handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { planReview: { approved: true } },
      },
      ctx,
    );

    expect(result.success).toBe(true);

    // Envelope contract per INV-5b:
    //   - _meta.checkpointAdvised must be defined (boolean) so callers
    //     can signal whether a checkpoint is recommended after the
    //     mutation.
    //   - next_actions must be an array (HSM-derived for the current
    //     phase). May be empty for actions whose response data omits
    //     workflowType + phase, but it must be present.
    //   - _perf must carry numeric ms/bytes/tokens (envelope wraps it
    //     into the canonical { ms: number, ... } shape).
    const env = result as Record<string, unknown>;

    const meta = env._meta as Record<string, unknown> | undefined;
    expect(meta).toBeTypeOf('object');
    expect(meta).not.toBeNull();
    expect(meta).toHaveProperty('checkpointAdvised');

    expect(Array.isArray(env.next_actions)).toBe(true);

    const perf = env._perf as Record<string, unknown> | undefined;
    expect(perf).toBeTypeOf('object');
    expect(perf).not.toBeNull();
    expect(typeof perf?.ms).toBe('number');
    // bytes + tokens may be added by the envelope wrap; if either is
    // present it must be numeric. Asserting presence of `ms` covers the
    // load-bearing perf field (`bytes` and `tokens` are populated by
    // wrap() when input/output sizes are knowable; for an in-process
    // test they may be 0 or absent depending on which wrap path was
    // taken).
    if (perf?.bytes !== undefined) expect(typeof perf.bytes).toBe('number');
    if (perf?.tokens !== undefined) expect(typeof perf.tokens).toBe('number');
  });

  // Sentry follow-up (#1360 / PR 2): the structured `data` block on
  // `StateStoreError` must reach the caller through the `update` action's
  // envelope. The earlier handleSet pre-flight short-circuited before
  // applyDotPath, dropping the data block on the floor. The fix lets
  // applyDotPath throw and catches the typed error so `data` survives.
  it('WorkflowUpdate_ReservedField_EnvelopeCarriesTypedData', async () => {
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    // Underscore-prefixed reserved field — bypasses the composite's
    // phase-in-updates guard (which only rejects `phase`) and lands in
    // handleSet's applyDotPath loop, exercising the catch path that
    // propagates `data`.
    const result = await handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { _version: 99 },
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RESERVED_FIELD');

    const data = (result.error as Record<string, unknown> | undefined)?.data as
      | { rejectedPath?: string; rule?: string; alternateWritePath?: string }
      | undefined;
    expect(data).toBeDefined();
    expect(data?.rejectedPath).toBe('_version');
    expect(data?.rule).toBeTruthy();
    // Underscore guidance points at event.append rather than direct write.
    expect(data?.alternateWritePath).toMatch(/event/i);
  });
});
