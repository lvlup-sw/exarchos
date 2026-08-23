// ─── Scope failures leave a durable trace ────────────────────────────────────
//
// Every precondition the gate runner checks used to return its error envelope
// before the first append, so "this gate could not be scoped" wrote nothing at
// all — and a reader of the log could not tell it apart from a gate that was
// never invoked. That was the largest unrecorded outcome in the gate system.
//
// The trace uses the vocabulary that already exists: `gate.executed` with
// `passed:false` and an `indeterminate` verdict, meaning the gate produced
// neither proof nor a finding.
// ────────────────────────────────────────────────────────────────────────────

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentAddressedStore } from '../../src/storage/artifacts/content-addressed-store.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../src/events/store.js';
import { createEvidenceSubject } from '../../src/workflow/admission/evidence-subject.js';
import type { ContentDigestV1 } from '../../src/workflow/admission/types.js';
import {
  runGate,
  runPhaseGateWithEvidence,
  gateRunnerObservationSource,
  GATE_RUNNER_GATE_LAYER,
  type GateProviderExecutor,
  type GateRunRequest,
  type GateRunnerDependencies,
} from '../../src/verbs/gates/gate-runner.js';
import { seedActivePhaseAttempt } from '../../tools/test-helpers/trusted-context.js';

const FIXED_TIME = '2026-08-22T09:00:00.000Z';
const GATE_CLASS = 'test-adequacy';
const POLICY_DIGEST: ContentDigestV1 = { algorithm: 'sha256', value: '2'.repeat(64) };

interface GateExecutedRow {
  readonly gateName: string;
  readonly layer: string;
  readonly passed: boolean;
  readonly details?: Record<string, unknown>;
}

describe('gate scope-failure recording', () => {
  let root: string;
  let eventStore: EventStore;
  let artifactStore: ContentAddressedStore;

  const neverCalled: GateProviderExecutor = async () => {
    throw new Error('the provider must not run once scoping has failed');
  };

  function trustedScope<T>(fn: () => T | Promise<T>): Promise<T> {
    const authorization = snapshotCallerAuthorization(
      deriveMcpCallerIdentity({ sessionId: 'scope-failure' }),
      createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos']),
      () => FIXED_TIME,
    );
    return Promise.resolve(
      runWithDispatchContext(mintDispatchContext(undefined, authorization), fn),
    );
  }

  function dependencies(): GateRunnerDependencies {
    return { eventStore, artifactStore, executeProvider: neverCalled, clock: () => FIXED_TIME };
  }

  /** A request that is well-formed except for the field named by the caller. */
  function requestWith(overrides: Partial<GateRunRequest>): GateRunRequest {
    return {
      streamId: 'scope-failure-stream',
      gateClass: GATE_CLASS,
      phaseAttemptId: 'phase-attempt:scope-1',
      requirementId: 'requirement:test-adequacy',
      subject: createEvidenceSubject(
        { kind: 'task', taskId: 'task-scope-1' },
        { commit: 'abc123', diff: 'scope-diff' },
      ),
      providerInput: { taskId: 'task-scope-1' },
      policy: { policyId: 'verification-ladder', policyDigest: POLICY_DIGEST },
      ...overrides,
    };
  }

  async function gateExecutedRows(streamId: string): Promise<GateExecutedRow[]> {
    const events = await eventStore.query(streamId, { type: 'gate.executed' });
    return events.map((event) => event.data as unknown as GateExecutedRow);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'exarchos-gate-scope-'));
    eventStore = new EventStore(join(root, 'events'));
    await eventStore.initialize();
    artifactStore = new ContentAddressedStore(join(root, 'artifacts'));
  });

  afterEach(async () => {
    eventStore.close();
    await rm(root, { recursive: true, force: true });
  });

  it('ScopeFailure_LeavesADurableTrace', async () => {
    // A requirement id the stable-id schema rejects: the gate is reachable, its
    // provider is registered, and it still cannot be scoped.
    const result = await trustedScope(() =>
      runGate(requestWith({ requirementId: 'not a valid id' }), dependencies()),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_GATE_SCOPE');

    const rows = await gateExecutedRows('scope-failure-stream');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gateName: GATE_CLASS,
      layer: GATE_RUNNER_GATE_LAYER,
      passed: false,
    });
    // Indeterminate, not failed: nothing was verified, so naming a failure would
    // report a finding that was never observed.
    expect(rows[0]?.details).toMatchObject({
      gateClass: GATE_CLASS,
      verdict: 'indeterminate',
      scopeFailure: 'INVALID_GATE_SCOPE',
    });

    const events = await eventStore.query('scope-failure-stream', { type: 'gate.executed' });
    expect(events[0]?.source).toBe(gateRunnerObservationSource(GATE_CLASS));
  });

  it('NotInvoked_And_CouldNotScope_AreDistinguishable', async () => {
    // Two streams, identical but for one dispatch. Before the trace existed the
    // two logs were byte-identical, which is the whole defect.
    const untouched = await gateExecutedRows('never-invoked-stream');
    expect(untouched).toEqual([]);

    await trustedScope(() =>
      runGate(
        requestWith({ streamId: 'could-not-scope-stream', phaseAttemptId: 'bad attempt id' }),
        dependencies(),
      ),
    );

    const scoped = await gateExecutedRows('could-not-scope-stream');
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.details?.verdict).toBe('indeterminate');
    expect(await gateExecutedRows('never-invoked-stream')).toEqual([]);
  });

  it('ScopeFailure_SameOperation_CollapsesToOneRow', async () => {
    // A retried call under one operation must not fan the log out into a row per
    // attempt — the same collapse a concluded run gets.
    await trustedScope(async () => {
      await runGate(requestWith({ requirementId: 'not a valid id' }), dependencies());
      await runGate(requestWith({ requirementId: 'not a valid id' }), dependencies());
    });

    expect(await gateExecutedRows('scope-failure-stream')).toHaveLength(1);
  });

  it('PhaseGateScopeFailure_LeavesADurableTrace', async () => {
    // The phase-gate adapter has its own scoping step, and it too returned an
    // error envelope before any append.
    await seedActivePhaseAttempt(eventStore, 'phase-gate-stream');

    const result = await trustedScope(() =>
      runPhaseGateWithEvidence({
        streamId: 'phase-gate-stream',
        gateClass: 'plan-coverage',
        requirementId: 'requirement:plan-coverage',
        stateDir: join(root, 'state'),
        eventStore,
        subject: () => {
          throw new Error('subject cannot be constructed');
        },
        providerInput: {},
        executeProvider: neverCalled,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_GATE_SCOPE');

    const rows = await gateExecutedRows('phase-gate-stream');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gateName: 'plan-coverage', passed: false });
    expect(rows[0]?.details?.verdict).toBe('indeterminate');
  });
});
