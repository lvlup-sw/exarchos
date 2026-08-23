import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import {
  actionContractRequiresIsNone,
  classifyActionContractExecute,
  liveActionContractSubject,
  type ActionContractExecuteKind,
} from '../../src/contract/action-contract-closure.js';
import {
  applicableEnsures,
  observeActionPostconditions,
} from '../../src/dispatch/core/action-postconditions.js';
import {
  dispatch,
  stubCompositeHandler,
  type DispatchContext,
} from '../../src/dispatch/core/dispatch.js';
import { replayedEvidence } from '../../src/dispatch/core/effect-carrier.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { getDispatchContext } from '../../src/dispatch/dispatch-context.js';
import type { EventStore } from '../../src/events/store.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import { unregisteredActionOutputSchema } from '../../src/output-schema-declaration.js';
import {
  computeRegistryAdvertisements,
} from '../../src/next-actions-computer.js';
import {
  clearCustomTools,
  registerCustomTool,
  setCustomToolActionHandler,
} from '../../src/registry.js';
import {
  declared,
  none,
  withActionContract,
  type ActionContract,
  type ActionPostcondition,
} from '../../src/registry/action-contract.js';
import { LOCAL_MUTATION } from '../../src/registry/annotations.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { POLICY_CAPABILITY } from '../../src/workflow/admission/policy-authority.js';
import { ADMISSION_EVENT_TYPES } from '../../src/workflow/admission/types.js';
import { handleInit } from '../../src/workflow/handlers/init.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

interface MemoryRow {
  readonly type: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly data?: unknown;
  readonly operationId?: string | undefined;
}

