// @oracle-sources: ../../../../src/dispatch/core/dispatch.ts, the post-dispatch postcondition observation — the store and the persisted-evidence reader, asked after the handler returned, rather than anything the handler said about itself
//
// ─── The three repaired review gates, through the REAL dispatch path ────────
//
// `check_security_scan`, `check_convergence` and `check_invariant_conformance`
// each declare durable gate evidence as a postcondition and each used to pay it
// with a bare `gate.executed` append. Dispatch observes declared postconditions
// after the handler returns, so the first two answered ENSURE_CONTRACT_VIOLATED
// on every call and the third would have as soon as it was admitted.
//
// Nothing is stubbed here — not the gate runner, not the handler table. That is
// the whole point: the sibling unit tests stub the runner to isolate a provider
// verdict, which is exactly the seam that hid this defect. What these cases ask
// is what a caller gets.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { deriveMcpCallerIdentity } from '../../../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  seedActivePhaseAttempt,
  seedGateEvidence,
} from '../../../../tools/test-helpers/trusted-context.js';

const STREAM = 'wf-review-gate-evidence';

const CAPABILITIES = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'isolation:worktree',
  'mcp:exarchos',
  'admission:issue-gate-evidence',
];

let stateDir: string;
let store: EventStore;
let phaseAttemptId: string;

function ctx(): DispatchContext {
  return {
    stateDir,
    eventStore: store,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'review-gate-evidence' }),
    capabilityResolver: createInMemoryResolver(CAPABILITIES),
  };
}

async function call(args: Record<string, unknown>): Promise<ToolResult> {
  return dispatch('exarchos_orchestrate', args, ctx());
}

/** The evidence rows one dispatch's operation left on the stream. */
async function evidenceCount(): Promise<number> {
  const rows = await store.query(STREAM, { type: 'admission.evidence-recorded' });
  return rows.length;
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'review-gate-evidence-'));
  store = new EventStore(stateDir);
  await store.initialize();
  phaseAttemptId = await seedActivePhaseAttempt(store, STREAM, { phase: 'review' });
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('review gates that declare durable evidence pay it on dispatch', () => {
  it('CheckSecurityScan_Dispatched_SucceedsAndRecordsEvidence', async () => {
    const before = await evidenceCount();

    const result = await call({
      action: 'check_security_scan',
      featureId: STREAM,
      diffContent: '+export const answer = 42;\n',
    });

    // Not merely "not this code": a success is what the caller is owed, and
    // naming the code keeps a future regression legible.
    expect(result.error?.code).not.toBe('ENSURE_CONTRACT_VIOLATED');
    expect(result.success).toBe(true);
    expect(await evidenceCount()).toBe(before + 1);
  });

  it('CheckConvergence_Dispatched_SucceedsAndRecordsEvidence', async () => {
    const before = await evidenceCount();

    const result = await call({ action: 'check_convergence', featureId: STREAM });

    expect(result.error?.code).not.toBe('ENSURE_CONTRACT_VIOLATED');
    expect(result.success).toBe(true);
    expect(await evidenceCount()).toBe(before + 1);
  });

  it('CheckInvariantConformance_Dispatched_SucceedsAndRecordsEvidence', async () => {
    // This gate requires a resolved review gate before it is admitted at all,
    // so the precondition is seeded first — otherwise the case would report an
    // admission denial and say nothing about the postcondition.
    await seedGateEvidence(store, {
      streamId: STREAM,
      requirementId: 'review',
      phaseAttemptId,
    });
    const before = await evidenceCount();

    const result = await call({
      action: 'check_invariant_conformance',
      featureId: STREAM,
      diff: '',
    });

    expect(result.error?.code).not.toBe('ENSURE_CONTRACT_VIOLATED');
    expect(result.success).toBe(true);
    expect(await evidenceCount()).toBe(before + 1);
  });

  it('EachGate_AttachesTheEvidenceItRecorded_ToItsOwnCarrier', async () => {
    // The evidence is not only in the log — the gate's carrier references it, so
    // a caller reading the result can find the record without querying.
    const result = await call({
      action: 'check_security_scan',
      featureId: STREAM,
      diffContent: '+const clean = true;\n',
    });

    const references = (result.data as { evidenceReferences?: unknown[] }).evidenceReferences;
    expect(Array.isArray(references)).toBe(true);
    expect(references).toHaveLength(1);
  });
});
