/**
 * The owned MCP SDK seam (DR-26) — the single module through which the SDK is
 * drawn.
 *
 * ── One generation, as of task 049 ──────────────────────────────────────────
 * DR-0's source migration is COMPLETE. The tree is on v2 alone:
 *
 *   • v2 — `@modelcontextprotocol/{core,server,client}@2.0.0`
 *
 * `@modelcontextprotocol/sdk@1.29.0` (v1) is **removed from `package.json`**;
 * `grep -rn "@modelcontextprotocol/sdk"` returns zero non-vendor hits, which is
 * DR-0's stated removal criterion met literally rather than by allowlist.
 *
 * The migration ran server-first and could not finish there: nine test modules
 * and the exp1 eval driver drive the server through a `Client` over an in-memory
 * linked pair, so a v2 server with a v1 client would have been exactly the
 * cross-generation pair this seam exists to forbid — halves that talk to their
 * own siblings, presenting as a hang or an empty result rather than an error.
 * `@modelcontextprotocol/client@2.0.0` was therefore added (exact-pinned, same
 * policy as `core`/`server`), which is what let the v1 dependency go entirely.
 * That closed two of the three surface gaps task 052 left as holes.
 *
 * ── Why the brand survives a single-generation tree ─────────────────────────
 * The generation brand (`./brand.ts`) is NOT retired here, and the reason is not
 * sentiment. `SdkGeneration` is still a two-member vocabulary because the
 * *mixing lint* (`../architecture/sdk-generation-seam.ts`) is a claim about what
 * a tree may contain, not about what this tree happens to contain today. A
 * guarantee that lapses the moment it stops having a live subject is the failure
 * mode task 027 spent five proofs correcting. The brand keeps costing nothing —
 * `__gen` is optional and phantom, so every factory below still returns by plain
 * `return` with zero `as` assertions — and it keeps the rung-2 rejection ready
 * for the next generation rather than needing to be rebuilt for it.
 *
 * ── What "sole importer" means, and what enforces it ────────────────────────
 * DR-26 requires exactly one module to import the SDK. That property is NOT
 * self-enforcing from inside this file — it is enforced by
 * `../architecture/layer-boundaries-seam.ts`'s `SDK_SEAM_BOUNDARY` rule (task
 * 053), which rejects a direct SDK import from any module but this one, with
 * zero exemptions. `SdkSeam_MigratedTree_ResolvesEverySiteThroughSeam` walks the
 * tree and asserts that the set of modules importing an MCP SDK package is
 * exactly `{sdk/seam.ts}`. Its falsifier (`SdkSeam_DirectSdkImport_FailsSeamRule`)
 * is kept alive separately, because "zero violations" over a migrated tree is
 * otherwise indistinguishable from a rule that cannot fire.
 *
 * ── The one surface that is still missing, and why it stays a hole ──────────
 * v2 `2.0.0` deleted the experimental Tasks store seam: no
 * `ServerOptions.taskStore`, and zero matches for `TaskStore` /
 * `CreateTaskOptions` / `isTerminal` in any v2 package. Task 051 relocated the
 * store CONTRACT to `../task-store/port.ts` (`TaskStorePort`, `CreateTaskParams`,
 * `isTaskTerminal`), which is OWNED and generation-neutral and therefore
 * deliberately NOT re-exported from this module — routing it through the SDK
 * seam would claim it is drawn from a generation, and it is not.
 *
 * The constructor OPTION has no owned replacement, so {@link V2TaskStoreServerOption}
 * remains an uninhabited hole. It is the sharpest edge in this migration: a v2
 * server handed a `taskStore` option **ignores it silently** (measured — no
 * throw, no warning, the key is dropped), which would produce a server that is
 * fully persistent and quietly dark on the wire. `../task-store/attach.ts` is
 * the seam that makes that silence impossible to ship, and its
 * `describeTaskWireGap()` is what announces the accepted loss out loud.
 *
 * ── D10: `tasks/*` is not served ────────────────────────────────────────────
 * v2 ships no server-side Tasks runtime at all — all four of
 * `tasks/{get,result,list,cancel}` answer `-32601` while `ping` on the same
 * connection answers normally. Per operator decision D10 that wire loss is
 * ACCEPTED rather than papered over: the rejection is a typed `-32601` from a
 * surface we chose not to serve, never a silent no-op. The task *protocol types*
 * survive and are re-exported below, because the CLI `--follow` loop and
 * dispatch's Tasks-augmented branch drive the store directly and never went
 * through the SDK.
 */

