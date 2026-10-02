// Checks that every event from `handleCancel` carries a canonical envelope.
// A canonical envelope has a non-empty `correlationId`, a registered `source`, and data that passes its event-type schema.

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
 * Deletes `_esVersion` from the state file, so `handleCancel` takes its v1 legacy branches.
 * `handleInit` writes an ES v2 state by default.
 */
async function downgradeToV1(stateDir: string, featureId: string): Promise<void> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const raw = JSON.parse(await readFile(stateFile, 'utf-8'));
  delete raw._esVersion;
  await writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');
}

/**
 * The tracking issue and expiry date of the waiver for the two skipped envelope tests.
 * The waiver test fails on and after the expiry date.
 */
const CANCEL_CORRELATION_WAIVER = Object.freeze({
  issue: '#1789',
  expires: '2026-11-30',
});

/**
 * `CancelInput` holds only `featureId`, `reason`, and `dryRun`, so no caller supplies a `correlationId`.
 * The cancel code must not invent one, so the two envelope tests stay skipped under the waiver.
 */
describe('WorkflowCancel_AllEmittedEvents_HaveCanonicalEnvelope', () => {
  it('WorkflowCancel_EnvelopeSkipWaiver_HasNotExpired', () => {
    expect(
      CANCEL_CORRELATION_WAIVER.expires > new Date().toISOString().slice(0, 10),
      `The canonical-envelope skip waiver for cancel.ts (${CANCEL_CORRELATION_WAIVER.issue}) ` +
        `expired on ${CANCEL_CORRELATION_WAIVER.expires}. Two envelope assertions have been ` +
        `skipped since; either give CancelInput a correlation source and un-skip them, or ` +
        `re-justify and re-date the waiver.`,
    ).toBe(true);
  });

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
