// ─── EFF-003: equivalent concurrent gate executions ──────────────────────────
//
// The runner keys idempotency on `evidenceId`, which derives from the caller's
// `operationId`. Two executions of the SAME logical gate — identical
// (requirementId, phaseAttemptId, providerRef, subject) — arriving under
// distinct operationIds therefore mint distinct evidenceIds, read history before
// either has appended, and both append with no predecessor.
//
// Left alone that produces two competing active evidence records for one scope:
// the "competing active-predecessor evidence chains" the audit named. The
// admission contract is that equivalent concurrent operations converge on ONE
// canonical active result, while genuinely CONTRADICTORY concurrent results stay
// visible as a contradiction (they must deny admission, not silently pick one).
// ─────────────────────────────────────────────────────────────────────────────

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
  type DispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import {
  AdmissionEvidenceRecordedData,
  type AdmissionEvidenceRecorded,
} from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { selectEvidence } from '../../../../src/workflow/admission/select-evidence.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import type { ContentDigestV1 } from '../../../../src/workflow/admission/types.js';
import {
  runGate,
  type GateProviderExecutor,
  type GateRunRequest,
  type GateRunnerDependencies,
} from '../../../../src/verbs/gates/gate-runner.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';


// Tests for equivalent concurrent gate executions in the gate runner.
// The runner keys idempotency on `evidenceId`, which derives from the caller's `operationId`.
// Two runs of the same logical gate under distinct operationIds both append with no predecessor.
// Evidence selection must converge on one canonical active result for equivalent runs.
// Contradictory concurrent results must stay visible as a contradiction, so admission fails closed.

const FIXED_TIME = '2026-07-21T22:30:00.000Z';
const POLICY_DIGEST: ContentDigestV1 = {
  algorithm: 'sha256',
  value: '1'.repeat(64),
};

/**
 * `race` runs two gates under distinct dispatch contexts. It releases both providers only after both
 * enter, so neither run sees the append of the other when it reads history.
 */
describe('equivalent concurrent gate executions (EFF-003)', () => {
  let root: string;
  let eventStore: EventStore;
  let artifactStore: ContentAddressedStore;
  let request: GateRunRequest;

  function context(sessionId: string): DispatchContext {
    const identity = deriveMcpCallerIdentity({ sessionId });
    const authorization = snapshotCallerAuthorization(
      identity,
      createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos']),
      () => FIXED_TIME,
    );
    return mintDispatchContext(undefined, authorization);
  }

  function dependencies(executeProvider: GateProviderExecutor): GateRunnerDependencies {
    return {
      eventStore,
      artifactStore,
      executeProvider,
      providerVersion: 'test-provider-7',
      clock: () => FIXED_TIME,
    };
  }

  async function persistedEvidence(): Promise<AdmissionEvidenceRecorded[]> {
    const events = await eventStore.query(request.streamId, {
      type: 'admission.evidence-recorded',
    });
    return events.map((event) => AdmissionEvidenceRecordedData.parse(event.data));
  }

  function activeFor(records: readonly AdmissionEvidenceRecorded[]) {
    return selectEvidence({ evidence: records });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'exarchos-eff003-'));
    eventStore = new EventStore(join(root, 'events'));
    await eventStore.initialize();
    artifactStore = new ContentAddressedStore(join(root, 'artifacts'));
    request = {
      streamId: 'eff-003-race',
      gateClass: 'test-adequacy',
      phaseAttemptId: 'phase-attempt:eff-003',
      requirementId: 'requirement:test-adequacy',
      subject: createEvidenceSubject(
        { kind: 'task', taskId: 'task-eff-003' },
        { commit: 'abc123', diff: 'task-eff-003-diff' },
      ),
      providerInput: { taskId: 'task-eff-003' },
      policy: { policyId: 'verification-ladder', policyDigest: POLICY_DIGEST },
    };
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(root);
  });

  async function race(
    resultFor: (arm: 'a' | 'b') => ToolResult,
  ): Promise<[ToolResult, ToolResult]> {
    let entered = 0;
    let release: () => void = () => {};
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provider = (arm: 'a' | 'b'): GateProviderExecutor => async () => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      return resultFor(arm);
    };

    const run = (arm: 'a' | 'b'): Promise<ToolResult> =>
      Promise.resolve(
        runWithDispatchContext(context(`session-${arm}`), () =>
          runGate(request, dependencies(provider(arm))),
        ),
      );

    const [a, b] = await Promise.all([run('a'), run('b')]);
    return [a, b];
  }

  /**
   * The append-only log keeps one record per operation. The selected active set holds one record,
   * the reversed order selects the same record, and equivalent results are not a contradiction.
   */
  it('GateRunner_EquivalentConcurrentExecutions_OneCanonicalActiveChain', async () => {
    const passing: ToolResult = {
      success: true,
      data: { passed: true, report: { detail: 'identical' } },
    };
    const [a, b] = await race(() => passing);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);

    const records = await persistedEvidence();
    expect(records.length).toBe(2);
    expect(new Set(records.map((r) => r.evidence.evidenceId)).size).toBe(2);

    const selection = activeFor(records);
    expect(
      selection.activeEvidence.length,
      'equivalent concurrent executions must yield one canonical active result',
    ).toBe(1);

    const reversed = activeFor([...records].reverse());
    expect(reversed.activeEvidence[0]?.evidence.evidenceId).toBe(
      selection.activeEvidence[0]?.evidence.evidenceId,
    );

    expect(selection.contradictions).toEqual([]);
  });

  /**
   * The convergence rule must not hide disagreement. A pass that races a fail on the same subject is
   * the signal that admission must fail closed on.
   */
  it('GateRunner_ContradictoryConcurrentExecutions_StayVisibleAsContradiction', async () => {
    const [a, b] = await race((arm) =>
      arm === 'a'
        ? { success: true, data: { passed: true } }
        : { success: true, data: { passed: false } },
    );

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);

    const records = await persistedEvidence();
    expect(records.length).toBe(2);

    const selection = activeFor(records);
    expect(
      selection.contradictions.length,
      'contradictory concurrent verdicts must remain visible',
    ).toBeGreaterThan(0);
    expect(selection.activeEvidence.length).toBe(2);
  });

  /**
   * A success carrier must not resolve before its evidence append completes. Otherwise a caller can act
   * on a result that the log does not hold. The test wraps `append` to record the order only.
   */
  it('GateRunner_NoSuccessCarrierEscapesBeforeTheAppendResolves', async () => {
    let appendSettled = false;
    const observed: boolean[] = [];

    const originalAppend = eventStore.append.bind(eventStore);
    eventStore.append = (async (streamId, event, options) => {
      const result = await originalAppend(streamId, event, options);
      appendSettled = true;
      return result;
    }) as typeof eventStore.append;

    const result = await Promise.resolve(
      runWithDispatchContext(context('session-order'), () =>
        runGate(
          request,
          dependencies(async () => ({ success: true, data: { passed: true } })),
        ),
      ),
    );
    observed.push(appendSettled);

    expect(result.success).toBe(true);
    expect(observed[0], 'the carrier resolved before its evidence was durable').toBe(true);
  });
});
