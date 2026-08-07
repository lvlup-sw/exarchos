/**
 * The owned MCP SDK seam (DR-26) — the single module through which either SDK
 * generation is drawn.
 *
 * Two generations are installed side by side and will be for the length of the
 * migration:
 *
 *   • v1 — `@modelcontextprotocol/sdk@1.29.0`
 *   • v2 — `@modelcontextprotocol/{core,server}@2.0.0`
 *
 * They ship under different package names, so npm resolves both and the source
 * tree can migrate directory by directory. The hazard that creates is a value
 * drawn from one generation reaching an API belonging to the other — most
 * sharply an `InMemoryTransport` "linked pair" whose halves come from different
 * packages, which is not linked at all: each half talks to its own sibling, so
 * the two peers exchange nothing and the failure presents as a hang or an empty
 * result rather than an error.
 *
 * `tsc` will not catch that on its own — measured, not assumed; see
 * `./brand.ts` and `../architecture/sdk-generation-seam.ts`. So this module
 * re-exports the used surface with a **generation brand** on every handle, and
 * exposes the *pairing* operations (construct, connect, link) as branded
 * functions. Pairing is where the hazard lives, so pairing is where the brand
 * has to be enforced: calling `handle.connect(t)` directly would type-check
 * against the SDK's own unbranded parameter, which is precisely why
 * {@link connectV1Server} and friends exist instead.
 *
 * ── What "sole importer" means, and what enforces it ────────────────────────
 * DR-26 requires exactly one module to import either generation. That property
 * is NOT self-enforcing from inside this file — it is enforced by
 * `../architecture/sdk-generation-seam.ts` (rung-3 lint, task 049) and by the
 * layer rule task 053 adds while migrating the 38 measured direct-import sites
 * onto this seam. This file provides the type-level half; those provide the
 * import-level half. See `./brand.ts` for why neither subsumes the other.
 *
 * ── Deliberate holes (task 051 owns them) ───────────────────────────────────
 * v2 `2.0.0` DELETED the experimental Tasks store seam: no
 * `ServerOptions.taskStore`, and zero matches for `TaskStore` /
 * `CreateTaskOptions` / `isTerminal` in either v2 package. `adapters/mcp.ts`
 * constructs `new McpServer(…, { taskStore })` against `EventSourcedTaskStore`,
 * so the v2 side of that surface cannot be re-exported. It is represented here
 * as a named {@link SdkSurfaceGap} rather than invented: {@link V2TaskStore},
 * {@link V2CreateTaskOptions}, {@link V2Client}, {@link V2StdioClientTransport}.
 * Designing the replacement is task 051's job, not this module's.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * The re-exported surface is the surface the package actually uses today, so
 * task 053 can move call sites onto it without reshaping this API. This module
 * migrates NO call sites itself and removes NO dependency.
 */

// RESERVED(issue: #1604, owner: exarchos, expires: 2026-11-30) — the owned SDK seam (DR-26). Zero production importers until task 053 migrates the 38 measured direct-import sites onto it; if that adoption never happens the seam is dead weight and deletion at expiry is the correct outcome (DR-7 module-intent gate)

// ─── v1 — @modelcontextprotocol/sdk ──────────────────────────────────────────
import { McpServer as SdkV1McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server as SdkV1Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport as SdkV1StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client as SdkV1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as SdkV1StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport as SdkV1InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport as SdkV1Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  LATEST_PROTOCOL_VERSION as SDK_V1_LATEST_PROTOCOL_VERSION,
  RootsListChangedNotificationSchema as SdkV1RootsListChangedNotificationSchema,
  ElicitRequestSchema as SdkV1ElicitRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  Task as SdkV1Task,
  Request as SdkV1Request,
  RequestId as SdkV1RequestId,
  Result as SdkV1Result,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  TaskStore as SdkV1TaskStore,
  CreateTaskOptions as SdkV1CreateTaskOptions,
} from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { isTerminal as sdkV1IsTerminal } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';

