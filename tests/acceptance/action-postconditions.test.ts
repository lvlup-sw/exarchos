import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import {
  applicableEnsures,
  observeActionPostconditions,
} from '../../src/dispatch/core/action-postconditions.js';
import {
  dispatch,
  stubCompositeHandler,
  type DispatchContext,
} from '../../src/dispatch/core/dispatch.js';
import { getDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { replayedEvidence } from '../../src/dispatch/core/effect-carrier.js';
import type { EventStore } from '../../src/events/store.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import {
  clearCustomTools,
  registerCustomTool,
  setCustomToolActionHandler,
} from '../../src/registry.js';
import { unregisteredActionOutputSchema } from '../../src/output-schema-declaration.js';
import {
  declared,
  none,
  withActionContract,
  type ActionContract,
  type ActionPostcondition,
} from '../../src/registry/action-contract.js';
import { LOCAL_MUTATION, READ_ONLY_LOCAL } from '../../src/registry/annotations.js';
import { ADMISSION_EVENT_TYPES } from '../../src/workflow/admission/types.js';

const STREAM = 'feature-postconditions';
const OPERATION = 'operation.postconditions-1';
const DIGEST = { algorithm: 'sha256' as const, value: 'a'.repeat(64) };

interface StoreRow {
  readonly type: string;
  readonly operationId?: string;
  readonly data?: unknown;
}

function memorySource(rows: readonly StoreRow[]) {
  return {
    async query(
      _streamId: string,
      filters?: { type?: string; operationId?: string },
    ): Promise<readonly StoreRow[]> {
      return rows.filter((row) => {
        if (filters?.type !== undefined && row.type !== filters.type) return false;
        if (filters?.operationId !== undefined && row.operationId !== filters.operationId) {
          return false;
        }
        return true;
      });
    },
  };
}

function persistedGateEvidence(operationId: string): StoreRow {
  return {
    type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
    operationId,
    data: {
      eventVersion: '1.0',
      evidence: {
        contractVersion: '1.0',
        evidenceId: 'evidence.gate-1',
        requirementId: 'requirement.typecheck',
        phaseAttemptId: 'phase-attempt.1',
        subject: { kind: 'task', taskId: 'task.1', digest: DIGEST },
        producer: {
          producerId: 'producer.gate-runner',
          providerRef: 'provider.static-analysis',
          providerVersion: '1.3.0',
          invocationId: 'invocation.gate-1',
        },
        policyId: 'policy.transition',
        policyDigest: DIGEST,
        contentDigest: DIGEST,
        createdAt: '2026-08-22T00:00:00.000Z',
        kind: 'gate',
        verdict: 'pass',
      },
    },
  };
}

describe('durable action postcondition observation', () => {
  it('Postconditions_CommittedEvent_IsSatisfied', async () => {
    const store = memorySource([
      { type: 'workflow.started', operationId: OPERATION },
    ]);

    const observation = await observeActionPostconditions({
      ensures: declared({
        source: 'event-append',
        when: 'success',
        event: 'workflow.started',
      }),
      store,
      evidence: memorySource([]),
      streamId: STREAM,
      operationId: OPERATION,
    });

    expect(observation.status).toBe('satisfied');
    expect(observation.missing).toEqual([]);
  });

  it('Postconditions_MissingEvent_IsViolation', async () => {
    const observation = await observeActionPostconditions({
      ensures: declared({
        source: 'event-append',
        when: 'success',
        event: 'workflow.started',
      }),
      store: memorySource([]),
      evidence: memorySource([]),
      streamId: STREAM,
      operationId: OPERATION,
    });

    expect(observation.status).toBe('violated');
    expect(observation.missing).toEqual([
      { source: 'event-append', when: 'success', event: 'workflow.started' },
    ]);
  });

  it('Postconditions_PersistedEvidence_IsSatisfied', async () => {
    const evidence = memorySource([persistedGateEvidence(OPERATION)]);

    const observation = await observeActionPostconditions({
      ensures: declared({
        source: 'durable-evidence',
        when: 'success',
        evidenceType: 'gate',
      }),
      store: memorySource([]),
      evidence,
      streamId: STREAM,
      operationId: OPERATION,
    });

    expect(observation.status).toBe('satisfied');
    expect(observation.missing).toEqual([]);
  });

  it('Postconditions_ReplayedEvidenceWitness_DoesNotPass', async () => {
    const observation = await observeActionPostconditions({
      ensures: declared({
        source: 'durable-evidence',
        when: 'success',
        evidenceType: 'gate',
      }),
      store: memorySource([]),
      evidence: memorySource([]),
      streamId: STREAM,
      operationId: OPERATION,
      witnesses: [replayedEvidence('workflow.started', 'ledger fold of a prior run')],
    });

    expect(observation.status).toBe('violated');
    expect(observation.missing).toEqual([
      { source: 'durable-evidence', when: 'success', evidenceType: 'gate' },
    ]);
  });

  it('Postconditions_DeclarationWithoutObservation_DoesNotPass', async () => {
    const observation = await observeActionPostconditions({
      ensures: declared(
        { source: 'event-append', when: 'success', event: 'workflow.started' },
        { source: 'durable-evidence', when: 'success', evidenceType: 'gate' },
      ),
      store: memorySource([]),
      evidence: memorySource([]),
      streamId: STREAM,
      operationId: OPERATION,
    });

    expect(observation.status).toBe('violated');
    expect(observation.missing).toHaveLength(2);
  });

  it('Postconditions_FailureOutcome_ChecksFailureAndAlways', async () => {
    const ensures = declared<ActionPostcondition>(
      { source: 'event-append', when: 'success', event: 'workflow.started' },
      { source: 'event-append', when: 'failure', event: 'task.failed' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    );
    expect(applicableEnsures(ensures, 'failure').map((item) => item.when).sort()).toEqual([
      'always',
      'failure',
    ]);
    expect(applicableEnsures(ensures, 'success').map((item) => item.when).sort()).toEqual([
      'always',
      'success',
    ]);

    const observation = await observeActionPostconditions({
      ensures,
      store: memorySource([
        { type: 'task.failed', operationId: OPERATION },
        { type: 'gate.executed', operationId: OPERATION },
      ]),
      evidence: memorySource([]),
      streamId: STREAM,
      operationId: OPERATION,
      outcome: 'failure',
    });

    expect(observation.status).toBe('satisfied');
    expect(observation.missing).toEqual([]);
  });
});

const PROBE_TOOL = 'exarchos_ensure_probe';

function probeContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return {
    requires: none('probe has no admission obligations'),
    ensures: none('probe has no durable postcondition'),
    needs: none('probe declares no capabilities'),
    touches: {
      frame: 'single-machine',
      resources: declared({ kind: 'stream', selector: 'featureId' }),
    },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: none('probe emits no catalog events'),
    ...overrides,
  };
}

