/**
 * The owned MCP SDK seam: the one module that imports the SDK. The tree uses only the v2
 * packages `@modelcontextprotocol/{core,server,client}`. The `SDK_SEAM_BOUNDARY` rule in
 * `architecture/layer-boundaries-seam.ts` rejects a direct SDK import from any other module.
 *
 * The generation brand of `./brand.ts` stays, so the next generation gets the same compile-time
 * rejection. Each constructor factory forwards `ConstructorParameters`, because a restated SDK
 * signature drifts on the next SDK update. No factory uses an `as` assertion to brand its handle.
 *
 * v2 serves no `tasks/*` method. Each one answers `-32601`, and that wire loss is accepted.
 * `describeTaskWireGap` in `projections/task-store/attach.ts` reports the loss for each server.
 * The owned store contract is in `projections/task-store/port.ts`, and this module does not
 * re-export it, because it belongs to no SDK generation.
 */
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

import { Client as SdkV2Client } from '@modelcontextprotocol/client';
import { StdioClientTransport as SdkV2StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { SdkSurfaceGap, V2 } from './brand.js';

export type { SdkGeneration, SdkSurfaceGap, V1, V2 } from './brand.js';

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

/** A v2 task payload. */
export type V2Task = V2<SdkV2Task>;
export type V2Request = V2<SdkV2Request>;
export type V2RequestId = SdkV2RequestId;
export type V2Result = V2<SdkV2Result>;

/**
 * A typed hole for the missing v2 `ServerOptions.taskStore`. A v2 server drops that option with
 * no error, and each `tasks/*` request then answers `-32601`. The v2 attachment type in
 * `projections/task-store/attach.ts` has no `serverOptions` member, so no code can pass the option.
 */
export type V2TaskStoreServerOption = SdkSurfaceGap<'v2 2.0.0 deleted ServerOptions.taskStore and every tasks/* handler, and a v2 server IGNORES the option silently — the store contract lives at ../task-store/port.ts and the attach seam at ../task-store/attach.ts'>;

export function createV2McpServer(
  ...args: ConstructorParameters<typeof SdkV2McpServer>
): V2McpServer {
  return new SdkV2McpServer(...args);
}

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
 * A v2 in-memory linked pair. The function returns both halves from one call, so the seam
 * cannot build a pair with halves from two generations.
 */
export function createV2LinkedTransportPair(): readonly [
  V2InMemoryTransport,
  V2InMemoryTransport,
] {
  return SdkV2InMemoryTransport.createLinkedPair();
}

/**
 * Connects a v2 server to a v2 transport. The `connect` parameter of the SDK has no brand, so a
 * direct call accepts a transport of the other generation. This function makes that a compile error.
 */
export async function connectV2Server(
  server: V2McpServer | V2Server,
  transport: V2Transport,
): Promise<void> {
  await server.connect(transport);
}

/** Connects a v2 client to a v2 transport, with the same compile-time check as {@link connectV2Server}. */
export async function connectV2Client(
  client: V2Client,
  transport: V2Transport,
  ...rest: DropFirst<Parameters<SdkV2Client['connect']>>
): Promise<void> {
  await client.connect(transport, ...rest);
}

/** All elements of `T` except the first. It forwards optional tails. */
type DropFirst<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest]
  ? Rest
  : [];

/**
 * The v2 task status values, read from the runtime `TaskStatusSchema` enum of
 * `@modelcontextprotocol/core`. A test compares them with `TERMINAL_TASK_STATUSES` in
 * `projections/task-store/port.ts`, so a v2 release that adds or renames a status fails that test.
 *
 * The type is `readonly string[]` because callers test arbitrary strings from durable events.
 * A literal union forces a cast at each call site.
 */
export const V2_TASK_STATUS_VALUES: readonly string[] = SdkV2TaskStatusSchema.options;

/**
 * The v2 `McpServer` class object, for prototype instrumentation such as
 * `vi.spyOn(McpServer.prototype, 'registerTool')`. Use the factories to build an instance.
 * `new V2_MCP_SERVER_CLASS(...)` gives an unbranded instance. The pairing functions still reject
 * a transport of the other generation.
 */
export const V2_MCP_SERVER_CLASS: typeof SdkV2McpServer = SdkV2McpServer;

/** The low-level v2 `Server` class object. @see V2_MCP_SERVER_CLASS */
export const V2_SERVER_CLASS: typeof SdkV2Server = SdkV2Server;

/** The protocol version the v2 SDK advertises. */
export const V2_LATEST_PROTOCOL_VERSION: string = SDK_V2_LATEST_PROTOCOL_VERSION;

/**
 * A v2 notification method name. v2 `setNotificationHandler` takes the method string, not a
 * Zod schema. One constant per method name keeps the string in one place, because a typo
 * gives a handler that never fires.
 */
export const V2_ROOTS_LIST_CHANGED_NOTIFICATION_METHOD = 'notifications/roots/list_changed';
export const V2_ELICIT_REQUEST_METHOD = 'elicitation/create';
