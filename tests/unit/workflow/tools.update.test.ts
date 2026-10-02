// Tests for the `exarchos_workflow.update` action. `update` calls `handleSet` with
// field updates only, so a state change gets input validation, the output envelope
// and a `state.patched` event. Phase changes go through `transition`.

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
  /**
   * A `phase` key in `updates` bypasses the HSM guards, so `update` rejects it. The `suggestedFix` points at
   * `exarchos_workflow.transition`, so an agent can correct the call without parsing the message.
   */
  it('WorkflowUpdate_RejectsUpdatesContainingPhaseField', async () => {
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

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

    const suggestedFix = result.error?.suggestedFix as
      | { tool?: string; params?: { action?: string } }
      | undefined;
    expect(suggestedFix?.tool).toBe('exarchos_workflow');
    expect(suggestedFix?.params?.action).toBe('transition');
  });

  /** The `state.patched` event proves that `update` uses the event-first path. */
  it('WorkflowUpdate_PersistsArtifactsViaCanonicalStatePatchedEvent', async () => {
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    const result = await handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { artifacts: { design: 'p.md' } },
      },
      ctx,
    );

    expect(result.success).toBe(true);

    const get = await handleWorkflow(
      { action: 'get', featureId },
      ctx,
    );
    expect(get.success).toBe(true);
    const getData = get.data as Record<string, unknown>;
    const artifacts = getData.artifacts as Record<string, unknown> | undefined;
    expect(artifacts?.design).toBe('p.md');

    const events = await eventStore.query(featureId);
    const patched = events.filter((e) => e.type === 'state.patched');
    expect(patched.length).toBeGreaterThanOrEqual(1);
    const patch = (patched[patched.length - 1].data as Record<string, unknown>).patch as
      | Record<string, unknown>
      | undefined;
    const patchedArtifacts = patch?.artifacts as Record<string, unknown> | undefined;
    expect(patchedArtifacts?.design).toBe('p.md');
  });

  /** `_perf.bytes` and `_perf.tokens` can be absent, so the test checks their type only when present. */
  it('WorkflowUpdate_ReturnsCanonicalEnvelopePerInv5b', async () => {
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    const result = await handleWorkflow(
      {
        action: 'update',
        featureId,
        updates: { planReview: { approved: true } },
      },
      ctx,
    );

    expect(result.success).toBe(true);

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
    if (perf?.bytes !== undefined) expect(typeof perf.bytes).toBe('number');
    if (perf?.tokens !== undefined) expect(typeof perf.tokens).toBe('number');
  });

  /**
   * The `data` block of `StateStoreError` must reach the caller through the `update` envelope. The `_version`
   * key passes the composite phase check and fails in the `applyDotPath` loop of `handleSet`.
   */
  it('WorkflowUpdate_ReservedField_EnvelopeCarriesTypedData', async () => {
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);

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
    expect(data?.alternateWritePath).toMatch(/event/i);
  });
});
