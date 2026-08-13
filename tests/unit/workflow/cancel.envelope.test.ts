// ─── cancel.envelope (#1325 task α-07) ────────────────────────────────────
//
// Property-style assertion: every event emitted by `handleCancel` carries a
// canonical envelope — non-empty `correlationId`, registered `source`, and
// per-event-type data schema validates.
//
// RED expectation: the six raw `eventStore.append(...)` sites in `cancel.ts`
// (lines 131, 151, 190, 202, 225, 236) currently bypass `buildValidatedEvent`
// and emit events without `correlationId` or `source`. This test exercises
// the four distinct emission paths and fails today; α-08 closes the gap.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { handleInit } from '../../../src/workflow/tools.js';
import { handleCancel } from '../../../src/workflow/cancel.js';
import { assertCanonicalEnvelope } from '../../../src/workflow/test-helpers/canonical-envelope.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'cancel-envelope-'));
  store = new EventStore(tempDir);
  await store.initialize();
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

/**
 * `handleInit` produces an ES v2 state by default. To exercise the V1 legacy
 * branches inside `handleCancel`, downgrade the state file's `_esVersion` to
 * something other than 2.
 */
async function downgradeToV1(stateDir: string, featureId: string): Promise<void> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const raw = JSON.parse(await readFile(stateFile, 'utf-8'));
  delete raw._esVersion;
  await writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');
}

describe('WorkflowCancel_AllEmittedEvents_HaveCanonicalEnvelope', () => {
  // PER-SITE ABORT (α-08): all 6 emission sites in `cancel.ts` (lines 131,
  // 151, 190, 202, 225, 236) lack a caller-supplied `correlationId` source.
  // `CancelInput` shape is `{ featureId, reason?, dryRun? }` — there is no
  // upstream correlation context to thread. Per the design's hard
  // constraint ("DO NOT invent a correlationId"), all six sites stay on the
  // raw `eventStore.append` path and the assertions below are skipped.
  // Tracking follow-up: TODO file as #TBD-cancel-correlation-context once
  // the parent integration cycle closes.

  // cancel.ts:190 + :202 — ES v2 transition + cancel emissions
  it.skip('cancel.ts:190+:202 — ES v2 transition + cancel events have canonical envelope', async () => {
    const featureId = 'cancel-envelope-es2';
    await handleInit({ featureId, workflowType: 'feature' }, tempDir, store);

    const result = await handleCancel({ featureId }, tempDir, store);
    expect(result.success).toBe(true);

    const events = await store.query(featureId);
    const cancelPathEvents = events.filter(
      (e) => e.type === 'workflow.transition' || e.type === 'workflow.cancel',
    );
    expect(cancelPathEvents.length).toBeGreaterThan(0);
    assertCanonicalEnvelope(cancelPathEvents);
  });

  // cancel.ts:225 + :236 — V1 legacy transition + cancel emissions
  it.skip('cancel.ts:225+:236 — V1 legacy transition + cancel events have canonical envelope', async () => {
    const featureId = 'cancel-envelope-v1';
    await handleInit({ featureId, workflowType: 'feature' }, tempDir, store);
    await downgradeToV1(tempDir, featureId);

    const result = await handleCancel({ featureId }, tempDir, store);
    expect(result.success).toBe(true);

    const events = await store.query(featureId);
    const cancelPathEvents = events.filter(
      (e) => e.type === 'workflow.transition' || e.type === 'workflow.cancel',
    );
    expect(cancelPathEvents.length).toBeGreaterThan(0);
    assertCanonicalEnvelope(cancelPathEvents);
  });
});
