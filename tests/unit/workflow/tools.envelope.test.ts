// Tests that the events from the workflow handlers carry the canonical envelope.
// `assertCanonicalEnvelope` checks a non-empty `correlationId` and `source`, and parses `data`
// against the schema of the event type when one exists. The tests cover `workflow.started`,
// `state.patched` and the checkpoint events. The checkpoint-gate and CAS-exhaustion paths have no test here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import {
  handleInit,
  handleSet,
  handleCheckpoint,
} from '../../../src/workflow/tools.js';
import { assertCanonicalEnvelope } from '../../../src/workflow/test-helpers/canonical-envelope.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'tools-envelope-'));
  store = new EventStore(tempDir);
  await store.initialize();
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

describe('WorkflowTools_AllEmittedEvents_HaveCanonicalEnvelope', () => {
  it('tools.ts:159 — workflow.started event has canonical envelope', async () => {
    const featureId = 'tools-envelope-init';
    const result = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(result.success).toBe(true);

    const events = await store.query(featureId);
    const started = events.filter((e) => e.type === 'workflow.started');
    expect(started.length).toBe(1);
    assertCanonicalEnvelope(started);
  });

  it('tools.ts:745 — state.patched event has canonical envelope', async () => {
    const featureId = 'tools-envelope-patch';
    await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );

    const result = await handleSet(
      { featureId, updates: { artifacts: { design: '/tmp/d.md' } } },
      tempDir,
      store,
    );
    expect(result.success).toBe(true);

    const events = await store.query(featureId);
    const patched = events.filter((e) => e.type === 'state.patched');
    expect(patched.length).toBeGreaterThan(0);
    assertCanonicalEnvelope(patched);
  });

  it('tools.ts:1214+1344 — checkpoint events have canonical envelope', async () => {
    const featureId = 'tools-envelope-checkpoint';
    await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );

    const result = await handleCheckpoint(
      { featureId },
      tempDir,
      store,
    );
    expect(result.success).toBe(true);

    const events = await store.query(featureId);
    const checkpointEvents = events.filter(
      (e) =>
        e.type === 'workflow.checkpoint' ||
        e.type === 'workflow.checkpoint_written',
    );
    expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);
    assertCanonicalEnvelope(checkpointEvents);
  });
});
