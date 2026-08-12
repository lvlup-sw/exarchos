/**
 * The Tasks-store ATTACH seam — how a store reaches a server, per SDK
 * generation (DR-0, task 051).
 *
 * ── The failure this module exists to make impossible ───────────────────────
 * Under v1, one constructor option did two things at once:
 *
 *     new McpServer(info, { capabilities: { tasks: … }, taskStore })
 *
 * it bound the store (persistence) **and** lit up `tasks/get`, `tasks/result`,
 * `tasks/list` and `tasks/cancel` on the wire (protocol). Because one option
 * carried both, nobody had to notice they were two guarantees.
 *
 * v2 `2.0.0` removed the option and the handlers. The dangerous part is HOW:
 *
 *   • a v2 `McpServer` handed a `taskStore` option **accepts it silently** — no
 *     throw, no warning, the key is simply ignored (measured against
 *     `@modelcontextprotocol/server@2.0.0`);
 *   • the store then still works perfectly, because its persistence was never
 *     the SDK's;
 *   • and every `tasks/*` request answers `-32601 Method not found`.
 *
 * So the naive migration produces a server that looks wired, is wired for
 * persistence, and is dark on the wire. That is a silent degradation, and a
 * seam whose v2 branch is "the same shape minus one field" would reproduce it
 * exactly.
 *
 * ── The construction ────────────────────────────────────────────────────────
 * The two generations therefore get two DIFFERENT return types, not one type
 * with an optional field:
 *
 *   • {@link attachTaskStoreToV1} returns {@link SdkServedTaskStoreAttachment},
 *     which carries `serverOptions` — spread it into the v1 constructor.
 *   • {@link attachTaskStoreToV2} returns {@link TaskStoreAttachment}, which
 *     has **no `serverOptions` at all**. There is nothing to spread, so the
 *     checker refuses the pretence rather than the reviewer having to catch it.
 *
 * Both carry `store`, because the event-sourced guarantee is generation-
 * independent. Both carry `hostMustServe`: empty on v1, all four methods on v2.
 * A non-empty `hostMustServe` is the wire gap **as a value** — enumerable,
 * loggable, assertable — instead of an absence nobody can observe until a
 * client polls.
 *
 * ── What this module does NOT do ────────────────────────────────────────────
 * It does not serve `tasks/*` on v2. Re-implementing those handlers is a
 * decision about owning a protocol surface the SDK abandoned and the
 * `2026-07-28` revision is deleting (`tasks/result` and `tasks/list` are
 * removed; the feature moves out of core into an extension). That decision is
 * escalated, not made here. This module's job is to guarantee the decision
 * cannot be made by accident.
 */

import type { SdkGeneration } from '../../sdk/brand.js';

/**
 * The `tasks/*` JSON-RPC methods v1's SDK answers from an injected store, and
 * which v2 answers not at all.
 *
 * This list is a DECLARATION and is deliberately not derived from either SDK —
 * deriving it would make the test that compares it against a live v2 server's
 * responses a comparison of one authority with itself. The comparison is the
 * point: `TaskStoreSeam_V2Server_PreservesEventSourcedPersistence` drives each
 * of these against a real v2 `McpServer` and requires `-32601` from every one,
 * so a future v2 release that restores any of them turns the suite RED instead
 * of leaving a stale list in place.
 *
 * `2026-07-28` note: `tasks/result` and `tasks/list` are being REMOVED from the
 * spec and the whole feature relocated to an extension (DR-23 amends INV-5b for
 * this). They are listed here because they describe what v1 serves TODAY — this
 * is a statement about the installed SDKs, not a design target.
 */
export const SDK_TASK_WIRE_METHODS: readonly string[] = [
  'tasks/get',
  'tasks/result',
  'tasks/list',
  'tasks/cancel',
];

/**
 * A store bound to a server, plus an honest account of what the SDK of that
 * generation will and will not serve from it.
 */
export interface TaskStoreAttachment<TStore> {
  /** Which SDK generation this attachment was computed for. */
  readonly generation: SdkGeneration;
  /**
   * The store itself — present on BOTH generations. Event-sourced persistence
   * comes from `EventStore`, not from the SDK, so it survives the migration
   * unchanged. Dispatch (`ctx.taskStore`) and the CLI `--follow` loop consume
   * it directly and never went through the SDK at all.
   */
  readonly store: TStore;
  /** Wire methods this generation's SDK answers from `store`. */
  readonly sdkServedMethods: readonly string[];
  /**
   * Wire methods that answer `-32601` unless the host serves them itself.
   * Empty on v1; every entry of {@link SDK_TASK_WIRE_METHODS} on v2.
   */
  readonly hostMustServe: readonly string[];
}

/**
 * A v1 attachment. The extra `serverOptions` member is the whole difference
 * between the generations, and it exists on this type ONLY — see the module
 * docblock for why that asymmetry is the mechanism rather than an oversight.
 */
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
 * Attach a store to a **v2** server.
 *
 * Persistence is preserved — `store` is the same event-sourced instance, and
 * every consumer that drives it directly (dispatch's Tasks-augmented branch,
 * the CLI `--follow` loop) is unaffected. What is NOT preserved is the wire:
 * `sdkServedMethods` is empty and `hostMustServe` names all four methods.
 *
 * There is no `serverOptions` to spread, which is the point. A caller that
 * wants the v2 wire surface must serve it, and will find that requirement in
 * the type system rather than in production.
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
 * A one-line operator-facing account of an attachment's wire gap, or
 * `undefined` when there is none.
 *
 * Returned rather than logged so the caller decides the channel (startup warn,
 * doctor finding, test assertion) — and so "there is no gap" is representable
 * as a value instead of as the absence of a log line.
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
