// ─── T3 / #1436 — Elicitation form-mode E2E fixture ─────────────────────────
//
// Shared test infrastructure for the three elicitation-roundtrip path tests
// (accept / decline / capability-absent — T4, T5, T6). Wires an in-process
// MCP client + server pair via the SDK's `InMemoryTransport`, matching the
// pattern already established by `cli-parity.test.ts` and
// `tools-list.test.ts`. The fixture is intentionally narrow: it owns the
// transport/lifecycle wiring AND the event-store substrate, so each path
// test can focus on the round-trip semantics.
//
// Per design `docs/designs/archive/2026-05-17-preview-4-substrate-realization.md`
// §4.1, the fixture closes the verification gap from PR #1424: the
// elicitation form-mode plumbing landed but no test exercised the full path
// against a real MCP client. T4/T5/T6 consume this fixture to cover all
// three paths.
//
// Implementation notes:
//
//   • The fresh EventStore lives under a temp directory (mirroring the
//     existing integration-test convention — `EventStore` is SQLite-backed
//     and a per-test temp directory gives us isolation without a special
//     in-memory mode).
//
//   • The `capabilityResolver` is wired into the dispatch context so the
//     server's `oninitialized` hook (`adapters/mcp.ts:298-326`) snapshots
//     the client's declared capabilities. Without this resolver, the
//     dispatch-side gate at `dispatch/core/dispatch.ts:813` would never observe
//     `isElicitationDeclared() === true` and the elicitation branch would
//     stay dark even with the SDK plumbing fully wired.
//
//   • When the caller provides `clientCapabilities.elicitation`, the client
//     registers a `setRequestHandler(ElicitRequestSchema, …)` that forwards
//     to the caller's `elicitInputHandler`. When the caller omits the
//     capability, the handler is NOT registered — this mirrors how real
//     clients that don't support elicitation simply don't advertise it.

import {
  createV2Client,
  createV2LinkedTransportPair,
  connectV2Client,
  connectV2Server,
  V2_ELICIT_REQUEST_METHOD,
  type V2Client,
  type V2Server,
} from '../../src/contract/sdk/seam.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMcpServer } from '../../src/adapters/mcp/mcp.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';

// ─── Public surface ────────────────────────────────────────────────────────

/**
 * MCP form-mode elicitation request parameters as the test's mock handler
 * receives them from the SDK. Mirrors `ElicitRequestFormParamsSchema` (see
 * `@modelcontextprotocol/sdk/types.d.ts` line 4966) but narrowed to the
 * fields the dispatcher actually surfaces — keeps the test-author surface
 * compact without dragging the SDK's full discriminated-union shape into
 * fixture consumers.
 *
 * `requestedSchema` is the dispatcher's `.pick({<field>: true})` shape
 * (a Record-shaped JSON Schema fragment); fixture consumers can inspect
 * `requestedSchema.properties` to confirm which field is being elicited.
 */
export interface ElicitInputParams {
  readonly message: string;
  readonly mode?: 'form';
  readonly requestedSchema: Record<string, unknown>;
}

/**
 * Mock-client response shape — what the test's `elicitInputHandler` returns
 * to fulfill (or decline) the server's elicitation request. Mirrors the
 * SDK's `ElicitResultSchema` (`@modelcontextprotocol/sdk/types.d.ts:5381`):
 *
 *   • `action: 'accept'` + `content` — supplies the field value(s). The
 *     dispatcher reads `content[<missingField>]` after the round-trip.
 *   • `action: 'decline'` / `'cancel'` — the dispatch helper treats both
 *     as un-fulfilled and emits `elicitation.declined` rather than
 *     `elicitation.fulfilled` (see `dispatch/elicitation-dispatch.ts:122-126`).
 */
export interface ElicitInputResult {
  readonly action: 'accept' | 'decline' | 'cancel';
  readonly content?: Record<string, unknown>;
}

/**
 * Caller-supplied client capabilities. When `elicitation` is present (even
 * as `{}`), the resolver snapshots it during the initialize handshake and
 * the dispatch-side gate opens. When absent, the dispatcher falls back to
 * the legacy INVALID_INPUT path on missing required fields.
 */
export interface ElicitationTestPairOpts {
  /** Capabilities the test client advertises during the initialize handshake. */
  readonly clientCapabilities?: {
    readonly elicitation?: Record<string, never>;
  };
  /**
   * Mock handler that stands in for the user / agent fulfilling the form.
   * Required only when `clientCapabilities.elicitation` is declared. If
   * omitted while elicitation IS declared, the fixture wires a default
   * handler that returns `{ action: 'decline' }` so unmocked tests fail
   * loudly rather than silently round-tripping.
   */
  readonly elicitInputHandler?: (
    params: ElicitInputParams,
  ) => Promise<ElicitInputResult>;
}

/**
 * Wired in-process MCP pair plus the substrate the server is bound to.
 * Consumers exercise the round-trip via `client.callTool(...)`, then assert
 * envelope outcome via the returned `structuredContent` AND event-store
 * truth via `eventStore.query('elicitation/<operationId>')`.
 */
export interface ElicitationTestPair {
  readonly client: V2Client;
  readonly server: V2Server;
  readonly eventStore: EventStore;
  readonly cleanup: () => Promise<void>;
}

// ─── Fixture factory ───────────────────────────────────────────────────────