function memoryEventStore(): EventStore {
  const rows = new Map<string, MemoryRow[]>();
  const append = async (
    streamId: string,
    event: { type: string; data?: unknown; operationId?: string | undefined },
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
    async query(streamId: string, filters?: { type?: string; operationId?: string | undefined }) {
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

const GET_ACTION_ID = 'exarchos_workflow.get';
const REQUIRES_ACTION_ID = 'exarchos_orchestrate.check_invariant_conformance';
const TRANSITION_ACTION_ID = 'exarchos_workflow.transition';
const SHA256 = 'a'.repeat(64);
const AT = '2026-08-22T00:00:00.000Z';
const PROBE_TOOL = 'exarchos_ensure_probe';

function advertiseAuth(capabilityIds: readonly string[]) {
  return {
    authorizationId: 'authorization-closure-001',
    posture: 'shared-mutating' as const,
    capabilityIds,
    resolverVersion: '1.0',
    resolvedAt: AT,
  };
}

function allowingCapabilities(): readonly string[] {
  return [
    'mcp:exarchos',
    'fs:read',
    'fs:write',
    'shell:exec',
    POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE,
  ];
}

function executeKind(result: {
  readonly success: boolean;
  readonly error?: { readonly code?: string };
}): ActionContractExecuteKind {
  return classifyActionContractExecute({
    success: result.success,
    ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
  });
}

function gateEvidence(input: {
  readonly evidenceId: string;
  readonly verdict: 'pass' | 'fail';
  readonly phaseAttemptId: string;
  readonly createdAt?: string;
}) {
  return {
    contractVersion: '1.0' as const,
    evidenceId: input.evidenceId,
    requirementId: 'review',
    phaseAttemptId: input.phaseAttemptId,
    subject: {
      kind: 'task' as const,
      taskId: 'task-closure-001',
      digest: { algorithm: 'sha256' as const, value: SHA256 },
    },
    producer: {
      producerId: 'producer.gate-runner',
      providerRef: 'provider.review',
      providerVersion: '1.0.0',
      invocationId: `invocation-${input.evidenceId}`,
    },
    policyId: 'policy-closure-001',
    policyDigest: { algorithm: 'sha256' as const, value: SHA256 },
    contentDigest: { algorithm: 'sha256' as const, value: SHA256 },
    createdAt: input.createdAt ?? new Date().toISOString(),
    kind: 'gate' as const,
    verdict: input.verdict,
  };
}

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

function registerEnsureProbe(input: {
  readonly action: string;
  readonly contract: ActionContract;
  readonly handler: (args: Record<string, unknown>) => Promise<unknown>;
}): void {
  registerCustomTool({
    name: PROBE_TOOL,
    description: 'Ensure-closure dispatch probe',
    actions: [
      withActionContract(
        {
          name: input.action,
          description: 'Ensure-closure dispatch probe action',
          schema: z.object({ featureId: z.string().min(1) }).passthrough(),
          phases: new Set<string>(),
          roles: new Set<string>(['any']),
          annotations: LOCAL_MUTATION,
          outputSchema: unregisteredActionOutputSchema(),
        },
        input.contract,
      ),
    ],
  });
  setCustomToolActionHandler(PROBE_TOOL, input.action, input.handler);
}

describe('action-contract advertise / execute / ensure / HSM closure', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'action-contract-closure-'));
    eventStore = memoryEventStore();
  });

  afterEach(async () => {
    clearCustomTools();
    await rmrfAsync(tmpDir);
  });

  function ctx(capabilityIds: readonly string[] = allowingCapabilities()): DispatchContext {
    return {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      callerIdentity: deriveMcpCallerIdentity({ sessionId: 'action-contract-closure' }),
      capabilityResolver: createInMemoryResolver(capabilityIds),
    };
  }

  function probeCtx(): DispatchContext {
    return {
      stateDir: path.join(os.tmpdir(), 'ensure-closure-unused'),
      eventStore,
      enableTelemetry: false,
    };
  }

  async function readState(featureId: string): Promise<Record<string, unknown>> {
    const statePath = path.join(tmpDir, `${featureId}.state.json`);
    return JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>;
  }

  async function initFeature(featureId: string): Promise<string | undefined> {
    const result = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(result.success, result.error?.message).toBe(true);
    const state = await readState(featureId);
    delete state._esVersion;
    await fs.writeFile(
      path.join(tmpDir, `${featureId}.state.json`),
      JSON.stringify(state, null, 2),
    );
    return typeof state.phaseAttemptId === 'string' ? state.phaseAttemptId : undefined;
  }

  async function appendGateEvidence(
    featureId: string,
    evidence: ReturnType<typeof gateEvidence>,
  ): Promise<void> {
    await eventStore.append(featureId, {
      type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
      source: 'test',
      data: {
        eventVersion: '1.0',
        evidence,
      },
    });
  }

  it('ActionContract_Advertised_DispatchesOnUnchangedTrustedState', async () => {
    const featureId = 'feat-advertised-unchanged';
    await initFeature(featureId);
    expect(liveActionContractSubject(GET_ACTION_ID)).toBeDefined();

    const advertised = computeRegistryAdvertisements({
      phase: 'plan',
      workflowType: 'feature',
      featureId,
      actionAdmission: {
        subject: { featureId, stream: featureId },
        evidence: [],
        authorization: advertiseAuth(allowingCapabilities()),
        hsmFacts: { phase: 'plan' },
        actionIds: [GET_ACTION_ID],
      },
    });
    expect(advertised.map((item) => item.actionId)).toContain(GET_ACTION_ID);

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId },
      ctx(),
    );
    expect(executeKind(result)).not.toBe('admission-denied');
    expect(result.error?.code).not.toBe('ADMISSION_DENIED');
    expect(result.success, result.error?.message).toBe(true);
    expect(executeKind(result)).toBe('admitted');
  });

  it('ActionContract_ChangedEvidence_FailsBeforeHandler', async () => {
    const featureId = 'feat-changed-evidence';
    const phaseAttemptId = await initFeature(featureId);
    expect(phaseAttemptId).toEqual(expect.any(String));
    expect(liveActionContractSubject(REQUIRES_ACTION_ID)).toBeDefined();

    const passing = gateEvidence({
      evidenceId: 'evidence-pass-001',
      verdict: 'pass',
      phaseAttemptId: phaseAttemptId!,
    });
    await appendGateEvidence(featureId, passing);

    const advertised = computeRegistryAdvertisements({
      phase: 'review',
      workflowType: 'feature',
      featureId,
      actionAdmission: {
        subject: { featureId, stream: featureId },
        evidence: [passing],
        authorization: advertiseAuth(allowingCapabilities()),
        hsmFacts: { phase: 'review' },
        actionIds: [REQUIRES_ACTION_ID],
      },
    });
    expect(advertised.map((item) => item.actionId)).toContain(REQUIRES_ACTION_ID);

    let handlerCalls = 0;
    const restore = stubCompositeHandler('exarchos_orchestrate', async () => {
      handlerCalls += 1;
      return { success: true, data: { ran: true } };
    });
    try {
      const allowed = await dispatch(
        'exarchos_orchestrate',
        { action: 'check_invariant_conformance', featureId },
        ctx(),
      );
      expect(executeKind(allowed)).not.toBe('admission-denied');
      expect(allowed.error?.code).not.toBe('ADMISSION_DENIED');
      expect(allowed.success, allowed.error?.message).toBe(true);
      expect(handlerCalls).toBe(1);

      await appendGateEvidence(
        featureId,
        gateEvidence({
          evidenceId: 'evidence-fail-001',
          verdict: 'fail',
          phaseAttemptId: phaseAttemptId!,
        }),
      );

      const denied = await dispatch(
        'exarchos_orchestrate',
        { action: 'check_invariant_conformance', featureId },
        ctx(),
      );
      expect(denied.success).toBe(false);
      expect(denied.error?.code).toBe('ADMISSION_DENIED');
      expect(executeKind(denied)).toBe('admission-denied');
      expect(handlerCalls).toBe(1);
    } finally {
      restore();
    }
  });

  it('ActionContract_MissingEnsure_BlocksSuccess', async () => {
    const featureId = 'feat-missing-ensure';
    const ensures = declared<ActionPostcondition>({
      source: 'event-append',
      when: 'success',
      event: 'workflow.started',
    });
    registerEnsureProbe({
      action: 'write',
      contract: probeContract({ ensures }),
      handler: async () => ({ success: true, data: { wrote: true } }),
    });

    const result = await dispatch(
      PROBE_TOOL,
      { action: 'write', featureId },
      probeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ENSURE_CONTRACT_VIOLATED');
    expect(executeKind(result)).toBe('ensure-violated');
    expect(result.data).toEqual({ wrote: true });

    const observation = await observeActionPostconditions({
      ensures,
      store: eventStore,
      evidence: eventStore,
      streamId: featureId,
      operationId: 'operation.replayed-witness',
      witnesses: [replayedEvidence('workflow.started', 'ledger fold of a prior run')],
    });
    expect(applicableEnsures(ensures, 'success')).toHaveLength(1);
    expect(observation.status).toBe('violated');
    expect(observation.missing).toEqual([
      { source: 'event-append', when: 'success', event: 'workflow.started' },
    ]);
  });

  it('ActionContract_Hsm_RemainsAuthoritative', async () => {
    const featureId = 'feat-hsm-guard';
    await initFeature(featureId);

    const transition = liveActionContractSubject(TRANSITION_ACTION_ID);
    expect(transition, 'live tree names workflow.transition').toBeDefined();
    expect(actionContractRequiresIsNone(transition?.contract)).toBe(true);

    const invalid = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'not-a-phase' },
      ctx(),
    );
    expect(invalid.success).toBe(false);
    expect(executeKind(invalid)).toBe('hsm-deny');
    expect(executeKind(invalid)).not.toBe('admission-denied');
    expect(invalid.error?.code).not.toBe('ADMISSION_DENIED');
    expect(invalid.error?.code).toBe('INVALID_TRANSITION');

    const guarded = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    expect(guarded.success).toBe(false);
    expect(executeKind(guarded)).toBe('hsm-deny');
    expect(executeKind(guarded)).not.toBe('admission-denied');
    expect(guarded.error?.code).not.toBe('ADMISSION_DENIED');
    expect(guarded.error?.code).toBe('GUARD_FAILED');
  });
});
