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
 * `../architecture/sdk-generation-seam.ts` (rung-3 mixing lint, task 049) and by
 * `../architecture/layer-boundaries-seam.ts`'s `SDK_SEAM_BOUNDARY` rule (task
 * 053), which rejects a direct SDK import from any module but this one. This
 * file provides the type-level half; those provide the import-level half. See
 * `./brand.ts` for why neither subsumes the other.
 *
 * **The property now HOLDS, measured rather than asserted.** Task 053 migrated
 * the whole backlog — 42 direct import sites across 22 files in 9 directories,
 * 10 of them non-test — onto this module.
 * `SdkSeam_MigratedTree_ResolvesEverySiteThroughSeam` walks the tree and asserts
 * that the set of modules importing an MCP SDK package is exactly
 * `{sdk/seam.ts}`. The rule's falsifier
 * (`SdkSeam_DirectSdkImport_FailsSeamRule`) is kept alive separately, because
 * "zero violations" over a migrated tree is otherwise indistinguishable from a
 * rule that cannot fire.
 *
 * ── The Tasks store surface, and where it went (task 051 FILLED these) ──────
 * v2 `2.0.0` DELETED the experimental Tasks store seam: no
 * `ServerOptions.taskStore`, and zero matches for `TaskStore` /
 * `CreateTaskOptions` / `isTerminal` in either v2 package. Task 052 left three
 * uninhabited {@link SdkSurfaceGap} holes here rather than invent replacements.
 * Task 051 filled them, and the fill is a RELOCATION rather than a re-export:
 *
 *   • `TaskStore`        → `../task-store/port.ts` `TaskStorePort`
 *   • `CreateTaskOptions`→ `../task-store/port.ts` `CreateTaskParams`
 *   • `isTerminal`       → `../task-store/port.ts` `isTaskTerminal`
 *
 * Those are OWNED and generation-neutral, so they are deliberately NOT
 * re-exported from this module: routing them through the SDK seam would claim
 * they are drawn from a generation, and they are not drawn from either. The one
 * gap that remains genuinely absent — and stays represented as a hole — is
 * {@link V2TaskStoreServerOption}, because a v2 server handed a `taskStore`
 * option **ignores it silently** (measured), which is the sharpest edge in this
 * whole migration. `../task-store/attach.ts` is the seam that makes that
 * silence impossible to ship.
 *
 * What this module DOES contribute to the Tasks story is vocabulary the SDKs
 * still own: {@link isV1TaskTerminal} (the v1 oracle the owned predicate is
 * differentially tested against) and {@link V2_TASK_STATUS_VALUES} (v2's own
 * runtime status enum). Two packages, two authorities, so the equivalence test
 * has something that can genuinely disagree.
 *
 * {@link V2Client} and {@link V2StdioClientTransport} remain holes for an
 * unrelated reason: the v2 client package is simply not installed.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * The re-exported surface is the surface the package actually uses. Task 053
 * moved every call site onto it and needed exactly one addition to do so — the
 * two class objects below, for prototype-level spying, which no factory can
 * serve. Nothing else in this API was reshaped by the migration.
 *
 * The v1 half is now fully consumed. The v2 half is not, and that is not an
 * over-export: v2 has ZERO import sites anywhere in the tree because task 049's
 * source migration is deliberately held until this seam is the only door. See
 * the note on {@link createV2Server}.
 */

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
import { TaskStatusSchema as SdkV2TaskStatusSchema } from '@modelcontextprotocol/core';
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
/**
 * The v1 experimental Tasks store contract.
 *
 * ── OVER-EXPORT, reported by task 053 rather than papered over ──────────────
 * This has no consumer and structurally cannot gain one: task 051 relocated the
 * store contract to `../task-store/port.ts` (`TaskStorePort`) because v2 deleted
 * the SDK interface outright, and every implementation now declares against the
 * OWNED port. So `knip` reporting this dead is correct, and it is a genuine
 * over-export by the seam — NOT a site task 053's migration missed.
 *
 * Left in place rather than deleted, deliberately: it is the v1 half of the
 * v1↔v2 gap table that {@link V2TaskStoreServerOption} still documents, and
 * removing one half of a documented pair mid-wave is a worse artifact than a
 * reported finding. Whoever closes DR-0's source migration (task 049) should
 * delete this and {@link V1CreateTaskOptions} together with the v1 dependency.
 */
export type V1TaskStore = V1<SdkV1TaskStore>;
/** v1 task-creation options. Same over-export finding as {@link V1TaskStore} — superseded by `../task-store/port.ts`'s owned `CreateTaskParams`. */
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

// ── Typed holes: surfaces v2 2.0.0 does not have ─────────────────────────────