/**
 * Build an in-process MCP client + server pair that exercises the
 * elicitation form-mode round-trip end-to-end. The server is the same
 * `createMcpServer(ctx)` production carrier consumed by `index.ts`, so
 * the path under test is the production path; only the transport is
 * substituted (`InMemoryTransport` instead of stdio/HTTP).
 *
 * The returned `server` is the low-level `Server` (SDK type) accessed via
 * `McpServer.server` — convenient for tests that want to inspect or stub
 * lifecycle hooks. The `eventStore` is fresh per call; queries against
 * `elicitation/<operationId>` streams will contain only events emitted by
 * the test under inspection.
 *
 * Always call `cleanup()` in `afterEach` (closes the client, drops the
 * temp directory). Failing to do so leaks the SQLite handle and the temp
 * directory, which compounds across the test suite.
 */
export async function createElicitationTestPair(
  opts: ElicitationTestPairOpts,
): Promise<ElicitationTestPair> {
  // EventStore substrate — fresh SQLite per call, lives under a temp
  // directory. Matches the convention in `tools-list.test.ts` and
  // `cli-parity.test.ts` (the integration suite's idiom for per-test
  // isolation; `EventStore` does not currently expose an explicit
  // `:memory:` mode).
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'elicitation-roundtrip-test-'),
  );
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();

  // CapabilityResolver wiring — the dispatch-side elicitation gate at
  // `dispatch/core/dispatch.ts:813` reads `ctx.capabilityResolver?.isElicitationDeclared()`.
  // Without a resolver on the dispatch context, that branch can never open
  // even if the client declares the capability. `createMcpServer` wires
  // `server.oninitialized` to snapshot the client's capabilities into the
  // resolver during the initialize handshake (see `adapters/mcp.ts:298-326`).
  const capabilityResolver = createInMemoryResolver([]);

  const ctx: DispatchContext = {
    stateDir: tmpDir,
    eventStore,
    enableTelemetry: false,
    capabilityResolver,
  };

  const mcpServer = createMcpServer(ctx);

  // Transport pair — both halves of an in-memory channel. The server
  // attaches first via `connect(serverTransport)`, then the client
  // attaches to its half; the SDK runs the initialize handshake during
  // `client.connect(...)` so the capability snapshot fires before the
  // first `tools/call` lands.
  const [clientTransport, serverTransport] = createV2LinkedTransportPair();

  // Build the client with the caller's declared capabilities. The
  // capability shape (`elicitation: {}` vs absent) determines whether the
  // server's elicitation branch lights up — that's the discriminator the
  // T4 / T5 / T6 path tests pivot on.
  const client = createV2Client(
    { name: 'elicitation-roundtrip-test', version: '1.0.0' },
    { capabilities: opts.clientCapabilities ?? {} },
  );

  // Client-side elicitation handler wiring. When the caller declared
  // `elicitation: {}`, attach a `setRequestHandler(ElicitRequestSchema, …)`
  // that forwards to the test's mock. When the caller did NOT declare
  // elicitation, DO NOT register a handler — this mirrors real clients
  // that don't support elicitation simply not advertising it (and the
  // server's dispatch-side gate stays closed regardless of any client
  // handler).
  if (opts.clientCapabilities?.elicitation !== undefined) {
    // Default to a `decline` response when the caller omits a handler so
    // an unmocked test fails loudly (envelope is `INVALID_INPUT` + the
    // `elicitation.declined` event lands) rather than hanging on an
    // un-resolved transport request.
    const handler =
      opts.elicitInputHandler ?? (async () => ({ action: 'decline' as const }));

    // v2 keys request handlers by METHOD NAME rather than v1's Zod schema; the
    // request type is resolved from the SDK's own `RequestTypeMap`.
    client.setRequestHandler(V2_ELICIT_REQUEST_METHOD, async (request) => {
      // The SDK validates incoming requests against the union of
      // form-mode + URL-mode params; the dispatcher only emits form-mode
      // today, so we narrow without runtime checks here (a mismatch
      // would be a substrate bug T4/T5/T6 should catch).
      const params = request.params as unknown as ElicitInputParams;
      const result = await handler(params);
      // `ElicitResultSchema` accepts `accept | decline | cancel`. The
      // structural cast is necessary because the SDK's result shape is
      // discriminated on `action` and not all branches carry `content`.
      return {
        action: result.action,
        ...(result.content !== undefined ? { content: result.content } : {}),
      } as Awaited<ReturnType<Parameters<V2Client['setRequestHandler']>[1]>>;
    });
  }

  await Promise.all([
    connectV2Server(mcpServer, serverTransport),
    connectV2Client(client, clientTransport),
  ]);

  const cleanup = async (): Promise<void> => {
    try {
      await client.close();
    } catch (err) {
      // The SDK / InMemoryTransport surface a few benign signals during
      // teardown (e.g., double-close after a test path that already closed
      // the client; pending request rejection when the transport tears down
      // mid-flight). Those are idempotent / expected. Anything else is a
      // real teardown failure and must surface — silently swallowing it
      // masks resource leaks and substrate regressions.
      const message = err instanceof Error ? err.message : String(err);
      const isBenign =
        /already closed/i.test(message) ||
        /not connected/i.test(message) ||
        /transport.*closed/i.test(message) ||
        /connection closed/i.test(message);
      if (!isBenign) {
        throw err;
      }
    }
    // Release the SQLite handle before removing the dir: on Windows (NTFS) an
    // open handle blocks unlink of exarchos.db (EBUSY). EventStore.close() is
    // idempotent; the `:memory:`-mode gap the header notes is moot once the
    // handle is closed.
    eventStore.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };

  return {
    client,
    server: mcpServer.server,
    eventStore,
    cleanup,
  };
}
