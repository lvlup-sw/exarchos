// A gate that declares `gate.executed` must not return a success carrier when
// the durable append did not land. This file pins two seams that the gates share:
// how the shared runner records a provider failure carrier, and `requireGateEvent`.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentAddressedStore } from '../../../../src/storage/artifacts/content-addressed-store.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { AdmissionEvidenceRecordedData } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import type { ContentDigestV1 } from '../../../../src/workflow/admission/types.js';
import {
  runGate,
  type GateProviderExecutor,
  type GateRunRequest,
  type GateRunnerDependencies,
} from '../../../../src/verbs/gates/gate-runner.js';
import { requireGateEvent } from '../../../../src/verbs/gates/gate-utils.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const FIXED_TIME = '2026-08-28T00:00:00.000Z';
const POLICY_DIGEST: ContentDigestV1 = { algorithm: 'sha256', value: '2'.repeat(64) };

describe('gate.executed append failure — durable evidence honesty', () => {
  let root: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'exarchos-gate-event-honesty-'));
    eventStore = new EventStore(join(root, 'events'));
    await eventStore.initialize();
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(root);
  });

  /**
   * The provider returns what a `requireGateEvent` handler returns when its
   * append fails: a failure carrier that keeps the verdict on `data`. The runner
   * must record `indeterminate`, not a fabricated `fail`.
   */
  it('GateEventUnrecorded_UnderTheSharedRunner_RecordsAnIndeterminateVerdict', async () => {
    const artifactStore = new ContentAddressedStore(join(root, 'artifacts'));
    const request: GateRunRequest = {
      streamId: 'gate-event-honesty-tests',
      gateClass: 'test-adequacy',
      phaseAttemptId: 'phase-attempt:honesty-001',
      requirementId: 'requirement:test-adequacy',
      subject: createEvidenceSubject(
        { kind: 'task', taskId: 'task-honesty-001' },
        { commit: 'abc123', diff: 'honesty-001-diff' },
      ),
      providerInput: { taskId: 'task-honesty-001' },
      policy: { policyId: 'verification-ladder', policyDigest: POLICY_DIGEST },
    };

    const unrecordedProvider: GateProviderExecutor = async () => ({
      success: false,
      data: { passed: true, findingCount: 0 },
      error: {
        code: 'GATE_EVENT_UNRECORDED',
        message: "the gate ran and its verdict is preserved on `data`; the durable row did not land",
      },
    });

    const identity = deriveMcpCallerIdentity({ sessionId: 'gate-event-honesty' });
    const authorization = snapshotCallerAuthorization(
      identity,
      createInMemoryResolver([
        'fs:read',
        'fs:write',
        'shell:exec',
        'isolation:worktree',
        'mcp:exarchos',
      ]),
      () => FIXED_TIME,
    );
    const dispatchContext = mintDispatchContext(undefined, authorization);

    const dependencies: GateRunnerDependencies = {
      eventStore,
      artifactStore,
      executeProvider: unrecordedProvider,
      providerVersion: 'test-provider-honesty',
      clock: () => FIXED_TIME,
    };

    await runWithDispatchContext(dispatchContext, () => runGate(request, dependencies));

    const events = await eventStore.query(request.streamId, {
      type: 'admission.evidence-recorded',
    });
    expect(events).toHaveLength(1);
    const record = AdmissionEvidenceRecordedData.parse(events[0]!.data);
    expect(record.evidence.verdict).toBe('indeterminate');
  });

  it('RequireGateEvent_AppendSucceeds_ReturnsNothingAndLeavesOneRow', async () => {
    const streamId = 'gate-event-honesty-append-succeeds';
    const carrier: ToolResult = { success: true, data: { passed: true, findingCount: 0 } };

    const unrecorded = await requireGateEvent(
      eventStore,
      streamId,
      'workflow-determinism',
      'quality',
      true,
      carrier,
      { dimension: 'D5', phase: 'review', findingCount: 0 },
    );

    expect(unrecorded).toBeUndefined();
    const rows = await eventStore.query(streamId, { type: 'gate.executed' });
    expect(rows).toHaveLength(1);
    const data = rows[0]!.data as {
      gateName: string;
      layer: string;
      passed: boolean;
      details?: Record<string, unknown>;
    };
    expect(data.gateName).toBe('workflow-determinism');
    expect(data.layer).toBe('quality');
    expect(data.passed).toBe(true);
    expect(data.details).toEqual({ dimension: 'D5', phase: 'review', findingCount: 0 });
  });

  it('RequireGateEvent_SameOperationRetry_CollapsesOntoTheFirstRow', async () => {
    const streamId = 'gate-event-honesty-retry-collapse';
    const carrier: ToolResult = { success: true, data: { passed: true } };
    const idempotencyKey = 'gate.executed:workflow-determinism:same-op-honesty';

    await requireGateEvent(
      eventStore,
      streamId,
      'workflow-determinism',
      'quality',
      true,
      carrier,
      { dimension: 'D5', phase: 'review', findingCount: 0 },
      idempotencyKey,
    );
    await requireGateEvent(
      eventStore,
      streamId,
      'workflow-determinism',
      'quality',
      true,
      carrier,
      { dimension: 'D5', phase: 'review', findingCount: 0 },
      idempotencyKey,
    );

    const rows = await eventStore.query(streamId, { type: 'gate.executed' });
    expect(rows).toHaveLength(1);
  });
});