function registerProbe(input: {
  readonly action: string;
  readonly contract: ActionContract;
  readonly annotations?: typeof LOCAL_MUTATION | typeof READ_ONLY_LOCAL;
  readonly handler: (args: Record<string, unknown>) => Promise<unknown>;
}): void {
  registerCustomTool({
    name: PROBE_TOOL,
    description: 'Postcondition dispatch probe',
    actions: [
      withActionContract(
        {
          name: input.action,
          description: 'Postcondition dispatch probe action',
          schema: z.object({ featureId: z.string().min(1) }).passthrough(),
          phases: new Set<string>(),
          roles: new Set<string>(['any']),
          annotations: input.annotations ?? LOCAL_MUTATION,
          outputSchema: unregisteredActionOutputSchema(),
        },
        input.contract,
      ),
    ],
  });
  setCustomToolActionHandler(PROBE_TOOL, input.action, input.handler);
}

interface MemoryRow {
  readonly type: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly data?: unknown;
  readonly operationId?: string;
}

function memoryEventStore(): EventStore {
  const rows = new Map<string, MemoryRow[]>();
  const append = async (
    streamId: string,
    event: { type: string; data?: unknown; operationId?: string },
  ): Promise<WorkflowEvent> => {
    const dispatchCtx = getDispatchContext();
    const operationId = event.operationId ?? dispatchCtx?.operationId;
    const list = rows.get(streamId) ?? [];
    const stored: MemoryRow = {
      type: event.type,
      streamId,
      sequence: list.length + 1,
      ...(event.data !== undefined ? { data: event.data } : {}),
      ...(operationId !== undefined ? { operationId } : {}),
    };
    list.push(stored);
    rows.set(streamId, list);
    return stored as WorkflowEvent;
  };
  return {
    async initialize() {},
    async query(streamId: string, filters?: { type?: string; operationId?: string }) {
      return (rows.get(streamId) ?? []).filter((row) => {
        if (filters?.type !== undefined && row.type !== filters.type) return false;
        if (filters?.operationId !== undefined && row.operationId !== filters.operationId) {
          return false;
        }
        return true;
      }) as WorkflowEvent[];
    },
    async append(streamId: string, event: { type: string; data?: unknown }) {
      return append(streamId, event);
    },
    async appendValidated(streamId: string, event: WorkflowEvent) {
      return append(streamId, {
        type: event.type,
        ...(event.data !== undefined ? { data: event.data } : {}),
        ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
      });
    },
    listStreams() {
      return [...rows.keys()];
    },
  } as unknown as EventStore;
}

