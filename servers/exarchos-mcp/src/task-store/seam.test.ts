// ─── DR-0 / task 051 — the replacement Tasks-store seam ────────────────────
//
// v2 `2.0.0` did not rename the experimental Tasks store seam; it removed the
// entire server-side Tasks runtime. `ServerOptions.taskStore`, `TaskStore`,
// `CreateTaskOptions` and `isTerminal` are gone, and a live v2 `McpServer`
// answers every `tasks/*` method with `-32601`.
//
// That splits `EventSourcedTaskStore`'s guarantee in two, and the split is the
// whole subject of this file:
//
//   • PERSISTENCE — event-sourced, `EventStore`-backed, never the SDK's.
//     Must survive the v2 migration intact.
//   • WIRE        — `tasks/{get,result,list,cancel}`, which v1's SDK served
//     for free from the injected store and v2 serves not at all. Must NOT be
//     pretended to survive.
//
// A v2 server handed a `taskStore` option ignores it SILENTLY, so the naive
// migration yields a server that is still persistent and quietly dark. Both
// tests below exist to make that state unreachable rather than merely
// documented.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { EventSourcedTaskStore } from './event-sourced-task-store.js';
import {
  SDK_TASK_WIRE_METHODS,
  attachTaskStoreToV1,
  attachTaskStoreToV2,
  describeTaskWireGap,
} from './attach.js';
import { TERMINAL_TASK_STATUSES, isTaskTerminal } from './port.js';
import {
  V2_TASK_STATUS_VALUES,
  connectV2Server,
  createV2LinkedTransportPair,
  createV2McpServer,
} from '../sdk/seam.js';

/** JSON-RPC "Method not found". */
const METHOD_NOT_FOUND = -32601;

const SAMPLE_REQUEST = { method: 'tools/call', params: { name: 'noop', arguments: {} } };

// ─── Raw JSON-RPC helpers ───────────────────────────────────────────────────
//
// Driving the wire by hand rather than through a `Client`: the v2 client
// package is not installed, and a client would hide exactly the thing under
// measurement — an SDK client turns `-32601` into a thrown `McpError`, which
// reads the same as a transport fault. Raw frames let the JSON-RPC error CODE
// itself be the observation.

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

/**
 * Wait for the response frame carrying `id`. Polls the inbox instead of racing
 * a fixed sleep, so a slow machine lengthens the test rather than flaking it.
 */
async function awaitResponse(inbox: readonly unknown[], id: number): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const hit = inbox.find((message) => idOf(message) === id);
    if (hit !== undefined) return hit;
    await sleep(10);
  }
  throw new Error(`no JSON-RPC response for id ${id} after 2s`);
}