/**
 * There is no v2 `ServerOptions.taskStore`, and — measured against
 * `@modelcontextprotocol/server@2.0.0` — passing one anyway is **ignored
 * silently**: no throw, no warning, the key is dropped and every `tasks/*`
 * request thereafter answers `-32601`. That is why this stays an uninhabited
 * hole even though the store CONTRACT was successfully relocated: the contract
 * has an owned replacement (`../task-store/port.ts`), the constructor option
 * has none, and conflating the two is exactly how a migration ships a server
 * that is persistent and dark at the same time.
 *
 * `../task-store/attach.ts` is the seam that acts on this: its v2 attachment
 * type has no `serverOptions` member to spread, so there is nothing to hand the
 * v2 constructor in the first place.
 *
 * Renamed from task 052's `V2TaskStore` because the thing that is missing is
 * the OPTION, not the contract — the old name asserted the contract had no v2
 * counterpart, which stopped being true once the contract became ours.
 */
export type V2TaskStoreServerOption = SdkSurfaceGap<'v2 2.0.0 deleted ServerOptions.taskStore and every tasks/* handler, and a v2 server IGNORES the option silently — the store contract lives at ../task-store/port.ts and the attach seam at ../task-store/attach.ts'>;

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

/**
 * ── OVER-EXPORT, reported by task 053 ───────────────────────────────────────
 * Nothing in the tree CONSTRUCTS a v1 low-level `Server`. The adapter reaches
 * one only as `mcpServer.server` (an accessor on an already-built `McpServer`),
 * the elicitation fixture wants it as a TYPE ({@link V1Server}), and the one
 * test that wants the class wants its PROTOTYPE ({@link V1_SERVER_CLASS}).
 * Three distinct needs, none of them a constructor.
 *
 * So `knip` is right that this is unreferenced, and the cause is the seam
 * over-exporting by symmetry with {@link createV1McpServer} — not a call site
 * task 053 failed to migrate. Kept for now because deleting it while task 049
 * is held would churn the constructor family the seam's shape is built around;
 * recorded here so the next runner does not have to re-derive the reason.
 */
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

/**
 * ── Why the v2 half has no callers, and why that is not dead code ────────────
 * Task 053 drove the v1 half to full consumption but could not touch this one:
 * **v2 has zero import sites anywhere in the tree.** v2 is installed, not used
 * (measured — see the spec's Open Question 7). That is deliberate sequencing,
 * not oversight: task 049's source migration is held until every site imports
 * through this seam, precisely so that changing generation becomes a change to
 * ONE module instead of a change to 22.
 *
 * So this surface is a mechanism that ships before its caller — R-11's exact
 * shape — and `scripts/validate-no-legacy.sh` is CORRECT to say so. The honest
 * discharge is task 049 wiring the caller, not an allowlist entry here. Task
 * 053 reported it per-symbol rather than papering over it.
 */
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

/**
 * v1 `isTerminal` — is a task status a terminal state?
 *
 * Retained deliberately after task 051 relocated the predicate to
 * `../task-store/port.ts`. This is now the **oracle**: the owned
 * `isTaskTerminal` is differentially compared against it over v2's full status
 * vocabulary by `TaskStoreSeam_TerminalStateQuery_MatchesV1Semantics`. Keeping
 * the v1 function reachable is what stops that test from comparing the
 * replacement with itself.
 */
export function isV1TaskTerminal(status: V1TaskStatus): boolean {
  return sdkV1IsTerminal(status);
}

/**
 * v2's own task-status vocabulary, read from `@modelcontextprotocol/core`'s
 * runtime `TaskStatusSchema` enum rather than restated.
 *
 * A *runtime* value, not a type: the equivalence test needs a population it can
 * iterate, and a type union cannot be iterated. Because it comes from a
 * different npm package than {@link isV1TaskTerminal}, the two are genuinely
 * independent authorities — a v2 release that adds or renames a status makes
 * this list grow and the agreement assertion fail, which is the intended
 * signal rather than a nuisance.
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
// production path calls through — and there are six such call sites across
// `adapters/mcp.test.ts` and `registration-parity.test.ts`. Before task 053 they
// reached it by importing `@modelcontextprotocol/sdk/server/{mcp,index}.js`
// directly, which is exactly the bypass DR-26 forbids. A seam that cannot
// supply a surface its own tree uses is not "the sole importer"; it is a seam
// with a hole and an exemption list.
//
// WHAT THIS COSTS, stated rather than glossed: `new V1_MCP_SERVER_CLASS(...)`
// yields an UNBRANDED instance, so it is not the branded construction route.
// That costs nothing the brand was already buying — `src/sdk/brand.ts` declares
// `__gen` optional precisely so an unbranded value is admitted by either
// generation's position, and every existing raw SDK value in the tree is
// already unbranded. The rung-2 guarantee lives on the *pairing* functions
// (`connectV1Server` and friends), which these do not weaken. What the seam
// gains is the import-level half: nothing outside this module names the SDK.
export const V1_MCP_SERVER_CLASS: typeof SdkV1McpServer = SdkV1McpServer;

/** @see V1_MCP_SERVER_CLASS — the low-level v1 `Server` counterpart. */
export const V1_SERVER_CLASS: typeof SdkV1Server = SdkV1Server;

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