describe('dispatch gates success on applicable ensures', () => {
  let eventStore: EventStore;

  afterEach(() => {
    clearCustomTools();
  });

  function ctx(): DispatchContext {
    eventStore = memoryEventStore();
    return {
      stateDir: path.join(os.tmpdir(), 'ensure-dispatch-unused'),
      eventStore,
      enableTelemetry: false,
    };
  }

  it('Dispatch_MissingEnsure_BlocksSuccess', async () => {
    registerProbe({
      action: 'write',
      contract: probeContract({
        ensures: declared({
          source: 'event-append',
          when: 'success',
          event: 'workflow.started',
        }),
      }),
      handler: async () => ({ success: true, data: { wrote: true } }),
    });

    const result = await dispatch(
      PROBE_TOOL,
      { action: 'write', featureId: 'feat-missing-ensure' },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ENSURE_CONTRACT_VIOLATED');
    expect(result.data).toEqual({ wrote: true });
  });

  it('Dispatch_Failure_ChecksFailureAndAlways', async () => {
    const featureId = 'feat-failure-ensures';
    registerProbe({
      action: 'fail',
      contract: probeContract({
        ensures: declared(
          { source: 'event-append', when: 'success', event: 'workflow.started' },
          { source: 'event-append', when: 'failure', event: 'task.failed' },
          { source: 'event-append', when: 'always', event: 'gate.executed' },
        ),
      }),
      handler: async (args) => {
        const stream = String(args.featureId);
        await eventStore.append(stream, {
          type: 'task.failed',
          data: { taskId: 'task-probe', error: 'handler refused' },
        });
        await eventStore.append(stream, {
          type: 'gate.executed',
          data: { gateName: 'probe', layer: 'acceptance', passed: false },
        });
        return { success: false, error: { code: 'HANDLER_REFUSED', message: 'probe failed' } };
      },
    });

    const observed = await dispatch(
      PROBE_TOOL,
      { action: 'fail', featureId },
      ctx(),
    );
    expect(observed.success).toBe(false);
    expect(observed.error?.code).toBe('HANDLER_REFUSED');

    clearCustomTools();
    registerProbe({
      action: 'fail-bare',
      contract: probeContract({
        ensures: declared(
          { source: 'event-append', when: 'success', event: 'workflow.started' },
          { source: 'event-append', when: 'failure', event: 'task.failed' },
          { source: 'event-append', when: 'always', event: 'gate.executed' },
        ),
      }),
      handler: async (args) => {
        await eventStore.append(String(args.featureId), {
          type: 'workflow.started',
          data: { featureId, workflowType: 'feature' },
        });
        return { success: false, error: { code: 'HANDLER_REFUSED', message: 'probe failed' } };
      },
    });

    const missing = await dispatch(
      PROBE_TOOL,
      { action: 'fail-bare', featureId: 'feat-failure-bare' },
      ctx(),
    );
    expect(missing.success).toBe(false);
    expect(missing.error?.code).toBe('ENSURE_CONTRACT_VIOLATED');
  });

  it('Dispatch_HostOwned_DoesNotExecuteObligation', async () => {
    // `discover_bridge`, not `cutover_decide`. The claim under test is that a
    // BLOCKING host obligation short-circuits before the handler runs, so the
    // subject has to be an action that actually declares one:
    // `discover_bridge` is `executionAuthority: { kind: 'host', obligation:
    // 'human-approval' }`. `cutover_decide` is `kind: 'local'` — it gates on
    // operator posture INSIDE its handler and must keep running, because its
    // own `ensures` obliges it to append the rollout-decision fact. Short-
    // circuiting it would hand the caller an obligation where the recorded
    // decision belongs.
    let handlerCalls = 0;
    const restore = stubCompositeHandler('exarchos_orchestrate', async () => {
      handlerCalls += 1;
      return { success: true, data: { ran: true } };
    });
    try {
      const result = await dispatch(
        'exarchos_orchestrate',
        // `artifact` is required by the action's own schema, which is
        // validated BEFORE admission runs — without it the dispatch fails on
        // INVALID_INPUT and never reaches the obligation check this asserts.
        { action: 'discover_bridge', featureId: 'feat-host-owned', artifact: 'spec.md' },
        ctx(),
      );
      expect(result.success, result.error?.message).toBe(true);
      expect(result.data).toEqual({ obligation: 'human-approval' });
      expect(handlerCalls).toBe(0);
      expect(result.error?.code).not.toBe('ENSURE_CONTRACT_VIOLATED');
    } finally {
      restore();
    }
  });

  it('Dispatch_ReadOnlyAbstention_SkipsAppendCheck', async () => {
    registerProbe({
      action: 'peek',
      annotations: READ_ONLY_LOCAL,
      contract: probeContract({
        ensures: none('read-only probe returns an ephemeral document with no durable postcondition'),
        emissions: none('read-only probe emits no catalog events'),
        replay: { kind: 'safe-repeat' },
      }),
      handler: async () => ({ success: true, data: { peeked: true } }),
    });

    const result = await dispatch(
      PROBE_TOOL,
      { action: 'peek', featureId: 'feat-readonly-abstention' },
      ctx(),
    );

    expect(result.success, result.error?.message).toBe(true);
    expect(result.data).toEqual({ peeked: true });
    expect(result.error?.code).not.toBe('EMISSION_CONTRACT_VIOLATED');
    expect(result.error?.code).not.toBe('ENSURE_CONTRACT_VIOLATED');
    const rows = await eventStore.query('feat-readonly-abstention');
    expect(rows).toEqual([]);
  });
});