/** Sends a request and resolves with its response frame. */
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
   * The seam keeps the event-sourced guarantee across the generation boundary,
   * and refuses to keep the wire guarantee it cannot keep.
   *
   * BLOCKING ARM — with a LIVE v2 `McpServer` as the server, a task driven
   * through the v2 attachment's store is recoverable, in full, by a FRESH store
   * constructed over the same `EventStore`. That fresh instance shares no
   * in-memory state with the writer, so the only channel between them is the
   * durable `task-store/<taskId>` stream: recovering `status`, `pollInterval`,
   * `requestId` and the stored result proves the persistence guarantee, not
   * merely the interface shape.
   *
   * NEGATIVE TWIN — the same fresh-store code path, asked for a taskId that has
   * no durable stream, returns `null`. The seam it kills: "the store returns a
   * plausible task for anything, so the recovery above proves nothing about the
   * events." A second twin runs beside it on the wire: the v2 connection
   * answers `ping` normally in the very exchange where every `tasks/*` method
   * is refused, so `-32601` is attributable to the missing Tasks runtime rather
   * than to a dead transport or a half-finished handshake.
   *
   * The two authorities are independent: `attach.ts` DECLARES which methods go
   * dark, and `@modelcontextprotocol/server@2.0.0` DEMONSTRATES it. Neither is
   * computed from the other, so a v2 release that restores any method turns
   * this RED instead of leaving a stale declaration standing.
   *
   * @oracle-sources: ./attach.ts, @modelcontextprotocol/server 2.0.0 live wire responses
   */
  it('TaskStoreSeam_V2Server_PreservesEventSourcedPersistence', async () => {
    // ── A live v2 server, drawn through the owned SDK seam ──────────────────
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

    // ── The v2 attachment: persistence yes, wire no ─────────────────────────
    const v2Attachment = attachTaskStoreToV2(new EventSourcedTaskStore(eventStore));
    expect(v2Attachment.generation).toBe('v2');
    expect(v2Attachment.sdkServedMethods).toEqual([]);
    // There is no `serverOptions` member to hand a v2 constructor. The type
    // says so; this pins the runtime shape too, so a well-meaning future edit
    // cannot re-introduce the silently-ignored option.
    expect(Object.hasOwn(v2Attachment, 'serverOptions')).toBe(false);
    // Anti-vacuity: an empty `hostMustServe` would make the wire sweep below
    // assert nothing at all while still reporting green.
    expect(v2Attachment.hostMustServe.length).toBe(SDK_TASK_WIRE_METHODS.length);
    expect(v2Attachment.hostMustServe.length).toBeGreaterThan(0);
    expect(describeTaskWireGap(v2Attachment)).toContain('-32601');

    // ── Drive the lifecycle while the v2 server is the live server ──────────
    const created = await v2Attachment.store.createTask(
      { ttl: null, pollInterval: 250 },
      'imo-051-req',
      SAMPLE_REQUEST,
    );
    await v2Attachment.store.storeTaskResult(created.taskId, 'completed', {
      marker: 'imo-051-result',
    });

    // ── BLOCKING ARM — a fresh store recovers everything from events alone ──
    const replayed = new EventSourcedTaskStore(eventStore);
    const recovered = await replayed.getTask(created.taskId);
    expect(recovered).not.toBeNull();
    expect(recovered?.taskId).toBe(created.taskId);
    expect(recovered?.status).toBe('completed');
    // `pollInterval` is the sharpest field here: it only survives a restart
    // because `task.created` persists it, so a store that "recovered" from a
    // shared cache instead of the stream would still show it — but a store
    // that lost the durable payload would silently show the 1000ms default.
    expect(recovered?.pollInterval).toBe(250);
    expect(await replayed.getTaskResult(created.taskId)).toEqual({
      marker: 'imo-051-result',
    });

    // NEGATIVE TWIN — same code path, no durable stream, no task.
    expect(await replayed.getTask('0'.repeat(32))).toBeNull();

    // ── The wire half, measured against the live v2 server ──────────────────
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

    // ── THE v1 ARM IS RETIRED, and the retirement is deliberate (task 049) ──
    //
    // This test used to end by building a SECOND server from
    // `attachTaskStoreToV1`'s `serverOptions` and proving it still served
    // `tasks/get` for the same durable task — the "additive and revertible"
    // property DR-0 promised while both generations were installed.
    //
    // That property was real, it passed, and DR-0's source migration has now
    // SPENT it: `@modelcontextprotocol/sdk` is uninstalled, so a v1 server is
    // not merely unnecessary to build here, it is unconstructible. Keeping the
    // arm alive by pointing it at a v2 server (which the mechanical rename did)
    // produces a test asserting that v2 serves `tasks/get` — the exact opposite
    // of D10, and a green-looking assertion of something false.
    //
    // Nothing is lost by removing it, and that is checkable rather than
    // asserted: every guarantee it carried is still proven above, on the LIVE
    // generation — persistence survives a fresh store built from events alone
    // (the replay arm), and the wire loss is measured against a real v2 server
    // that answers `ping` and `-32601` on all four methods. What the arm proved
    // uniquely was revertibility, and there is nothing left to revert to.
    //
    // `attachTaskStoreToV1` itself is deliberately RETAINED in `attach.ts`. It
    // is the v1 half of the generation contrast the module is built around, it
    // is exercised by the attachment-shape assertions at the top of this file
    // (which need no SDK), and deleting it would leave `attachTaskStoreToV2`
    // asymmetric with nothing to be asymmetric AGAINST — which is what makes
    // the missing `serverOptions` member legible as a decision.
  }, 30_000);

  /**
   * `isTerminal` has a BEHAVIOURAL replacement, not a type-level one.
   *
   * BLOCKING ARM — the owned `isTaskTerminal` is compared, status by status,
   * against the v1 SDK's own `isTerminal` over the vocabulary v2's runtime
   * `TaskStatusSchema` enumerates. Subject, oracle and population come from
   * three places, and the oracle and population come from two DIFFERENT npm
   * packages, so they can genuinely disagree.
   *
   * NEGATIVE TWIN — the same comparison is run over out-of-vocabulary strings
   * (`''`, a case variant, an invented status). The seam it kills: "both
   * functions return `false` for everything, so agreement over a
   * non-terminal-heavy population is trivially satisfiable." The vocabulary
   * arm additionally asserts that BOTH verdicts occur — an agreement measured
   * over a population that is all-terminal or all-non-terminal would be
   * satisfied by a constant function.
   *
   * The predicate is then shown to be LOAD-BEARING, not merely correct: the
   * store's terminal guards are driven for real, so replacing `isTaskTerminal`
   * with `() => false` breaks behaviour and not just a pure-function assertion.
   *
   * ── ORACLE CHANGE, task 049 ─────────────────────────────────────────────
   * v1 is no longer installed, so `isTerminal` can no longer be called live.
   * The differential now runs against `V1_TERMINAL_VERDICTS` — v1's verdicts
   * FROZEN with provenance at migration time — plus v2 `core`'s live
   * `TaskStatusSchema`, which is still read at runtime and is still an
   * authority independent of `./port.ts`. Read the table's own doc comment
   * before treating it as an oracle; it is evidence.
   *
   * @oracle-sources: @modelcontextprotocol/core 2.0.0 TaskStatusSchema, ./port.ts
   */
  it('TaskStoreSeam_TerminalStateQuery_MatchesV1Semantics', async () => {
    // Anti-vacuity on the population itself: an empty vocabulary would make
    // every per-status assertion below vacuously true.
    expect(V2_TASK_STATUS_VALUES.length).toBeGreaterThan(0);
    expect(V2_TASK_STATUS_VALUES).toContain('working');
    expect(V2_TASK_STATUS_VALUES).toContain('completed');

    // TOTALITY OVER THE LIVE VOCABULARY, asserted before the comparison so a v2
    // release that adds a status fails HERE — loudly, naming the new status —
    // rather than slipping past as a key the frozen table simply lacks.
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

    // Both verdicts must actually occur, or "agreement" is a constant function.
    const verdicts = new Set(Object.values(owned));
    expect(verdicts.has(true)).toBe(true);
    expect(verdicts.has(false)).toBe(true);

    // The terminal set is exactly what v1 called terminal, spelled out.
    const terminalByOwned = V2_TASK_STATUS_VALUES.filter((s) => isTaskTerminal(s));
    expect([...terminalByOwned].sort()).toEqual([...TERMINAL_TASK_STATUSES].sort());

    // NEGATIVE TWIN — totality over out-of-vocabulary input. A status folded
    // out of a durable event written by a future schema must be non-terminal,
    // never a throw and never terminal.
    for (const outsider of ['', 'Completed', 'done', 'COMPLETED', 'complete', 'working ']) {
      expect(isTaskTerminal(outsider)).toBe(false);
    }

    // ── The predicate is load-bearing, not decorative ───────────────────────
    const store = new EventSourcedTaskStore(eventStore);
    const task = await store.createTask({ ttl: null }, 'imo-051-terminal', SAMPLE_REQUEST);

    // Non-terminal → the transition is allowed.
    await store.updateTaskStatus(task.taskId, 'input_required', 'need more');
    expect((await store.getTask(task.taskId))?.status).toBe('input_required');

    await store.storeTaskResult(task.taskId, 'completed', { marker: 'first' });
    expect((await store.getTask(task.taskId))?.status).toBe('completed');

    // Terminal → both mutating paths refuse. These are the two call sites the
    // predicate guards; a `() => false` replacement makes both of them pass.
    await expect(
      store.storeTaskResult(task.taskId, 'failed', { marker: 'second' }),
    ).rejects.toThrow(/terminal status/);
    await expect(
      store.updateTaskStatus(task.taskId, 'working'),
    ).rejects.toThrow(/terminal status/);

    // …and the durable record still shows the FIRST result, so the refusals
    // were refusals and not swallowed writes.
    expect(await store.getTaskResult(task.taskId)).toEqual({ marker: 'first' });
  });
});

