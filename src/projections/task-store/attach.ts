/**
 * Attaches a Tasks store to an MCP server, for each SDK generation.
 *
 * In v1, the `taskStore` constructor option binds the store and also serves `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel`.
 * The v2 SDK ignores that option with no error, and each `tasks/*` request answers `-32601 Method not found`.
 * The store still persists, so a naive migration gives a server that looks wired but serves no Tasks method.
 *
 * Thus the two generations get different return types. Only the v1 type has `serverOptions`, so the type checker refuses a v2 spread.
 * Both types carry `store` and `hostMustServe`. A non-empty `hostMustServe` shows the wire gap as a value.
 * This module does not serve `tasks/*` on v2. It only makes the gap visible, so that no caller misses it.
 */

import type { SdkGeneration } from '../../contract/sdk/brand.js';

/**
 * The `tasks/*` JSON-RPC methods that the v1 SDK serves from a store, and that the v2 SDK does not serve.
 * The list is a declaration, not derived from an SDK, so the test against a live v2 server compares two independent sources.
 * `TaskStoreSeam_V2Server_PreservesEventSourcedPersistence` requires `-32601` for each method, so a v2 release that restores one fails the test.
 * The `2026-07-28` spec revision removes `tasks/result` and `tasks/list`. They stay here because the installed v1 SDK serves them.
 */
export const SDK_TASK_WIRE_METHODS: readonly string[] = [
  'tasks/get',
  'tasks/result',
  'tasks/list',
  'tasks/cancel',
];

/** A store bound to a server, and the wire methods that the SDK of that generation serves from it. */
export interface TaskStoreAttachment<TStore> {
  /** Which SDK generation this attachment was computed for. */
  readonly generation: SdkGeneration;
  /**
   * The store, on both generations. Its persistence comes from `EventStore`, not from the SDK.
   * Dispatch (`ctx.taskStore`) and the CLI `--follow` loop use it directly, not through the SDK.
   */
  readonly store: TStore;
  /** Wire methods this generation's SDK answers from `store`. */
  readonly sdkServedMethods: readonly string[];
  /**
   * Wire methods that answer `-32601` unless the host serves them itself.
   * It is empty on v1, and it holds all of {@link SDK_TASK_WIRE_METHODS} on v2.
   */
  readonly hostMustServe: readonly string[];
}

/** A v1 attachment. Only this type has `serverOptions`, so a v2 caller has nothing to spread. */
export interface SdkServedTaskStoreAttachment<TStore>
  extends TaskStoreAttachment<TStore> {
  /**
   * Spread into the v1 `ServerOptions`:
   * `new McpServer(info, { capabilities, ...attachment.serverOptions })`.
   */
  readonly serverOptions: { readonly taskStore: TStore };
}

/**
 * Attach a store to a **v1** server. The SDK serves every method in
 * {@link SDK_TASK_WIRE_METHODS} from it, so `hostMustServe` is empty.
 */
export function attachTaskStoreToV1<TStore>(
  store: TStore,
): SdkServedTaskStoreAttachment<TStore> {
  return {
    generation: 'v1',
    store,
    serverOptions: { taskStore: store },
    sdkServedMethods: SDK_TASK_WIRE_METHODS,
    hostMustServe: [],
  };
}

/**
 * Attaches a store to a v2 server. The store persists as before, and its direct consumers do not change.
 * `sdkServedMethods` is empty and `hostMustServe` names all four methods.
 * The result has no `serverOptions`, so a caller that wants the v2 wire surface must serve it.
 */
export function attachTaskStoreToV2<TStore>(
  store: TStore,
): TaskStoreAttachment<TStore> {
  return {
    generation: 'v2',
    store,
    sdkServedMethods: [],
    hostMustServe: SDK_TASK_WIRE_METHODS,
  };
}

/**
 * Returns a one-line operator message about the wire gap of an attachment, or `undefined` when there is no gap.
 * It returns the message and does not log it, so the caller picks the channel.
 */
export function describeTaskWireGap<TStore>(
  attachment: TaskStoreAttachment<TStore>,
): string | undefined {
  if (attachment.hostMustServe.length === 0) return undefined;
  return (
    `MCP SDK ${attachment.generation} serves no Tasks methods: ` +
    `${attachment.hostMustServe.join(', ')} answer -32601 unless this server ` +
    `registers handlers for them. Task state itself remains durable and ` +
    `event-sourced — only the wire surface is absent.`
  );
}
