import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createInMemoryResolver } from '../../../src/workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../src/dispatch/dispatch-context.js';
import { dispatch } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import { buildValidatedEvent } from '../../../src/events/event-factory.js';
import { INTERNAL_ADMISSION_EVENT_TYPES } from '../../../src/events/schemas.js';
import {
  AdmissionDisagreementDispositionActionSchema,
  handleAdmissionDisagreementDisposition,
} from '../../../src/events/tools.js';

const STREAM = 'phase-gate-v212-proof-substrate';
const FIXED_TIME = '2026-07-21T21:00:00.000Z';

function callerContext(eventStore: EventStore, readonly = false) {
  return {
    stateDir: eventStore.dir,
    eventStore,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'admission-test-session' }),
    capabilityResolver: createInMemoryResolver(
      readonly
        ? ['fs:read', 'mcp:exarchos:readonly']
        : ['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos'],
    ),
  };
}

function dispositionInput() {
  return {
    stream: STREAM,
    dispositionId: 'disposition-011',
    shadowAttemptId: 'shadow-attempt-011',
    disposition: 'explained-admission' as const,
    rationale: 'The admission record used durable gate evidence.',
  };
}

describe('reserved admission event authorization (DR-3)', () => {
  let eventStore: EventStore;
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'exarchos-admission-auth-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    eventStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('AdmissionEventAppend_UntrustedCaller_IsRejected', async () => {
    const result = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: STREAM,
        event: {
          type: 'admission.disagreement-disposition',
          data: {
            ...dispositionInput(),
            caller: {
              principalKind: 'operator',
              principalId: 'forged',
              role: 'release-authority',
            },
          },
        },
      },
      callerContext(eventStore),
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'RESERVED_EVENT_TYPE',
        eventType: 'admission.disagreement-disposition',
        registeredHandler: 'handleAdmissionDisagreementDisposition',
      },
    });
    expect(await eventStore.query(STREAM)).toEqual([]);
  });

  it('AdmissionEventAppend_AllReservedTypesRemainServerOwned', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...INTERNAL_ADMISSION_EVENT_TYPES),
        fc.record({
          principalId: fc.string({ minLength: 1, maxLength: 32 }),
          role: fc.string({ minLength: 1, maxLength: 32 }),
          operationId: fc.uuid(),
          // `noInvalidDate` matters: bare `fc.date()` can emit an Invalid Date
          // (~1 seed in 400), and `new Date(NaN).toISOString()` throws
          // RangeError inside the mapper during *generation* — crashing the
          // run before the property body is ever reached. That surfaced as a
          // seed-dependent flake, not a real counterexample. The property is
          // about forged caller attribution on reserved event types; an
          // unrepresentable timestamp is out of scope for it.
          recordedAt: fc.date({ noInvalidDate: true }).map((date) => date.toISOString()),
        }),
        async (eventType, forged) => {
          const result = await dispatch(
            'exarchos_event',
            {
              action: 'append',
              stream: STREAM,
              event: {
                type: eventType,
                data: {
                  caller: {
                    principalKind: 'operator',
                    principalId: forged.principalId,
                    role: forged.role,
                  },
                  authorization: { posture: 'shared-mutating' },
                  operationId: forged.operationId,
                  recordedAt: forged.recordedAt,
                },
              },
            },
            callerContext(eventStore),
          );

          expect(result).toMatchObject({
            success: false,
            error: { code: 'RESERVED_EVENT_TYPE', eventType },
          });
        },
      ),
      { numRuns: 33 },
    );
    expect(await eventStore.query(STREAM)).toEqual([]);
  });

  it('AdmissionEventBatchAppend_ReservedMemberRejectsWholeBatch', async () => {
    const result = await dispatch(
      'exarchos_event',
      {
        action: 'batch_append',
        stream: STREAM,
        events: [
          { type: 'task.progressed', data: { taskId: '011', tddPhase: 'red' } },
          { type: 'admission.enforcement-enabled', data: {} },
        ],
      },
      callerContext(eventStore),
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'RESERVED_EVENT_TYPE',
        eventType: 'admission.enforcement-enabled',
        batchIndex: 1,
      },
    });
    expect(await eventStore.query(STREAM)).toEqual([]);
  });

  it('AdmissionTypedAppend_UntrustedProvenanceOverride_IsRejected', async () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'caller',
          'authorization',
          'operationId',
          'recordedAt',
        ),
        fc.jsonValue(),
        (field, value) => {
          const parsed = AdmissionDisagreementDispositionActionSchema.safeParse({
            ...dispositionInput(),
            [field]: value,
          });

          expect(parsed.success).toBe(false);
          if (!parsed.success) {
            expect(z.treeifyError(parsed.error).errors.join(' ')).toContain(
              'Unrecognized key',
            );
          }
        },
      ),
    );
  });

  it('AdmissionTypedAppend_AuthorizedContextStampsTrustedProvenance', async () => {
    const context = callerContext(eventStore);
    const authorization = snapshotCallerAuthorization(
      context.callerIdentity,
      context.capabilityResolver,
      () => FIXED_TIME,
    );
    const dispatchContext = mintDispatchContext(undefined, authorization);

    const result = await runWithDispatchContext(dispatchContext, () =>
      handleAdmissionDisagreementDisposition(dispositionInput(), eventStore),
    );

    expect(result.success).toBe(true);
    const persisted =
      eventStore.getAppender().getSqliteBackend()!.queryEvents(STREAM).at(-1);
    expect(persisted).toMatchObject({
      type: 'admission.disagreement-disposition',
      operationId: dispatchContext.operationId,
      timestamp: FIXED_TIME,
      data: {
        recordedAt: FIXED_TIME,
        caller: {
          principalKind: 'agent',
          principalId: authorization.identity.subjectId,
          role: 'agent',
        },
        authorization: {
          posture: 'task-isolated',
          capabilityIds: authorization.capabilities,
          resolvedAt: FIXED_TIME,
        },
      },
    });
    expect(JSON.stringify(persisted)).not.toContain('forged');
  });

  it('AdmissionTypedAppend_ReadOnlyContextIsDenied', async () => {
    const context = callerContext(eventStore, true);
    const authorization = snapshotCallerAuthorization(
      context.callerIdentity,
      context.capabilityResolver,
      () => FIXED_TIME,
    );

    const result = await runWithDispatchContext(
      mintDispatchContext(undefined, authorization),
      () => handleAdmissionDisagreementDisposition(dispositionInput(), eventStore),
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'CAPABILITY_DENIED',
        action: 'handleAdmissionDisagreementDisposition',
      },
    });
    expect(await eventStore.query(STREAM)).toEqual([]);
  });

  it('AdmissionHistoricalReplay_InternalStoreStillConsumesReservedEvents', async () => {
    const historicalEvent = buildValidatedEvent(STREAM, 1, {
      type: 'admission.disagreement-disposition',
      timestamp: FIXED_TIME,
      data: {
        eventVersion: '1.0',
        dispositionId: 'historical-disposition',
        shadowAttemptId: 'historical-shadow-attempt',
        disposition: 'explained-legacy',
        rationale: 'Imported historical proof.',
        recordedAt: FIXED_TIME,
        caller: {
          principalKind: 'operator',
          principalId: 'historical-operator',
          role: 'operator',
        },
        authorization: {
          authorizationId: 'historical-authorization',
          posture: 'shared-mutating',
          capabilityIds: ['fs:write'],
          resolverVersion: '1',
          resolvedAt: FIXED_TIME,
        },
      },
    });
    await eventStore.appendValidated(STREAM, historicalEvent);

    const persisted =
      eventStore.getAppender().getSqliteBackend()!.queryEvents(STREAM).at(-1);
    expect(persisted?.type).toBe('admission.disagreement-disposition');
  });
});
