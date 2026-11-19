/**
 * The no-op reply of a handler at the emission verifier.
 *
 * A successful reply with `idempotent: true` did no work, so it owes no `always` emission. A
 * successful reply without that field still owes its row. A refused reply stays refused, also when
 * it carries the field. Each assertion binds one side to a literal reason or boolean.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import {
  isHandlerNoOpReply,
  runEmissionVerifierInterceptor,
  type EmissionVerifierCall,
} from '../../../../src/dispatch/core/interceptors/emission-verifier.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STREAM = 'feature-handler-no-op';

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'handler-no-op-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

/** The store holds a live SQLite connection, so it closes before the removal of its directory. */
afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

/** One transition call that declares `workflow.transition` with `condition: 'always'`. */
function transitionCall(operationId: string, reply: unknown, handlerSucceeded: boolean): EmissionVerifierCall {
  return {
    tool: 'exarchos_workflow',
    action: 'transition',
    operationId,
    streamId: STREAM,
    declared: [{ event: 'workflow.transition', condition: 'always' }],
    handlerSucceeded,
    reply,
  };
}

/** The count of `emission.violated` rows of the stream. */
async function violationRows(): Promise<number> {
  return (await store.query(STREAM, { type: 'emission.violated' })).length;
}

describe('EmissionVerifier handler no-op reply', () => {
  /** The handler appended no row and said so. The verifier reads no store and records no finding. */
  it('EmissionVerifier_AnIdempotentNoOpReply_IsNotApplicable', async () => {
    const verdict = await runEmissionVerifierInterceptor(
      store,
      transitionCall('op-no-op', { phase: 'plan', idempotent: true }, true),
    );

    expect(verdict.status).toBe('not-applicable');
    expect(verdict.reason).toBe('handler-no-op');
    expect(verdict.missingEvents).toEqual([]);
    expect(await violationRows()).toBe(0);
  });

  /** A real move replies with no `idempotent` field. With no row on the operation, it stays a violation. */
  it('EmissionVerifier_ASuccessfulReplyWithoutIdempotent_StaysViolated', async () => {
    const verdict = await runEmissionVerifierInterceptor(
      store,
      transitionCall('op-real-move', { phase: 'plan-review' }, true),
    );

    expect(verdict.status).toBe('violated');
    expect(verdict.reason).toBeUndefined();
    expect(verdict.missingEvents).toEqual(['workflow.transition']);
    expect(await violationRows()).toBe(1);
  });

  /** The refusal check runs before the no-op check, so a refused reply keeps the reason `handler-refused`. */
  it('EmissionVerifier_ARefusedReplyWithIdempotent_StaysHandlerRefused', async () => {
    const verdict = await runEmissionVerifierInterceptor(
      store,
      transitionCall('op-refused', { phase: 'plan', idempotent: true }, false),
    );

    expect(verdict.status).toBe('not-applicable');
    expect(verdict.reason).toBe('handler-refused');
    expect(await violationRows()).toBe(0);
  });

  /** Only the boolean `true` in an object reply is a no-op. A string, a missing field and a non-object reply are not. */
  it.each([
    { row: 'the boolean true', reply: { phase: 'plan', idempotent: true }, expected: true },
    { row: 'the boolean false', reply: { phase: 'plan', idempotent: false }, expected: false },
    { row: "the string 'true'", reply: { phase: 'plan', idempotent: 'true' }, expected: false },
    { row: 'a missing field', reply: { phase: 'plan' }, expected: false },
    { row: 'a non-object reply', reply: 'idempotent', expected: false },
  ])('IsHandlerNoOpReply_OnlyTheBooleanTrue_IsANoOp ($row)', ({ reply, expected }) => {
    expect(isHandlerNoOpReply(reply)).toBe(expected);
  });
});
