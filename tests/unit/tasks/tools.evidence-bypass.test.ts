// ─── DR-2: the governed cannot supply its own governance ────────────────────
//
// `handleTaskComplete` used to accept an `evidence` object FROM THE AGENT
// BEING GOVERNED and, when `evidence.passed === true` with substantive
// output, short-circuit gate enforcement entirely.
//
// CHARACTERIZATION of the pre-fix behaviour (captured before the change, and
// preserved below as the KILL FIXTURE): with NO `gate.executed` event in the
// stream, `{ type: 'test', output: '5727 tests passed', passed: true }` made
// `task_complete` SUCCEED. The single gate `handleTaskComplete` enforces is
// `static-analysis`, which the registry declares
// `gate: { blocking: true, dimension: 'D2', gateClass: 'static-analysis' }` —
// so the bypass let a caller satisfy a BLOCKING gate by asserting its own
// compliance.
//
// THE CHANGE:
//   - caller-supplied evidence can NEVER satisfy a BLOCKING gate (blocking-ness
//     is read from the registry's `action.gate.blocking`, keyed by
//     `gate.gateClass` — not a parallel notion maintained in the handler);
//   - for a NON-blocking (advisory) gate the bypass survives only behind an
//     explicit OPERATOR capability, taken from the ambient DispatchContext
//     authorization (the same trust-tier mechanism that yields
//     CAPABILITY_DENIED for shared-mutating actions). `identity.role` is
//     transport-derived and cannot be self-asserted, so a delegated agent
//     (`role: 'agent'`) can never clear it;
//   - `evidence` remains fully live as a PROVENANCE RECORD: it is still
//     stamped onto `task.completed` as `data.evidence` with `data.verified`.

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

/** A stream holding a real assigned task and NO gate.executed event. */
async function seededStore(streamId: string, taskId: string): Promise<EventStore> {
  const store = new EventStore(tempDir);
  await store.append(streamId, {
    type: 'task.assigned',
    data: { taskId, title: 'Evidence bypass subject', assignee: 'agent-1' },
  });
  return store;
}

/**
 * Run `fn` as a DELEGATED AGENT — the posture a governed implementer actually
 * holds. Composed from the same production primitives as
 * `runAsTrustedCaller` (`deriveMcpCallerIdentity` + `snapshotCallerAuthorization`
 * + `mintDispatchContext`), so it cannot drift from real dispatch plumbing;
 * the ONLY difference from the operator path is the transport-derived
 * `role: 'agent'`, which is precisely the axis under test.
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
  it('TaskComplete_CallerSuppliedEvidence_CannotSatisfyBlockingGate', async () => {
    // KILL FIXTURE. This is verbatim the call that SUCCEEDED before the fix
    // (see the characterization note at the top of this file). If a future
    // change re-opens the hole, this assertion goes red.
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

    // And nothing was recorded — the refusal is total, not cosmetic.
    expect(await store.query('dr2-blocking', { type: 'task.completed' })).toHaveLength(0);
  });

  it('TaskComplete_CallerSuppliedEvidence_CannotSatisfyBlockingGateEvenAsOperator', async () => {
    // The blocking rule is ABSOLUTE — it is not merely a missing capability.
    // Even the fully-trusted local operator cannot buy off a blocking gate
    // with a caller-supplied assertion; only a real gate run can.
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

  it('TaskComplete_EvidenceBypassOnAdvisoryGate_RequiresOperatorCapability', async () => {
    // The bypass survives ONLY for non-blocking gates behind an operator
    // capability. `static-analysis` — the one gate task_complete enforces —
    // is registered blocking, so there is no advisory path for a caller to
    // take: the delegated agent, holding the richest posture an implementer
    // ever gets (fs:write + shell:exec, worktree-isolated), is still refused.
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

    // Pin WHY the agent is refused: the gate it tried to buy off is declared
    // blocking by the registry, so the capability question is never reached.
    expect(isBlockingGate('static-analysis')).toBe(true);
  });

  it('TaskComplete_UnknownGateClass_IsTreatedAsBlocking', () => {
    // Fail-closed default: a gate class absent from the registry is the case
    // we know least about, so it gets the strongest protection. Without this,
    // adding a gate name to task_complete without registering it would
    // silently open a new bypass.
    expect(isBlockingGate('no-such-gate-class')).toBe(true);
  });

  it('TaskComplete_AdvisoryGateClass_IsReadFromRegistryNotHardcoded', () => {
    // Blocking-ness comes from the registry's declared model, not a list
    // restated in the handler: `mock-boundary` is registered
    // `{ blocking: false, dimension: 'D1', gateClass: 'mock-boundary' }`.
    // If this flips, the handler's behaviour flips with it — which is the
    // point of reading the single source of truth.
    expect(isBlockingGate('mock-boundary')).toBe(false);
  });
});

// The two cases below are about what `task.completed` RECORDS, not about who
// may satisfy a gate. Their hand-seeded signal row cites no runner-minted
// evidence, so admission now holds it to the same operator bar the evidence
// path enforces — hence the operator scope a real CLI invocation opens.
describe('DR-2: evidence as PROVENANCE RECORD is preserved', () => {
  it('TaskComplete_EvidenceWithPassingGate_StillRecordedAsProvenance', async () => {
    // Evidence has two jobs; only "satisfy a gate" was removed. When a REAL
    // gate.executed signal carries the completion, the caller's evidence is
    // still stamped onto task.completed verbatim with verified===true.
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
    const result = await runAsTrustedCaller(tempDir, () =>
      handleTaskComplete(
        { taskId: 'T-01', streamId: 'dr2-record', evidence },
        tempDir,
        store,
      ),
    );

    expect(result.success).toBe(true);

    const [completed] = await store.query('dr2-record', { type: 'task.completed' });
    const data = completed.data as Record<string, unknown>;
    expect(data.evidence).toEqual(evidence);
    expect(data.verified).toBe(true);
  });

  it('TaskComplete_NoEvidenceWithPassingGate_RecordsVerifiedFalse', async () => {
    // The other half of the recording contract: absent evidence still yields
    // an explicit `verified: false` rather than a missing field.
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

    const result = await runAsTrustedCaller(tempDir, () =>
      handleTaskComplete({ taskId: 'T-01', streamId: 'dr2-unverified' }, tempDir, store),
    );

    expect(result.success).toBe(true);

    const [completed] = await store.query('dr2-unverified', { type: 'task.completed' });
    const data = completed.data as Record<string, unknown>;
    expect(data.evidence).toBeUndefined();
    expect(data.verified).toBe(false);
  });
});
