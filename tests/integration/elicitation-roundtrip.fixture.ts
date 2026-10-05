/**
 * Shared fixture for the elicitation round-trip tests: accept, decline and capability absent.
 * It connects an in-process MCP client and server over a linked in-memory transport pair.
 * The fixture owns the transport, the lifecycle and the event store, so each test covers only the round trip.
 *
 * - The `EventStore` is SQLite-backed, so each pair gets a new store in a temp directory.
 * - The dispatch context carries a `capabilityResolver`. At `oninitialized`, `createMcpServer` snapshots the client capabilities into it.
 *   Without the resolver, the dispatch gate never reads `isElicitationDeclared() === true`.
 * - With `clientCapabilities.elicitation`, the client registers a request handler that forwards to `elicitInputHandler`.
 *   With no such capability, the client registers no handler, as a real client without elicitation support.
 */

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
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/**
 * The form-mode elicitation request parameters that the mock handler receives.
 * It is the form-mode request shape of the SDK, narrowed to the fields that the dispatcher sends.
 * `requestedSchema` is a JSON Schema fragment for the missing field. Its `properties` show which field the server asks for.
 */
export interface ElicitInputParams {
  readonly message: string;
  readonly mode?: 'form';
  readonly requestedSchema: Record<string, unknown>;
}

/**
 * The answer of the mock handler to the elicitation request, in the shape of the SDK elicit result.
 * - `accept` with `content`: gives the field value. The dispatcher reads `content[<missingField>]`.
 * - `decline` or `cancel`: the dispatch helper emits `elicitation.declined`, not `elicitation.fulfilled`.
 */
export interface ElicitInputResult {
  readonly action: 'accept' | 'decline' | 'cancel';
  readonly content?: Record<string, unknown>;
}

/** The options of {@link createElicitationTestPair}. */
export interface ElicitationTestPairOpts {
  /**
   * The capabilities that the test client declares at the initialize handshake.
   * With `elicitation` present, even as `{}`, the resolver records it and the dispatch gate opens.
   * With `elicitation` absent, a missing required field gives `INVALID_INPUT`.
   */
  readonly clientCapabilities?: {
    readonly elicitation?: Record<string, never>;
  };
  /**
   * The mock handler that answers the form in place of a user or an agent.
   * When the caller declares elicitation and gives no handler, the fixture uses one that returns `{ action: 'decline' }`.
   * Thus a test with no mock fails with `INVALID_INPUT`, and does not hang on an open request.
   */
  readonly elicitInputHandler?: (
    params: ElicitInputParams,
  ) => Promise<ElicitInputResult>;
}

/**
 * A connected in-process MCP pair and the event store of the server.
 * A test calls `client.callTool(...)`, then asserts on `structuredContent` and on `eventStore.query('elicitation/<operationId>')`.
 */
export interface ElicitationTestPair {
  readonly client: V2Client;
  /** The low-level SDK server, from `McpServer.server`. */
  readonly server: V2Server;
  /** A new store for each pair, so a stream holds only the events of one test. */
  readonly eventStore: EventStore;
  readonly cleanup: () => Promise<void>;
}

/**
 * Builds an in-process MCP client and server pair for the form-mode elicitation round trip.
 * The server is the production `createMcpServer(ctx)`, and only the transport differs.
 * The SDK runs the initialize handshake during the client connect, so the capability snapshot exists before the first `tools/call`.
 *
 * The request handler key is the method name `V2_ELICIT_REQUEST_METHOD`.
 * The handler does not check the params at runtime, because the dispatcher sends only form mode.
 * Its result takes a cast, because the SDK result type is discriminated on `action`.
 *
 * Always call `cleanup()` after a test. It closes the client and the store, then removes the temp directory.
 * On Windows an open SQLite handle blocks the unlink of the database file.
 * `cleanup` ignores a close error for a client or transport that is already closed, and throws any other error.
 */
export async function createElicitationTestPair(
  opts: ElicitationTestPairOpts,
): Promise<ElicitationTestPair> {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'elicitation-roundtrip-test-'),
  );
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();

  const capabilityResolver = createInMemoryResolver([]);

  const ctx: DispatchContext = {
    stateDir: tmpDir,
    eventStore,
    enableTelemetry: false,
    capabilityResolver,
  };

  const mcpServer = createMcpServer(ctx);

  const [clientTransport, serverTransport] = createV2LinkedTransportPair();

  const client = createV2Client(
    { name: 'elicitation-roundtrip-test', version: '1.0.0' },
    { capabilities: opts.clientCapabilities ?? {} },
  );

  if (opts.clientCapabilities?.elicitation !== undefined) {
    const handler =
      opts.elicitInputHandler ?? (async () => ({ action: 'decline' as const }));

    client.setRequestHandler(V2_ELICIT_REQUEST_METHOD, async (request) => {
      const params = request.params as unknown as ElicitInputParams;
      const result = await handler(params);
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
    eventStore.close();
    await rmrfAsync(tmpDir);
  };

  return {
    client,
    server: mcpServer.server,
    eventStore,
    cleanup,
  };
}