// ─── v2 — @modelcontextprotocol/{core,server} ────────────────────────────────
import {
  McpServer as SdkV2McpServer,
  Server as SdkV2Server,
  InMemoryTransport as SdkV2InMemoryTransport,
  LATEST_PROTOCOL_VERSION as SDK_V2_LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/server';
import type {
  Transport as SdkV2Transport,
  Task as SdkV2Task,
  Request as SdkV2Request,
  RequestId as SdkV2RequestId,
  Result as SdkV2Result,
} from '@modelcontextprotocol/server';
import { StdioServerTransport as SdkV2StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { SdkSurfaceGap, V1, V2 } from './brand.js';

export type { SdkGeneration, SdkSurfaceGap, V1, V2 } from './brand.js';

// ════════════════════════════════════════════════════════════════════════════
// v1 handle types
// ════════════════════════════════════════════════════════════════════════════

/** A v1 `McpServer` instance. */
export type V1McpServer = V1<SdkV1McpServer>;
/** A v1 low-level `Server` instance. */
export type V1Server = V1<SdkV1Server>;
/** A v1 `Client` instance. */
export type V1Client = V1<SdkV1Client>;
/** Any v1 transport. */
export type V1Transport = V1<SdkV1Transport>;
/** A v1 stdio *server* transport. */
export type V1StdioServerTransport = V1<SdkV1StdioServerTransport>;
/** A v1 stdio *client* transport. */
export type V1StdioClientTransport = V1<SdkV1StdioClientTransport>;
/** A v1 in-memory transport (one half of a linked pair). */
export type V1InMemoryTransport = V1<SdkV1InMemoryTransport>;
/** The v1 experimental Tasks store contract. */
export type V1TaskStore = V1<SdkV1TaskStore>;
/** v1 task-creation options. */
export type V1CreateTaskOptions = V1<SdkV1CreateTaskOptions>;

// v1 protocol payload types.
export type V1Task = V1<SdkV1Task>;
export type V1TaskStatus = SdkV1Task['status'];
export type V1Request = V1<SdkV1Request>;
export type V1RequestId = SdkV1RequestId;
export type V1Result = V1<SdkV1Result>;

// ════════════════════════════════════════════════════════════════════════════
// v2 handle types
// ════════════════════════════════════════════════════════════════════════════

/** A v2 `McpServer` instance. */
export type V2McpServer = V2<SdkV2McpServer>;
/** A v2 low-level `Server` instance. */
export type V2Server = V2<SdkV2Server>;
/** Any v2 transport. */
export type V2Transport = V2<SdkV2Transport>;
/** A v2 stdio *server* transport. */
export type V2StdioServerTransport = V2<SdkV2StdioServerTransport>;
/** A v2 in-memory transport (one half of a linked pair). */
export type V2InMemoryTransport = V2<SdkV2InMemoryTransport>;

// v2 protocol payload types.
export type V2Task = V2<SdkV2Task>;
export type V2TaskStatus = SdkV2Task['status'];
export type V2Request = V2<SdkV2Request>;
export type V2RequestId = SdkV2RequestId;
export type V2Result = V2<SdkV2Result>;

// ── Typed holes: surfaces v2 2.0.0 does not have (task 051 / client package) ──

/**
 * v2 `2.0.0` deleted `ServerOptions.taskStore` and the `TaskStore` interface.
 * `EventSourcedTaskStore` (#1272/#1273) therefore has no v2 counterpart.
 */
export type V2TaskStore = SdkSurfaceGap<'v2 2.0.0 deleted the experimental Tasks store seam (no ServerOptions.taskStore, no TaskStore) — the replacement is task 051'>;

/** Counterpart of {@link V1CreateTaskOptions}; deleted with the store seam. */
export type V2CreateTaskOptions = SdkSurfaceGap<'v2 2.0.0 deleted CreateTaskOptions with the Tasks store seam — the replacement is task 051'>;

/** `@modelcontextprotocol/client` is not a declared dependency of this package. */
export type V2Client = SdkSurfaceGap<'@modelcontextprotocol/client is not installed — only core + server are declared dependencies'>;

/** Counterpart of {@link V1StdioClientTransport}; lives in the client package. */
export type V2StdioClientTransport = SdkSurfaceGap<'@modelcontextprotocol/client is not installed — only core + server are declared dependencies'>;

// ════════════════════════════════════════════════════════════════════════════
// v1 branded constructors
//
// Every factory forwards `ConstructorParameters<typeof …>` rather than
// restating the SDK's signature: a restated signature is a second authority for
// the same contract and drifts on the next SDK bump. Each `return` brands by
// declaration-site typing — no `as` assertion appears anywhere in this file.
// ════════════════════════════════════════════════════════════════════════════

export function createV1McpServer(
  ...args: ConstructorParameters<typeof SdkV1McpServer>
): V1McpServer {
  return new SdkV1McpServer(...args);
}

export function createV1Server(
  ...args: ConstructorParameters<typeof SdkV1Server>
): V1Server {
  return new SdkV1Server(...args);
}

export function createV1Client(
  ...args: ConstructorParameters<typeof SdkV1Client>
): V1Client {
  return new SdkV1Client(...args);
}

export function createV1StdioServerTransport(
  ...args: ConstructorParameters<typeof SdkV1StdioServerTransport>
): V1StdioServerTransport {
  return new SdkV1StdioServerTransport(...args);
}

export function createV1StdioClientTransport(
  ...args: ConstructorParameters<typeof SdkV1StdioClientTransport>
): V1StdioClientTransport {
  return new SdkV1StdioClientTransport(...args);
}

/**
 * A v1 in-memory linked pair. Returning both halves from ONE call is what makes
 * the cross-generation pair unconstructible through the seam: there is no way to
 * ask this function for a single half and complete the pair from the other
 * generation.
 */
export function createV1LinkedTransportPair(): readonly [
  V1InMemoryTransport,
  V1InMemoryTransport,
] {
  return SdkV1InMemoryTransport.createLinkedPair();
}

// ════════════════════════════════════════════════════════════════════════════
// v2 branded constructors
// ════════════════════════════════════════════════════════════════════════════

export function createV2McpServer(
  ...args: ConstructorParameters<typeof SdkV2McpServer>
): V2McpServer {
  return new SdkV2McpServer(...args);
}

export function createV2Server(
  ...args: ConstructorParameters<typeof SdkV2Server>
): V2Server {
  return new SdkV2Server(...args);
}

export function createV2StdioServerTransport(
  ...args: ConstructorParameters<typeof SdkV2StdioServerTransport>
): V2StdioServerTransport {
  return new SdkV2StdioServerTransport(...args);
}

/** A v2 in-memory linked pair. See {@link createV1LinkedTransportPair}. */
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
// branded handle would still accept the other generation's transport, because
// the SDK's own `connect` parameter is unbranded. Routing the pairing through
// these functions is what turns a cross-generation pair into a compile error.
// ════════════════════════════════════════════════════════════════════════════

export async function connectV1Server(
  server: V1McpServer | V1Server,
  transport: V1Transport,
): Promise<void> {
  await server.connect(transport);
}

export async function connectV1Client(
  client: V1Client,
  transport: V1Transport,
  ...rest: DropFirst<Parameters<SdkV1Client['connect']>>
): Promise<void> {
  await client.connect(transport, ...rest);
}

export async function connectV2Server(
  server: V2McpServer | V2Server,
  transport: V2Transport,
): Promise<void> {
  await server.connect(transport);
}

/** Every element of `T` except the first — used to forward optional tails. */
type DropFirst<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest]
  ? Rest
  : [];

// ════════════════════════════════════════════════════════════════════════════
// Branded predicates, constants and schemas
// ════════════════════════════════════════════════════════════════════════════

/** v1 `isTerminal` — is a task status a terminal state? */
export function isV1TaskTerminal(status: V1TaskStatus): boolean {
  return sdkV1IsTerminal(status);
}

/**
 * v2 has no `isTerminal`; the behavioural replacement is task 051's
 * `TaskStoreSeam_TerminalStateQuery_MatchesV1Semantics`. Deliberately absent
 * rather than re-implemented here — see {@link V2TaskStore}.
 */
export type IsV2TaskTerminal = SdkSurfaceGap<'v2 2.0.0 deleted isTerminal with the Tasks store seam — the behavioural replacement is task 051'>;

/** The protocol version the v1 SDK advertises. */
export const V1_LATEST_PROTOCOL_VERSION: string = SDK_V1_LATEST_PROTOCOL_VERSION;

/** The protocol version the v2 SDK advertises. */
export const V2_LATEST_PROTOCOL_VERSION: string = SDK_V2_LATEST_PROTOCOL_VERSION;

/**
 * v1 notification/request schemas used with `setNotificationHandler` /
 * `setRequestHandler`. Re-exported unbranded: a Zod schema is not a handle, it
 * is a parser, and branding it would only make `schema.parse(...)` awkward at
 * every call site without separating anything the handle brands do not already
 * separate.
 */
export const V1_ROOTS_LIST_CHANGED_NOTIFICATION_SCHEMA = SdkV1RootsListChangedNotificationSchema;
export const V1_ELICIT_REQUEST_SCHEMA = SdkV1ElicitRequestSchema;