// ─── v2 server — @modelcontextprotocol/{core,server} ─────────────────────────
import {
  McpServer as SdkV2McpServer,
  Server as SdkV2Server,
  InMemoryTransport as SdkV2InMemoryTransport,
  LATEST_PROTOCOL_VERSION as SDK_V2_LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/server';
import { TaskStatusSchema as SdkV2TaskStatusSchema } from '@modelcontextprotocol/core';
import type {
  Transport as SdkV2Transport,
  Task as SdkV2Task,
  Request as SdkV2Request,
  RequestId as SdkV2RequestId,
  Result as SdkV2Result,
} from '@modelcontextprotocol/server';
import { StdioServerTransport as SdkV2StdioServerTransport } from '@modelcontextprotocol/server/stdio';

// ─── v2 client — @modelcontextprotocol/client ────────────────────────────────
import { Client as SdkV2Client } from '@modelcontextprotocol/client';
import { StdioClientTransport as SdkV2StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { SdkSurfaceGap, V2 } from './brand.js';

export type { SdkGeneration, SdkSurfaceGap, V1, V2 } from './brand.js';

// ════════════════════════════════════════════════════════════════════════════
// v2 handle types
// ════════════════════════════════════════════════════════════════════════════

/** A v2 `McpServer` instance. */
export type V2McpServer = V2<SdkV2McpServer>;
/** A v2 low-level `Server` instance. */
export type V2Server = V2<SdkV2Server>;
/** A v2 `Client` instance. */
export type V2Client = V2<SdkV2Client>;
/** Any v2 transport. */
export type V2Transport = V2<SdkV2Transport>;
/** A v2 stdio *server* transport. */
export type V2StdioServerTransport = V2<SdkV2StdioServerTransport>;
/** A v2 stdio *client* transport. */
export type V2StdioClientTransport = V2<SdkV2StdioClientTransport>;
/** A v2 in-memory transport (one half of a linked pair). */
export type V2InMemoryTransport = V2<SdkV2InMemoryTransport>;

// v2 protocol payload types.
export type V2Task = V2<SdkV2Task>;
// `V2TaskStatus` was deleted with the v1 terminal-status oracle it existed to
// type (task 049). Consumers ask "is this status terminal?" of arbitrary strings
// folded out of durable events, so the owned predicate in `../task-store/port.ts`
// takes `string` — a narrowed alias here had exactly one caller and would push a
// cast onto every other one. `V2_TASK_STATUS_VALUES` remains as the iterable
// runtime vocabulary, which is what the equivalence test actually needs.
export type V2Request = V2<SdkV2Request>;
export type V2RequestId = SdkV2RequestId;
export type V2Result = V2<SdkV2Result>;

// ── Typed hole: the one surface v2 2.0.0 does not have ───────────────────────

/**
 * There is no v2 `ServerOptions.taskStore`, and — measured against
 * `@modelcontextprotocol/server@2.0.0` — passing one anyway is **ignored
 * silently**: no throw, no warning, the key is dropped and every `tasks/*`
 * request thereafter answers `-32601`.
 *
 * This stays an uninhabited hole even though the store CONTRACT was successfully
 * relocated: the contract has an owned replacement (`../task-store/port.ts`), the
 * constructor option has none, and conflating the two is exactly how a migration
 * ships a server that is persistent and dark at the same time.
 *
 * `../task-store/attach.ts` is the seam that acts on this: its v2 attachment type
 * has no `serverOptions` member to spread, so there is nothing to hand the v2
 * constructor in the first place. {@link describeTaskWireGap} is what makes the
 * resulting wire loss audible.
 */
export type V2TaskStoreServerOption = SdkSurfaceGap<'v2 2.0.0 deleted ServerOptions.taskStore and every tasks/* handler, and a v2 server IGNORES the option silently — the store contract lives at ../task-store/port.ts and the attach seam at ../task-store/attach.ts'>;

// ════════════════════════════════════════════════════════════════════════════
// v2 branded constructors
//
// Every factory forwards `ConstructorParameters<typeof …>` rather than restating
// the SDK's signature: a restated signature is a second authority for the same
// contract and drifts on the next SDK bump. Each `return` brands by
// declaration-site typing — no `as` assertion appears anywhere in this file.
// ════════════════════════════════════════════════════════════════════════════

export function createV2McpServer(
  ...args: ConstructorParameters<typeof SdkV2McpServer>
): V2McpServer {
  return new SdkV2McpServer(...args);
}

// `createV2Server` was DELETED by task 049 rather than kept for symmetry with
// `createV2McpServer`. Nothing in the tree constructs a low-level `Server`: the
// adapter reaches one as `mcpServer.server` (an accessor on an already-built
// `McpServer`), the elicitation fixture wants it as a TYPE ({@link V2Server}),
// and the tests that want the class want its PROTOTYPE
// ({@link V2_SERVER_CLASS}). Three distinct needs, none of them a constructor.
// The v1 twin carried this same finding as a documented over-export while the
// migration was in flight; with the migration done, the honest discharge is
// deletion rather than a second round of explaining why it is unused.

export function createV2Client(
  ...args: ConstructorParameters<typeof SdkV2Client>
): V2Client {
  return new SdkV2Client(...args);
}

export function createV2StdioServerTransport(
  ...args: ConstructorParameters<typeof SdkV2StdioServerTransport>
): V2StdioServerTransport {
  return new SdkV2StdioServerTransport(...args);
}

export function createV2StdioClientTransport(
  ...args: ConstructorParameters<typeof SdkV2StdioClientTransport>
): V2StdioClientTransport {
  return new SdkV2StdioClientTransport(...args);
}

/**
 * A v2 in-memory linked pair. Returning both halves from ONE call is what makes
 * a cross-generation pair unconstructible through the seam: there is no way to
 * ask this function for a single half and complete the pair from elsewhere.
 */
export function createV2LinkedTransportPair(): readonly [
  V2InMemoryTransport,
  V2InMemoryTransport,
] {
  return SdkV2InMemoryTransport.createLinkedPair();
}

// ════════════════════════════════════════════════════════════════════════════
// Branded pairing operations
//
// THE RUNG-2 ENFORCEMENT POINT. `server.connect(transport)` called directly on a
// branded handle would still accept another generation's transport, because the
// SDK's own `connect` parameter is unbranded. Routing the pairing through these
// functions is what turns a cross-generation pair into a compile error.
// ════════════════════════════════════════════════════════════════════════════

export async function connectV2Server(
  server: V2McpServer | V2Server,
  transport: V2Transport,
): Promise<void> {
  await server.connect(transport);
}

export async function connectV2Client(
  client: V2Client,
  transport: V2Transport,
  ...rest: DropFirst<Parameters<SdkV2Client['connect']>>
): Promise<void> {
  await client.connect(transport, ...rest);
}

/** Every element of `T` except the first — used to forward optional tails. */
type DropFirst<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest]
  ? Rest
  : [];

// ════════════════════════════════════════════════════════════════════════════
// Branded constants and vocabulary
// ════════════════════════════════════════════════════════════════════════════

/**
 * v2's own task-status vocabulary, read from `@modelcontextprotocol/core`'s
 * runtime `TaskStatusSchema` enum rather than restated.
 *
 * A *runtime* value, not a type: the equivalence test needs a population it can
 * iterate, and a type union cannot be iterated.
 *
 * ── The oracle this used to be compared against is GONE, stated plainly ─────
 * Before task 049 the owned `isTaskTerminal` was differentially tested against
 * v1's `isTerminal` — two different npm packages, so they could genuinely
 * disagree. Removing the v1 dependency removes that second authority, and
 * pretending otherwise would be the "one authority wearing two names" defect
 * DR-30's oracle-sources check exists to reject.
 *
 * What survives is still a real differential, one rung weaker: this list is
 * v2 `core`'s authority over the status vocabulary, and
 * `../task-store/port.ts`'s `TERMINAL_TASK_STATUSES` is ours. A v2 release that
 * adds or renames a status makes this list grow and the agreement assertion
 * fail, which is the intended signal. What can no longer be re-derived is the
 * historical claim that our classification matched v1's — that was proven at
 * migration time and is now a recorded fact, not a live check.
 *
 * Deliberately typed `readonly string[]` rather than the enum's literal union:
 * consumers ask "is this status terminal?" of arbitrary strings folded out of
 * durable events, and narrowing here would push a cast onto every call site.
 */
export const V2_TASK_STATUS_VALUES: readonly string[] = SdkV2TaskStatusSchema.options;

// ── Class objects, for PROTOTYPE-level instrumentation only (task 053) ───────
//
// The factories above are the construction route and stay so. These two export
// the constructor *objects* themselves, for the one thing a factory structurally
// cannot serve: `vi.spyOn(McpServer.prototype, 'registerTool')`.
//
// That pattern needs the class IDENTITY — the very prototype object the
// production path calls through. A seam that cannot supply a surface its own
// tree uses is not "the sole importer"; it is a seam with a hole and an
// exemption list.
//
// WHAT THIS COSTS, stated rather than glossed: `new V2_MCP_SERVER_CLASS(...)`
// yields an UNBRANDED instance, so it is not the branded construction route.
// That costs nothing the brand was already buying — `./brand.ts` declares
// `__gen` optional precisely so an unbranded value is admitted by its own
// generation's position. The rung-2 guarantee lives on the *pairing* functions
// (`connectV2Server` and friends), which these do not weaken.
export const V2_MCP_SERVER_CLASS: typeof SdkV2McpServer = SdkV2McpServer;

/** @see V2_MCP_SERVER_CLASS — the low-level v2 `Server` counterpart. */
export const V2_SERVER_CLASS: typeof SdkV2Server = SdkV2Server;

/** The protocol version the v2 SDK advertises. */
export const V2_LATEST_PROTOCOL_VERSION: string = SDK_V2_LATEST_PROTOCOL_VERSION;

/**
 * Notification and request METHOD NAMES, replacing v1's exported Zod schemas.
 *
 * This is the one genuine signature break the migration crossed, and it is worth
 * naming: v1's `setNotificationHandler(RootsListChangedNotificationSchema, fn)`
 * took a *schema* as its discriminator, while v2's takes the *method string*
 * (`setNotificationHandler('notifications/roots/list_changed', fn)`) and resolves
 * the payload type from its own `NotificationTypeMap`. The schemas v1 exported
 * for this purpose therefore have no v2 counterpart to re-export — the
 * replacement is vocabulary, not a parser.
 *
 * Declared here rather than inlined at the call sites so the string literals have
 * one authority: a typo in a method name is otherwise a handler that silently
 * never fires, which is the same silent-degradation class D10 exists to reject.
 */
export const V2_ROOTS_LIST_CHANGED_NOTIFICATION_METHOD = 'notifications/roots/list_changed';
export const V2_ELICIT_REQUEST_METHOD = 'elicitation/create';

// ── Where the D10 wire gap is described, and why NOT here ───────────────────
//
// The accepted `tasks/*` loss is announced by `../task-store/attach.ts`'s
// `describeTaskWireGap(attachment)`, which task 049 wired to a real caller. It
// is deliberately NOT restated in this module: that function derives its account
// from the ATTACHMENT (`hostMustServe`), so it reports what a particular server
// actually failed to bind, while anything written here could only restate a
// belief about the SDK. Two functions with that name would be one authority
// wearing two names — the exact shape DR-30's oracle-sources check rejects.
