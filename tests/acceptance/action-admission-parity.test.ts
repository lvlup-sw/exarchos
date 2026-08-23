import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventStore } from '../../src/events/store.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import {
  dispatch,
  stubCompositeHandler,
  type DispatchContext,
} from '../../src/dispatch/core/dispatch.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { POLICY_CAPABILITY } from '../../src/workflow/admission/policy-authority.js';
import {
  computeNextActions,
  computeRegistryAdvertisements,
} from '../../src/next-actions-computer.js';
import { getHSMDefinition } from '../../src/workflow/state-machine.js';
import { nextActionsFromResult } from '../../src/next-actions-from-result.js';
import { ADMISSION_EVENT_TYPES } from '../../src/workflow/admission/types.js';
import { handleInit } from '../../src/workflow/handlers/init.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

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
    const list = rows.get(streamId) ?? [];
    const stored: MemoryRow = {
      type: event.type,
      streamId,
      sequence: list.length + 1,
      ...(event.data !== undefined ? { data: event.data } : {}),
      ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
    };
    list.push(stored);
    rows.set(streamId, list);
    return stored as WorkflowEvent;
  };
  return {
    async initialize() {},
    async query(streamId: string, filters?: { type?: string }) {
      return (rows.get(streamId) ?? []).filter(
        (row) => filters?.type === undefined || row.type === filters.type,
      ) as WorkflowEvent[];
    },
    async append(streamId: string, event: { type: string; data?: unknown }) {
      return append(streamId, event);
    },
    async appendValidated(streamId: string, event: WorkflowEvent) {
      return append(streamId, event);
    },
    listStreams() {
      return [...rows.keys()];
    },
  } as unknown as EventStore;
}

const GET_ACTION_ID = 'exarchos_workflow.get';
const REQUIRES_ACTION_ID = 'exarchos_orchestrate.check_invariant_conformance';
const SHA256 = 'a'.repeat(64);
const AT = '2026-08-22T00:00:00.000Z';

function advertiseAuth(capabilityIds: readonly string[]) {
  return {
    authorizationId: 'authorization-parity-001',
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
      taskId: 'task-parity-001',
      digest: { algorithm: 'sha256' as const, value: SHA256 },
    },
    producer: {
      producerId: 'producer.gate-runner',
      providerRef: 'provider.review',
      providerVersion: '1.0.0',
      invocationId: `invocation-${input.evidenceId}`,
    },
    policyId: 'policy-parity-001',
    policyDigest: { algorithm: 'sha256' as const, value: SHA256 },
    contentDigest: { algorithm: 'sha256' as const, value: SHA256 },
    createdAt: input.createdAt ?? new Date().toISOString(),
    kind: 'gate' as const,
    verdict: input.verdict,
  };
}

describe('action admission dispatch parity', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admission-parity-'));
    eventStore = memoryEventStore();
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  function ctx(capabilityIds: readonly string[] = allowingCapabilities()): DispatchContext {
    return {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      callerIdentity: deriveMcpCallerIdentity({ sessionId: 'admission-parity' }),
      capabilityResolver: createInMemoryResolver(capabilityIds),
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
      null,
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

  it('Dispatch_UnchangedWorkflowSubject_IsNotAdmissionDenied', async () => {
    const featureId = 'feat-unchanged';
    await initFeature(featureId);

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
    expect(result.error?.code).not.toBe('ADMISSION_DENIED');
    expect(result.success, result.error?.message).toBe(true);
  });

  it('Dispatch_ChangedEvidence_FailsBeforeHandler', async () => {
    const featureId = 'feat-changed-evidence';
    const phaseAttemptId = await initFeature(featureId);
    expect(phaseAttemptId).toEqual(expect.any(String));
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
      expect(handlerCalls).toBe(1);
    } finally {
      restore();
    }
  });

  it('Dispatch_Denied_FailsBeforeEffects', async () => {
    const featureId = 'feat-denied';
    await initFeature(featureId);
    const eventsBefore = await eventStore.query(featureId);

    let handlerCalls = 0;
    const restore = stubCompositeHandler('exarchos_orchestrate', async () => {
      handlerCalls += 1;
      await eventStore.append(featureId, {
        type: 'gate.executed',
        source: 'test',
        data: { gate: 'review', passed: true, featureId },
      });
      return { success: true, data: { ran: true } };
    });
    try {
      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'check_invariant_conformance', featureId },
        ctx(['mcp:exarchos']),
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ADMISSION_DENIED');
      expect(handlerCalls).toBe(0);
      const eventsAfter = await eventStore.query(featureId);
      expect(eventsAfter).toHaveLength(eventsBefore.length);
    } finally {
      restore();
    }
  });

  it('Dispatch_Transition_StillUsesHsmGuard', async () => {
    const featureId = 'feat-hsm-guard';
    await initFeature(featureId);

    const invalid = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'not-a-phase' },
      ctx(),
    );
    expect(invalid.success).toBe(false);
    expect(invalid.error?.code).not.toBe('ADMISSION_DENIED');
    expect(invalid.error?.code).toBe('INVALID_TRANSITION');

    const guarded = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    expect(guarded.success).toBe(false);
    expect(guarded.error?.code).not.toBe('ADMISSION_DENIED');
    expect(guarded.error?.code).toBe('GUARD_FAILED');
  });

  it('Dispatch_PhaseVerbThenTransition_IsNotAdmissionDenied', async () => {
    const featureId = 'feat-phase-verb';
    await initFeature(featureId);
    const status = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId },
      ctx(),
    );
    expect(status.success, status.error?.message).toBe(true);
    const control = [
      ...(status.next_actions ?? []),
      ...nextActionsFromResult(status),
      ...computeNextActions(
        { phase: 'plan', workflowType: 'feature', featureId },
        getHSMDefinition('feature'),
      ),
    ];
    const phaseVerb = control.find((action) => action.verb === 'plan-review');
    expect(phaseVerb).toBeDefined();
    expect(phaseVerb).not.toHaveProperty('actionId');

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    expect(result.error?.code).not.toBe('ADMISSION_DENIED');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
  });

  it('Dispatch_HostOwned_ReturnsObligationWithoutExecuting', async () => {
    let handlerCalls = 0;
    const restore = stubCompositeHandler('exarchos_orchestrate', async () => {
      handlerCalls += 1;
      return { success: true, data: { ran: true } };
    });
    try {
      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'check_coderabbit',
          owner: 'acme',
          repo: 'widgets',
          prNumbers: [1],
        },
        ctx(),
      );
      expect(result.success, result.error?.message).toBe(true);
      expect(result.data).toEqual({ obligation: 'interactive-authentication' });
      expect(handlerCalls).toBe(0);
      expect(result).not.toHaveProperty('actionId');
      expect(
        (result.data as { capabilityIds?: unknown }).capabilityIds,
      ).toBeUndefined();
    } finally {
      restore();
    }
  });
});
