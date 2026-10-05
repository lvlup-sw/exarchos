// The Tasks-store seam for the v2 MCP SDK.
//
// The v2 SDK has no server-side Tasks runtime. A v2 `McpServer` answers each `tasks/*` method
// with `-32601`, and it ignores a `taskStore` option with no error. Thus the guarantee of
// `EventSourcedTaskStore` has two halves:
//
//   - Persistence. The `EventStore` holds the task state, so it survives the v2 migration.
//   - Wire. The v1 SDK served `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel` from
//     the injected store. The v2 SDK serves none of them.
//
// A naive migration gives a server that persists tasks and serves no Tasks method. The first test
// proves that persistence survives, and that the gap that `attach.ts` declares matches a live v2
// server. The second test compares `isTaskTerminal` with the recorded verdicts of the v1 `isTerminal`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { EventSourcedTaskStore } from '../../../../src/projections/task-store/event-sourced-task-store.js';
import {
  SDK_TASK_WIRE_METHODS,
  attachTaskStoreToV1,
  attachTaskStoreToV2,
  describeTaskWireGap,
} from '../../../../src/projections/task-store/attach.js';
import { TERMINAL_TASK_STATUSES, isTaskTerminal } from '../../../../src/projections/task-store/port.js';
import {
  V2_TASK_STATUS_VALUES,
  connectV2Server,
  createV2LinkedTransportPair,
  createV2McpServer,
} from '../../../../src/contract/sdk/seam.js';

/** JSON-RPC "Method not found". */
const METHOD_NOT_FOUND = -32601;

const SAMPLE_REQUEST = { method: 'tools/call', params: { name: 'noop', arguments: {} } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(message: unknown): number | undefined {
  if (!isRecord(message)) return undefined;
  const id = message['id'];
  return typeof id === 'number' ? id : undefined;
}

function errorCodeOf(message: unknown): number | undefined {
  if (!isRecord(message)) return undefined;
  const error = message['error'];
  if (!isRecord(error)) return undefined;
  const code = error['code'];
  return typeof code === 'number' ? code : undefined;
}

function resultOf(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) return undefined;
  const result = message['result'];
  return isRecord(result) ? result : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the response frame with `id`. It polls the inbox, so it does not depend on one fixed sleep. */
async function awaitResponse(inbox: readonly unknown[], id: number): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const hit = inbox.find((message) => idOf(message) === id);
    if (hit !== undefined) return hit;
    await sleep(10);
  }
  throw new Error(`no JSON-RPC response for id ${id} after 2s`);
}

/**
 * Sends a raw JSON-RPC request and resolves with its response frame. The tests read the error
 * code from the frame, because an SDK client turns that code into a thrown error.
 */
type Caller = (method: string, params: Record<string, unknown>) => Promise<unknown>;

