// Caller evidence on `task_complete` cannot stand in for a gate run.
//
// `handleTaskComplete` enforces one gate, `static-analysis`, which the registry declares as
// blocking. The handler applies three rules:
// - Caller evidence never satisfies a blocking gate. `isBlockingGate` reads the registry field
//   `gate.blocking`, keyed by `gate.gateClass`.
// - For an advisory gate, evidence counts only with an operator capability from the dispatch
//   context. The transport sets `identity.role`, so a delegated agent cannot assert it.
// - The handler records caller evidence on `task.completed` as `data.evidence`, and it sets
//   `data.verified`.
//
// `task_complete` enforces no advisory gate, so no test in this file reaches the second rule.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../../src/events/store.js';
import { handleTaskComplete, isBlockingGate, resetModuleEventStore } from '../../../src/verbs/tasks/tools.js';
import { resetMaterializerCache } from '../../../src/projections/views/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller } from '../../../tools/test-helpers/trusted-context.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../src/dispatch/dispatch-context.js';
import { createInMemoryResolver } from '../../../src/workflow/capabilities/resolver.js';

let tempDir: string;

beforeEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  tempDir = await mkdtemp(path.join(tmpdir(), 'evidence-bypass-'));
});

afterEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  await rmrfAsync(tempDir);
});

/** A stream that holds one assigned task and no `gate.executed` event. */
async function seededStore(streamId: string, taskId: string): Promise<EventStore> {
  const store = new EventStore(tempDir);
  await store.append(streamId, {
    type: 'task.assigned',
    data: { taskId, title: 'Evidence bypass subject', assignee: 'agent-1' },
  });
  return store;
}

/**
 * Runs `fn` as a delegated agent, which is the posture of a governed implementer. It composes
 * the same production primitives as `runAsTrustedCaller`, so it cannot drift from real dispatch.
 * The only difference from the operator path is the transport-derived `role: 'agent'`.
 */
function runAsDelegatedAgent<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> {
  const authorization = snapshotCallerAuthorization(
    deriveMcpCallerIdentity({ sessionId }),
    createInMemoryResolver([
      'fs:read',
      'fs:write',
      'shell:exec',
      'isolation:worktree',
      'mcp:exarchos',
    ]),
  );
  return Promise.resolve(
    runWithDispatchContext(mintDispatchContext(undefined, authorization), fn),
  );
}

describe('DR-2: caller-supplied evidence cannot satisfy a blocking gate', () => {
  /**
   * The stream holds no `gate.executed` event, and the evidence claims a passing test run. The
   * handler refuses the call and records no `task.completed` event.
   */
  it('TaskComplete_CallerSuppliedEvidence_CannotSatisfyBlockingGate', async () => {
    const store = await seededStore('dr2-blocking', 'T-01');

    const result = await handleTaskComplete(
      {
        taskId: 'T-01',
        streamId: 'dr2-blocking',
        evidence: { type: 'test', output: '5727 tests passed', passed: true },
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.unmetGates).toContain('static-analysis');

    expect(await store.query('dr2-blocking', { type: 'task.completed' })).toHaveLength(0);
  });

  /**
   * The blocking rule does not depend on a capability. The trusted local operator also cannot
   * satisfy a blocking gate with evidence. Only a gate run can.
   */
  it('TaskComplete_CallerSuppliedEvidence_CannotSatisfyBlockingGateEvenAsOperator', async () => {
    const store = await seededStore('dr2-blocking-op', 'T-01');

    const result = await runAsTrustedCaller(tempDir, () =>
      handleTaskComplete(
        {
          taskId: 'T-01',
          streamId: 'dr2-blocking-op',
          evidence: { type: 'manual', output: 'docs-only task — no gates run', passed: true },
        },
        tempDir,
        store,
      ),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.unmetGates).toContain('static-analysis');
  });

  /**
   * `static-analysis` is the one gate that `task_complete` enforces, and it is blocking. Thus
   * the handler has no advisory path, and it refuses a delegated agent that holds write and
   * shell capabilities. The last assertion pins that the gate is blocking. The handler reads that
   * flag before it reads the capability.
   */
  it('TaskComplete_EvidenceBypassOnAdvisoryGate_RequiresOperatorCapability', async () => {
    const store = await seededStore('dr2-advisory', 'T-01');

    const result = await runAsDelegatedAgent('agent-session-1', () =>
      handleTaskComplete(
        {
          taskId: 'T-01',
          streamId: 'dr2-advisory',
          evidence: { type: 'test', output: 'green across the board', passed: true },
        },
        tempDir,
        store,
      ),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');

    expect(isBlockingGate('static-analysis')).toBe(true);
  });

  /**
   * `isBlockingGate` fails closed. Without this default, a gate name that `task_complete` adds
   * with no registration opens a new bypass.
   */
  it('TaskComplete_UnknownGateClass_IsTreatedAsBlocking', () => {
    expect(isBlockingGate('no-such-gate-class')).toBe(true);
  });

  /** The registry declares `mock-boundary` with `blocking: false`, and the handler holds no list. */
  it('TaskComplete_AdvisoryGateClass_IsReadFromRegistryNotHardcoded', () => {
    expect(isBlockingGate('mock-boundary')).toBe(false);
  });
});

describe('DR-2: evidence as PROVENANCE RECORD is preserved', () => {
  /**
   * When a `gate.executed` event carries the completion, the handler copies the caller evidence
   * to `task.completed` unchanged and sets `verified` to `true`.
   */
  it('TaskComplete_EvidenceWithPassingGate_StillRecordedAsProvenance', async () => {
    const store = await seededStore('dr2-record', 'T-01');
    await store.append('dr2-record', {
      type: 'gate.executed',
      data: {
        gateName: 'static-analysis',
        layer: 'quality',
        passed: true,
        details: { taskId: 'T-01' },
      },
    });

    const evidence = { type: 'test' as const, output: '5727 tests passed', passed: true };
    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'dr2-record', evidence },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);

    const [completed] = await store.query('dr2-record', { type: 'task.completed' });
    const data = completed.data as Record<string, unknown>;
    expect(data.evidence).toEqual(evidence);
    expect(data.verified).toBe(true);
  });

  /** With no evidence, the event holds an explicit `verified: false`, not an absent field. */
  it('TaskComplete_NoEvidenceWithPassingGate_RecordsVerifiedFalse', async () => {
    const store = await seededStore('dr2-unverified', 'T-01');
    await store.append('dr2-unverified', {
      type: 'gate.executed',
      data: {
        gateName: 'static-analysis',
        layer: 'quality',
        passed: true,
        details: { taskId: 'T-01' },
      },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'dr2-unverified' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);

    const [completed] = await store.query('dr2-unverified', { type: 'task.completed' });
    const data = completed.data as Record<string, unknown>;
    expect(data.evidence).toBeUndefined();
    expect(data.verified).toBe(false);
  });
});