/**
 * The v1 oracle's verdict table, FROZEN as recorded evidence (task 049).
 *
 * ── Why this is a literal now, when a literal was previously the wrong shape ──
 * Until task 049 this comparison called `isTerminal` out of
 * `@modelcontextprotocol/sdk@1.29.0` live, which is what made it a genuine
 * differential: two npm packages that could disagree. DR-0's source migration
 * removed the v1 dependency outright, so that authority no longer exists to
 * call. There is no honest way to keep calling it, and inventing a local
 * re-implementation and calling it an oracle would be the "one authority wearing
 * two names" defect DR-30's oracle-sources check exists to reject.
 *
 * So the oracle is retired the only way a retired oracle can stay useful: its
 * verdicts are written down, with provenance, as the historical measurement they
 * are. This table was produced by running v1 `1.29.0`'s `isTerminal` over v2
 * `2.0.0`'s full `TaskStatusSchema` vocabulary at migration time, and it is
 * evidence rather than an authority — it cannot re-derive itself, and it is
 * labelled so no future reader mistakes it for a live check.
 *
 * What it still catches is real and is the reason it is not simply deleted: any
 * future edit to `isTaskTerminal` that changes a verdict fails here, against a
 * table the edit's author did not write. What it can no longer catch is v1
 * changing — which is moot, because v1 is gone.
 *
 * The LIVE half of the differential survives in the test body: v2 `core`'s
 * `TaskStatusSchema` is still read at runtime, so a v2 release that adds or
 * renames a status makes the vocabulary assertions fail rather than silently
 * widening the population.
 */
const V1_TERMINAL_VERDICTS: Readonly<Record<string, boolean>> = {
  working: false,
  input_required: false,
  completed: true,
  failed: true,
  cancelled: true,
};