describe('DR-0 / task 051 — replacement Tasks-store seam', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'imo-051-taskseam-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * BLOCKING ARM: a new store over the same `EventStore` must read back a task that the v2
   * attachment wrote. It shares no task cache with the writer, so `status`, `pollInterval` and the
   * result come from the durable stream. Without the `task.created` payload, `pollInterval` is 1000, not 250.
   *
   * NEGATIVE TWIN: an unknown task id returns `null`, so the store does not give a task for each id.
   * On the wire, `ping` succeeds on the connection that answers `-32601`, so the code shows the
   * missing Tasks runtime and not a dead transport. `hostMustServe` must not be empty, or the wire
   * loop asserts nothing. `attach.ts` declares the unserved methods and the live SDK shows them,
   * so a v2 release that restores one fails here.
   *
   * @oracle-sources: ../../../../src/projections/task-store/attach.ts, @modelcontextprotocol/server 2.0.0 live wire responses
   */
  it('TaskStoreSeam_V2Server_PreservesEventSourcedPersistence', async () => {
    const v2Server = createV2McpServer({ name: 'imo-051-v2', version: '1.0.0' });
    const [v2Host, v2ServerSide] = createV2LinkedTransportPair();
    const v2Inbox: unknown[] = [];
    v2Host.onmessage = (message) => {
      v2Inbox.push(message);
    };
    await connectV2Server(v2Server, v2ServerSide);
    await v2Host.start();

    let v2NextId = 1;
    const callV2: Caller = async (method, params) => {
      const id = v2NextId;
      v2NextId += 1;
      await v2Host.send({ jsonrpc: '2.0', id, method, params });
      return awaitResponse(v2Inbox, id);
    };

    const v2Initialize = await callV2('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'imo-051-probe', version: '1.0.0' },
    });
    expect(resultOf(v2Initialize)).toBeDefined();
    await v2Host.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const v2Attachment = attachTaskStoreToV2(new EventSourcedTaskStore(eventStore));
    expect(v2Attachment.generation).toBe('v2');
    expect(v2Attachment.sdkServedMethods).toEqual([]);
    expect(Object.hasOwn(v2Attachment, 'serverOptions')).toBe(false);
    expect(v2Attachment.hostMustServe.length).toBe(SDK_TASK_WIRE_METHODS.length);
    expect(v2Attachment.hostMustServe.length).toBeGreaterThan(0);
    expect(describeTaskWireGap(v2Attachment)).toContain('-32601');

    const created = await v2Attachment.store.createTask(
      { ttl: null, pollInterval: 250 },
      'imo-051-req',
      SAMPLE_REQUEST,
    );
    await v2Attachment.store.storeTaskResult(created.taskId, 'completed', {
      marker: 'imo-051-result',
    });

    const replayed = new EventSourcedTaskStore(eventStore);
    const recovered = await replayed.getTask(created.taskId);
    expect(recovered).not.toBeNull();
    expect(recovered?.taskId).toBe(created.taskId);
    expect(recovered?.status).toBe('completed');
    expect(recovered?.pollInterval).toBe(250);
    expect(await replayed.getTaskResult(created.taskId)).toEqual({
      marker: 'imo-051-result',
    });

    expect(await replayed.getTask('0'.repeat(32))).toBeNull();

    const pong = await callV2('ping', {});
    expect(
      resultOf(pong),
      'the v2 connection must answer `ping`; without that, a -32601 on ' +
        '`tasks/*` could just mean the handshake never completed',
    ).toBeDefined();

    const answeredAnyway: string[] = [];
    for (const method of v2Attachment.hostMustServe) {
      const response = await callV2(method, { taskId: created.taskId });
      if (errorCodeOf(response) !== METHOD_NOT_FOUND) answeredAnyway.push(method);
    }
    expect(
      answeredAnyway,
      'These methods are declared unserved on v2 but the SDK answered them. ' +
        'If a v2 release restored the Tasks runtime, `attach.ts` must be ' +
        'updated — the declaration has gone stale, which is the failure this ' +
        'assertion exists to catch.',
    ).toEqual([]);
  }, 30_000);

  /**
   * BLOCKING ARM: `isTaskTerminal` must agree with `V1_TERMINAL_VERDICTS` for each status of the
   * live v2 `TaskStatusSchema`. The test first requires the table to cover each live status, so a
   * new v2 status fails by name. Both verdicts must occur, or a constant function passes.
   *
   * NEGATIVE TWIN: each string outside the vocabulary is not terminal and does not throw. The store
   * guards then prove that the predicate is in use: a terminal task refuses `storeTaskResult` and
   * `updateTaskStatus`, and the first result stays.
   *
   * @oracle-sources: @modelcontextprotocol/core 2.0.0 TaskStatusSchema, ../../../../src/projections/task-store/port.ts
   */
  it('TaskStoreSeam_TerminalStateQuery_MatchesV1Semantics', async () => {
    expect(V2_TASK_STATUS_VALUES.length).toBeGreaterThan(0);
    expect(V2_TASK_STATUS_VALUES).toContain('working');
    expect(V2_TASK_STATUS_VALUES).toContain('completed');

    const unrecorded = V2_TASK_STATUS_VALUES.filter(
      (status) => !(status in V1_TERMINAL_VERDICTS),
    );
    expect(
      unrecorded,
      `v2 declares task status(es) the frozen v1 verdict table does not cover: ` +
        `${unrecorded.join(', ')}. A new status needs a terminal/non-terminal ` +
        `DECISION recorded in V1_TERMINAL_VERDICTS and in TERMINAL_TASK_STATUSES ` +
        `— it is not a test to relax.`,
    ).toEqual([]);

    const owned: Record<string, boolean> = {};
    const recorded: Record<string, boolean> = {};
    for (const status of V2_TASK_STATUS_VALUES) {
      owned[status] = isTaskTerminal(status);
      recorded[status] = V1_TERMINAL_VERDICTS[status]!;
    }
    expect(
      owned,
      'The owned terminal predicate disagrees with the RECORDED v1 verdicts. ' +
        'v1 is no longer installed, so this table is evidence rather than a ' +
        'live oracle (see V1_TERMINAL_VERDICTS) — a disagreement means the ' +
        'replacement drifted from semantics that were measured, not that the ' +
        'oracle moved. Neither is a test to relax.',
    ).toEqual(recorded);

    const verdicts = new Set(Object.values(owned));
    expect(verdicts.has(true)).toBe(true);
    expect(verdicts.has(false)).toBe(true);

    const terminalByOwned = V2_TASK_STATUS_VALUES.filter((s) => isTaskTerminal(s));
    expect([...terminalByOwned].sort()).toEqual([...TERMINAL_TASK_STATUSES].sort());

    for (const outsider of ['', 'Completed', 'done', 'COMPLETED', 'complete', 'working ']) {
      expect(isTaskTerminal(outsider)).toBe(false);
    }

    const store = new EventSourcedTaskStore(eventStore);
    const task = await store.createTask({ ttl: null }, 'imo-051-terminal', SAMPLE_REQUEST);

    await store.updateTaskStatus(task.taskId, 'input_required', 'need more');
    expect((await store.getTask(task.taskId))?.status).toBe('input_required');

    await store.storeTaskResult(task.taskId, 'completed', { marker: 'first' });
    expect((await store.getTask(task.taskId))?.status).toBe('completed');

    await expect(
      store.storeTaskResult(task.taskId, 'failed', { marker: 'second' }),
    ).rejects.toThrow(/terminal status/);
    await expect(
      store.updateTaskStatus(task.taskId, 'working'),
    ).rejects.toThrow(/terminal status/);

    expect(await store.getTaskResult(task.taskId)).toEqual({ marker: 'first' });
  });
});

/**
 * The verdicts of `isTerminal` from `@modelcontextprotocol/sdk@1.29.0`, recorded for each status of
 * the v2 `2.0.0` `TaskStatusSchema`. The v1 package is not installed, so the table is recorded
 * evidence and not a live oracle. Nothing computes it again.
 *
 * An edit to `isTaskTerminal` that changes a verdict fails against this table. The live half of
 * the comparison is the v2 `TaskStatusSchema`, which the test reads at runtime.
 */
const V1_TERMINAL_VERDICTS: Readonly<Record<string, boolean>> = {
  working: false,
  input_required: false,
  completed: true,
  failed: true,
  cancelled: true,
};
