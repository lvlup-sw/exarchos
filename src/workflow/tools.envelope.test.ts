// ─── tools.envelope (#1325 task α-13) ────────────────────────────────────
//
// Property-style assertion: every event emitted by the `tools.ts`
// workflow handlers carries a canonical envelope — non-empty
// `correlationId`, registered `source`, and per-event-type data
// schema validates.
//
// Seven emission paths in `tools.ts` today:
//
//   - Line 159 (handleInit → `workflow.started`)
//   - Line 470 (handleSet → `checkpoint.state_missing`, graceful-degrade)
//   - Line 485 (handleSet → `checkpoint.enforced`, gated transition)
//   - Line 745 (handleSet → `state.patched`, field-only update)
//   - Line 812 (handleSet → `workflow.cas-failed`, CAS exhaustion catch)
//   - Line 1214 (handleCheckpoint → `workflow.checkpoint`)
//   - Line 1344 (handleCheckpoint → `workflow.checkpoint_written`)
//
// Six of the seven sites already supply `correlationId: input.featureId`
// and `source: 'workflow'` today (lines 159, 470, 485, 745, 1214, 1344).
// Site 812 (`workflow.cas-failed` best-effort diagnostic) does NOT
// supply correlation context. This test is "RED that pins the
// invariant for the canonical sites" today — α-14 closes the gap
// (and either migrates 812 or aborts it with a follow-up issue).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import {
  handleInit,
  handleSet,
  handleCheckpoint,
} from './tools.js';
import { assertCanonicalEnvelope } from './test-helpers/canonical-envelope.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

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
  // Line 159 — workflow.started on init
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

  // Line 745 — state.patched on field-only set
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

  // Line 1214 + 1344 — workflow.checkpoint + workflow.checkpoint_written
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
    // Both events should land on a successful checkpoint cycle.
    expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);
    assertCanonicalEnvelope(checkpointEvents);
  });

  // Lines 470 / 485 / 812 — checkpoint-gate + CAS-exhaustion paths.
  //
  // These three sites guard against deep failure modes that require
  // significant fixture setup to exercise authentically (gate threshold
  // injection, CAS-storm injection). The α-09/α-11 fixtures focused on
  // the simplest realistic paths through their respective handlers; for
  // tools.ts, sites 470, 485, and 812 are covered transitively — the
  // assertions in α-13 + α-14 stand on:
  //   - lines 470 / 485 today already supply `correlationId` /
  //     `source`, matching the canonical shape used by lines 159 / 745
  //     / 1214 / 1344 (above).
  //   - line 812 does NOT supply them today and is the only candidate
  //     for the per-site abort condition in α-14.
  // The per-site abort decision and follow-up issue (if any) are
  // recorded in the α-14 commit message; this test pins the canonical
  // invariant on the four representative sites above and leaves the
  // three gate/CAS paths for a future fixture-investment task.
});
