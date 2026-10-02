// @oracle-sources: ../../../../src/dispatch/core/dispatch.ts, the post-dispatch postcondition observation — the store and the persisted-evidence reader, asked after the handler returned, rather than anything the handler said about itself
//
// These tests run review and plan gates through the real dispatch path. Each
// gate declares durable gate evidence as a postcondition. Dispatch checks each
// declared fact in the store after the handler returns. A missing fact fails
// the call with ENSURE_CONTRACT_VIOLATED.
//
// These tests stub nothing, not the gate runner and not the handler table. The
// unit tests of each gate stub the runner, so they cannot see a missing
// evidence row.

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

/**
 * A case asserts that the code is not ENSURE_CONTRACT_VIOLATED and also that
 * the call succeeds. The first assertion names the fault if a regression occurs.
 */
describe('review gates that declare durable evidence pay it on dispatch', () => {
  it('CheckSecurityScan_Dispatched_SucceedsAndRecordsEvidence', async () => {
    const before = await evidenceCount();

    const result = await call({
      action: 'check_security_scan',
      featureId: STREAM,
      diffContent: '+export const answer = 42;\n',
    });

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

  /**
   * Dispatch admits this gate only after a resolved review gate. The test seeds
   * that evidence first, so the case tests the postcondition and not an
   * admission denial.
   */
  it('CheckInvariantConformance_Dispatched_SucceedsAndRecordsEvidence', async () => {
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

  /**
   * `workflowId` changes the stream that the gate reads. The gate still writes
   * its rows on the `featureId` stream, which the action declares. The other
   * stream gets no `gate.executed` row.
   */
  it('CheckConvergence_WorkflowIdNamingAnotherStream_StillRecordsOnTheSubject', async () => {
    const other = 'wf-review-gate-evidence-other';
    await seedActivePhaseAttempt(store, other, { phase: 'review' });

    const result = await call({
      action: 'check_convergence',
      featureId: STREAM,
      workflowId: other,
    });

    expect(result.error?.code).toBeUndefined();
    expect(result.success).toBe(true);
    const signal = await store.query(STREAM, { type: 'gate.executed' });
    expect(signal.map((row) => (row.data as { gateName?: string }).gateName)).toContain(
      'convergence',
    );
    expect(await store.query(other, { type: 'gate.executed' })).toHaveLength(0);
  });

  /**
   * The gate binds to the plan phases, so the test seeds its own plan-phase
   * attempt. The review attempt from `beforeEach` is not its subject.
   */
  it('CheckTaskDecomposition_Dispatched_SucceedsAndRecordsEvidence', async () => {
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

  /**
   * `skipRun` stops the post-implementation test run for each test file that
   * the plan names. This case tests only the evidence record.
   */
  it('SpecCoverageCheck_Dispatched_SucceedsAndRecordsEvidence', async () => {
    const planStream = 'wf-plan-gate-evidence-coverage';
    await seedActivePhaseAttempt(store, planStream, { phase: 'plan' });
    const planPath = await writePlan();
    const before = await evidenceCount(planStream);

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

  /**
   * The runner runs the provider again before it finds that the operation
   * already produced evidence. The provider keys its `gate.executed` append on
   * the operation identity, so a retry of one operation leaves one row. The
   * test calls the handler directly, because `dispatch()` mints a new operation
   * id for each call. The operation carries the trusted caller snapshot that
   * the runner requires.
   */
  it('CheckTaskDecomposition_SameOperationRetried_LeavesOneGateExecutedRow', async () => {
    const planStream = 'wf-plan-gate-evidence-retry';
    await seedActivePhaseAttempt(store, planStream, { phase: 'plan' });
    const planPath = await writePlan();

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

  /**
   * The gate result references the evidence that it recorded, so a caller can
   * find the record without a query.
   */
  it('EachGate_AttachesTheEvidenceItRecorded_ToItsOwnCarrier', async () => {
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
