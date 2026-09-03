import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { ContentAddressedStore } from '../../src/storage/artifacts/content-addressed-store.js';
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
import { EVIDENCE_ARTIFACT_DIRNAME } from '../../src/utils/paths.js';
import {
  evidenceArtifactResolver,
  evidenceArtifactStore,
  storeEvidenceArtifact,
} from '../../src/workflow/admission/evidence-artifact.js';
import { readPersistedEvidence } from '../../src/workflow/admission/evidence-reader.js';
import {
  ADMISSION_EVENT_TYPES,
  ArtifactIdSchema,
  type EvidenceArtifactReferenceV1,
} from '../../src/workflow/admission/types.js';

const STREAM = 'feature-postconditions';
const OPERATION = 'operation.postconditions-1';

/** Where a reference's blob would sit under a given evidence root — derived
 * from the digest the store itself returned, never re-typed. */
function blobPathFor(stateDir: string, reference: EvidenceArtifactReferenceV1): string {
  return path.join(
    stateDir,
    EVIDENCE_ARTIFACT_DIRNAME,
    reference.subject.digest.algorithm,
    reference.subject.digest.value.slice(0, 2),
    reference.subject.digest.value.slice(2),
  );
}
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

function persistedGateEvidence(
  operationId: string,
  options?: {
    readonly artifactRefs?: readonly unknown[];
    readonly subject?: Record<string, unknown>;
  },
): StoreRow {
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
        subject: options?.subject ?? { kind: 'task', taskId: 'task.1', digest: DIGEST },
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
        ...(options?.artifactRefs === undefined ? {} : { artifactRefs: options.artifactRefs }),
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

  it('Postconditions_RowWithoutArtifactRefs_SatisfiesWithNoResolver', async () => {
    // A row that names no blob is complete evidence on its own — omitting
    // `artifactResolver` entirely (no state directory in scope) must not
    // turn a reference-free row into a violation.
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

  it('Postconditions_ArtifactKindSubjectWithoutReference_IsSatisfied', async () => {
    // The fallback path that mints a `kind: 'artifact'` SUBJECT with no
    // persisted bytes at all (no taskId, no git HEAD) is a different fact
    // from a row that names an artifact REFERENCE. Custody keys on the
    // reference the row carries, never on the subject's kind.
    const evidence = memorySource([
      persistedGateEvidence(OPERATION, {
        subject: { kind: 'artifact', artifactId: 'gate-target:fallback', digest: DIGEST },
      }),
    ]);

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

describe('durable action postcondition observation — artifact-backed evidence', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'ensure-postconditions-artifact-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /** A real reference, persisted through the production store binding. */
  async function seedArtifactRow(): Promise<EvidenceArtifactReferenceV1> {
    return storeEvidenceArtifact(
      evidenceArtifactStore(stateDir),
      { kind: 'artifact', artifactId: ArtifactIdSchema.parse('gate-report.postconditions') },
      { verdict: 'pass' },
      { mediaType: 'application/json' },
    );
  }

  it('Postconditions_ArtifactBackedCorpus_IsNotEmpty', async () => {
    // Denominator for the three seeded violations below: without this, all
    // three could be passing vacuously because no row this file ever feeds
    // the resolver arm carries a reference at all.
    const reference = await seedArtifactRow();
    const evidence = memorySource([persistedGateEvidence(OPERATION, { artifactRefs: [reference] })]);

    const rowsWithRefs = (
      await readPersistedEvidence(evidence, {
        streamId: STREAM,
        operationId: OPERATION,
        evidenceType: 'gate',
      })
    ).filter((observed) => observed.artifactRefs.length > 0);

    expect(rowsWithRefs.length).toBeGreaterThan(0);
  });

  it('Postconditions_ArtifactBlobDeleted_IsViolation', async () => {
    const reference = await seedArtifactRow();
    await rm(blobPathFor(stateDir, reference));

    const evidence = memorySource([persistedGateEvidence(OPERATION, { artifactRefs: [reference] })]);
    const observation = await observeActionPostconditions({
      ensures: declared({ source: 'durable-evidence', when: 'success', evidenceType: 'gate' }),
      store: memorySource([]),
      evidence,
      streamId: STREAM,
      operationId: OPERATION,
      artifactResolver: evidenceArtifactResolver(stateDir),
    });

    expect(observation.status).toBe('violated');
    expect(observation.missing).toEqual([
      { source: 'durable-evidence', when: 'success', evidenceType: 'gate' },
    ]);
  });

  it('Postconditions_ArtifactBlobTampered_IsViolation', async () => {
    const reference = await seedArtifactRow();
    await writeFile(blobPathFor(stateDir, reference), '{"corrupted":true}', 'utf8');

    const evidence = memorySource([persistedGateEvidence(OPERATION, { artifactRefs: [reference] })]);
    const observation = await observeActionPostconditions({
      ensures: declared({ source: 'durable-evidence', when: 'success', evidenceType: 'gate' }),
      store: memorySource([]),
      evidence,
      streamId: STREAM,
      operationId: OPERATION,
      artifactResolver: evidenceArtifactResolver(stateDir),
    });

    expect(observation.status).toBe('violated');
    expect(observation.missing).toEqual([
      { source: 'durable-evidence', when: 'success', evidenceType: 'gate' },
    ]);
  });

  it('Postconditions_ArtifactBlobUnderAnotherRoot_IsViolation', async () => {
    // The oracle that would have caught the two-root split directly: the
    // blob is real, intact, and readable — just not under the root this
    // resolver was bound to.
    const otherDir = await mkdtemp(path.join(os.tmpdir(), 'ensure-postconditions-otherroot-'));
    try {
      const wrongRootStore = new ContentAddressedStore(path.join(otherDir, 'gate-evidence'));
      const reference = await storeEvidenceArtifact(
        wrongRootStore,
        { kind: 'artifact', artifactId: ArtifactIdSchema.parse('gate-report.wrong-root') },
        { verdict: 'pass' },
        { mediaType: 'application/json' },
      );

      const evidence = memorySource([persistedGateEvidence(OPERATION, { artifactRefs: [reference] })]);
      const observation = await observeActionPostconditions({
        ensures: declared({ source: 'durable-evidence', when: 'success', evidenceType: 'gate' }),
        store: memorySource([]),
        evidence,
        streamId: STREAM,
        operationId: OPERATION,
        artifactResolver: evidenceArtifactResolver(stateDir),
      });

      expect(observation.status).toBe('violated');
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
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

  function ctx(stateDirOverride?: string): DispatchContext {
    eventStore = memoryEventStore();
    return {
      // Most probes here never touch a state directory, so the placeholder
      // is deliberately non-existent. The artifact-backed cases below pass a
      // real `mkdtemp` directory instead — their handler binds an evidence
      // store to it, and the resolver has to find a real filesystem there.
      stateDir: stateDirOverride ?? path.join(os.tmpdir(), 'ensure-dispatch-unused'),
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

  it('Dispatch_UnresolvableArtifactEvidence_BlocksSuccess', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'ensure-dispatch-artifact-'));
    try {
      registerProbe({
        action: 'record-then-lose',
        contract: probeContract({
          ensures: declared({ source: 'durable-evidence', when: 'success', evidenceType: 'gate' }),
        }),
        handler: async (args) => {
          const streamId = String(args.featureId);
          const reference = await storeEvidenceArtifact(
            evidenceArtifactStore(stateDir),
            { kind: 'artifact', artifactId: ArtifactIdSchema.parse('probe-report.lost') },
            { verdict: 'pass' },
            { mediaType: 'application/json' },
          );
          await eventStore.append(streamId, {
            type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
            data: persistedGateEvidence('unused', { artifactRefs: [reference] }).data as Record<string, unknown>,
          });
          // The row committed with the reference on it; the blob it names
          // disappears before observation runs.
          await rm(blobPathFor(stateDir, reference));
          return { success: true, data: { recorded: true } };
        },
      });

      const result = await dispatch(
        PROBE_TOOL,
        { action: 'record-then-lose', featureId: 'feat-artifact-lost' },
        ctx(stateDir),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ENSURE_CONTRACT_VIOLATED');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('Dispatch_ResolvableArtifactEvidence_Succeeds', async () => {
    // The two-sided pair: the same shape as the case above, with the blob
    // left in place, so the first case's failure is proved to trace to the
    // missing blob rather than to something else about the fixture.
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'ensure-dispatch-artifact-ok-'));
    try {
      registerProbe({
        action: 'record-and-keep',
        contract: probeContract({
          ensures: declared({ source: 'durable-evidence', when: 'success', evidenceType: 'gate' }),
        }),
        handler: async (args) => {
          const streamId = String(args.featureId);
          const reference = await storeEvidenceArtifact(
            evidenceArtifactStore(stateDir),
            { kind: 'artifact', artifactId: ArtifactIdSchema.parse('probe-report.kept') },
            { verdict: 'pass' },
            { mediaType: 'application/json' },
          );
          await eventStore.append(streamId, {
            type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
            data: persistedGateEvidence('unused', { artifactRefs: [reference] }).data as Record<string, unknown>,
          });
          return { success: true, data: { recorded: true } };
        },
      });

      const result = await dispatch(
        PROBE_TOOL,
        { action: 'record-and-keep', featureId: 'feat-artifact-kept' },
        ctx(stateDir),
      );

      expect(result.success, result.error?.message).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
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
