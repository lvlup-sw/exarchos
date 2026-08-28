// @oracle-sources: ../../../../src/dispatch/core/dispatch.ts, the post-dispatch postcondition observation — the store and the persisted-evidence reader, asked after the handler returned, rather than anything the handler said about itself
//
// ─── The repaired gates, through the REAL dispatch path ────────────────────
//
// `check_security_scan`, `check_convergence` and `check_invariant_conformance`
// each declare durable gate evidence as a postcondition and each used to pay it
// with a bare `gate.executed` append; `check_task_decomposition` did the same,
// and `spec_coverage_check` recorded nothing at all. Dispatch observes declared postconditions
// after the handler returns, so the first two answered ENSURE_CONTRACT_VIOLATED
// on every call and the third would have as soon as it was admitted.
//
// Nothing is stubbed here — not the gate runner, not the handler table. That is
// the whole point: the sibling unit tests stub the runner to isolate a provider
// verdict, which is exactly the seam that hid this defect. What these cases ask
// is what a caller gets.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { handleTaskDecomposition } from '../../../../src/verbs/tasks/task-decomposition.js';
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
async function evidenceCount(streamId: string = STREAM): Promise<number> {
  const rows = await store.query(streamId, { type: 'admission.evidence-recorded' });
  return rows.length;
}

/** A throwaway plan the two plan gates can read. */
async function writePlan(): Promise<string> {
  const planPath = path.join(stateDir, 'plan.md');
  await writeFile(
    planPath,
    [
      '# Implementation Plan',
      '',
      '## Tasks',
      '',
      '### Task T-01: Add the widget rendering component to the dashboard view',
      '**Description:** Build the widget rendering component that handles all display',
      'logic including template compilation and DOM updates for the dashboard view.',
      '**Files:**',
      '- `src/components/widget.ts`',
      '**Tests:**',
      '- [RED] `Widget_Render_DisplaysContent` — verify the widget renders content',
      '',
      '**Test file:** `src/components/widget.test.ts`',
      '',
      '**Dependencies:** None',
      '**Parallelizable:** No',
      '',
    ].join('\n'),
    'utf-8',
  );
  return planPath;
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

  it('CheckConvergence_WorkflowIdNamingAnotherStream_StillRecordsOnTheSubject', async () => {
    // `workflowId` re-points the READ. It used to re-point the WRITE too, which
    // put the gate's own row on a stream the action does not declare it touches
    // — so the caller got a refusal for a shape its own schema still accepts,
    // and the evidence and the signal ended up on two different streams.
    const other = 'wf-review-gate-evidence-other';
    await seedActivePhaseAttempt(store, other, { phase: 'review' });

    const result = await call({
      action: 'check_convergence',
      featureId: STREAM,
      workflowId: other,
    });

    expect(result.error?.code).toBeUndefined();
    expect(result.success).toBe(true);
    // Both durable rows on the declared subject; the read stream carries none.
    const signal = await store.query(STREAM, { type: 'gate.executed' });
    expect(signal.map((row) => (row.data as { gateName?: string }).gateName)).toContain(
      'convergence',
    );
    expect(await store.query(other, { type: 'gate.executed' })).toHaveLength(0);
  });

  it('CheckTaskDecomposition_Dispatched_SucceedsAndRecordsEvidence', async () => {
    // A plan-phase attempt of its own: the gate is bound to the plan phases, and
    // the review attempt seeded in `beforeEach` is not the subject it keys by.
    const planStream = 'wf-plan-gate-evidence-decomposition';
    await seedActivePhaseAttempt(store, planStream, { phase: 'plan' });
    const planPath = await writePlan();
    const before = await evidenceCount(planStream);

    const result = await call({
      action: 'check_task_decomposition',
      featureId: planStream,
      planPath,
    });

    expect(result.error?.code).not.toBe('ENSURE_CONTRACT_VIOLATED');
    expect(result.success).toBe(true);
    expect(await evidenceCount(planStream)).toBe(before + 1);
  });

  it('SpecCoverageCheck_Dispatched_SucceedsAndRecordsEvidence', async () => {
    const planStream = 'wf-plan-gate-evidence-coverage';
    await seedActivePhaseAttempt(store, planStream, { phase: 'plan' });
    const planPath = await writePlan();
    const before = await evidenceCount(planStream);

    // `skipRun` because the post-implementation phase otherwise shells a test
    // run once per test file the plan references, which is not this case's
    // subject — the subject is whether the verdict carries its declared record.
    const result = await call({
      action: 'spec_coverage_check',
      featureId: planStream,
      planFile: planPath,
      repoRoot: stateDir,
      skipRun: true,
      coveragePhase: 'plan',
    });

    expect(result.error?.code).not.toBe('ENSURE_CONTRACT_VIOLATED');
    expect(result.success).toBe(true);
    expect(await evidenceCount(planStream)).toBe(before + 1);
  });

  it('CheckTaskDecomposition_SameOperationRetried_LeavesOneGateExecutedRow', async () => {
    // The provider mints its own `gate.executed` from inside the runner, and the
    // runner re-runs the provider before it can discover that this operation
    // already produced evidence. Unkeyed, one gate run under a retried operation
    // left two rows — only the evidence row collapsed on its deterministic id.
    // Keying the append on the operation identity a retry deliberately reuses
    // collapses them; two genuinely distinct calls still leave two rows.
    //
    // Driven under the handler rather than `dispatch()`: dispatch mints a fresh
    // operation id per call, so a retry of ONE operation is not a shape that
    // seam can express.
    const planStream = 'wf-plan-gate-evidence-retry';
    await seedActivePhaseAttempt(store, planStream, { phase: 'plan' });
    const planPath = await writePlan();

    // Trusted caller identity is a precondition of the runner, so the retried
    // operation carries the same authorization snapshot a dispatch would mint.
    const operation = mintDispatchContext(
      undefined,
      snapshotCallerAuthorization(
        deriveMcpCallerIdentity({ sessionId: 'review-gate-evidence' }),
        createInMemoryResolver(CAPABILITIES),
      ),
    );
    const runOnce = async (): Promise<ToolResult> =>
      handleTaskDecomposition({ featureId: planStream, planPath }, stateDir, store);
    await runWithDispatchContext(operation, runOnce);
    await runWithDispatchContext(operation, runOnce);

    const rows = await store.query(planStream, { type: 'gate.executed' });
    expect(rows).toHaveLength(1);
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
