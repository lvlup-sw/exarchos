// Conformance check on the Exarchos `tools/list` wire contract.
//
//   C1. Each advertised schema is native JSON Schema draft-2020-12.
//   C2. An `outputSchema` with a discriminated-union root reaches the wire with `type: 'object'`
//       and with its union branches.
//
// The file states the wire contract. It does not guard an SDK patch, so it stays valid when the
// SDK generation changes. The first block lists the tools of the production adapter. The second
// block registers the production envelope on a bare v2 `McpServer` and reads raw JSON-RPC frames.
// The SDK comes through the seam `src/contract/sdk/seam.ts`, the one module that imports it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import {
  connectV2Client,
  connectV2Server,
  createV2Client,
  createV2LinkedTransportPair,
  createV2McpServer,
} from '../../src/contract/sdk/seam.js';
import { createMcpServer } from '../../src/adapters/mcp/mcp.js';
import { EventStore } from '../../src/events/store.js';
import { TOOL_REGISTRY } from '../../src/registry.js';
import { EnvelopeSchema } from '../../src/contract/schemas/envelope.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * The structural keywords that only draft-2020-12 has. One of them in an emitted schema proves that
 * the wire format is native 2020-12. `prefixItems` is the signal for a tuple, which draft-7 renders
 * as an `items` array.
 */
const DRAFT_2020_12_ONLY_KEYWORDS = [
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
] as const;

/** The name of the tuple fixture tool that the production-adapter block registers. */
const TUPLE_FIXTURE_TOOL = '__conformance_fixture_tuple_tool';
/** The draft-7 rendering of the same tuple. */
const DRAFT_7_TUPLE_SHAPE = {
  type: 'object',
  properties: { coord: { type: 'array', items: [{ type: 'number' }, { type: 'number' }] } },
  $schema: 'http://json-schema.org/draft-07/schema#',
};

interface ToolEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Scans a JSON Schema recursively for a keyword that only draft-2020-12 has. It returns the first
 * keyword that it finds, or `undefined`.
 */
function findDraft2020Keyword(schema: unknown): string | undefined {
  if (Array.isArray(schema)) {
    for (const item of schema) {
      const hit = findDraft2020Keyword(item);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isRecord(schema)) return undefined;
  const obj = schema;
  for (const keyword of DRAFT_2020_12_ONLY_KEYWORDS) {
    if (keyword in obj) return keyword;
  }
  for (const value of Object.values(obj)) {
    const hit = findDraft2020Keyword(value);
    if (hit) return hit;
  }
  return undefined;
}

/** The union branch list of a composed schema root, whichever keyword carries it. */
function unionBranchesOf(schema: Record<string, unknown>): unknown[] | undefined {
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    const members = schema[keyword];
    if (Array.isArray(members)) return members;
  }
  return undefined;
}

/** C1 and C2 on the production adapter (`createMcpServer`). */
describe('tools/list schema conformance — v1 production adapter', () => {
  let tmpDir: string;
  let client: ReturnType<typeof createV2Client>;

  /**
   * The fixture tool has a Zod tuple in its input schema. A tuple renders as `prefixItems` only
   * under draft-2020-12. Thus one `tools/list` entry always holds a 2020-12-only keyword, also when
   * no production tool has a tuple in its input shape.
   */
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-list-2020-12-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
    };

    const server = createMcpServer(ctx);

    server.registerTool(
      TUPLE_FIXTURE_TOOL,
      {
        description: 'Conformance fixture: surfaces a Zod tuple to verify prefixItems emission',
        inputSchema: {
          coord: z
            .tuple([z.number(), z.number()])
            .describe('A 2D coordinate — emitted as prefixItems under 2020-12'),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => ({
        content: [{ type: 'text' as const, text: '{}' }],
      }),
    );

    const [clientTransport, serverTransport] = createV2LinkedTransportPair();
    client = createV2Client({ name: 'tools-list-2020-12-test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([
      connectV2Server(server, serverTransport),
      connectV2Client(client, clientTransport),
    ]);
  });

  /** The hook ignores a failure of `client.close()`, so it always removes the temp directory. */
  afterEach(async () => {
    try {
      await client.close();
    } catch {
    }
    await rmrfAsync(tmpDir);
  });

  async function listTools(): Promise<ToolEntry[]> {
    const { tools } = await client.listTools();
    return tools;
  }

  it('ToolsList_EveryInputSchema_DeclaresDraft2020_12', async () => {
    const tools = await listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.inputSchema, `inputSchema missing on ${t.name}`).toBeDefined();
      expect(
        t.inputSchema?.['$schema'],
        `inputSchema.$schema on ${t.name} must be native 2020-12, got "${String(t.inputSchema?.['$schema'])}"`,
      ).toBe(DRAFT_2020_12);
    }
  });

  /**
   * The silent-drop property. A manifest that drops the discriminated-union `outputSchema` raises no
   * error, so each visible production tool must advertise one.
   */
  it('ToolsList_EveryVisibleProductionTool_AdvertisesOutputSchema', async () => {
    const tools = await listTools();
    const visibleProductionNames = new Set(
      TOOL_REGISTRY.filter((t) => !t.hidden).map((t) => t.name),
    );
    const productionTools = tools.filter((t) => visibleProductionNames.has(t.name));
    expect(productionTools.length).toBeGreaterThan(0);
    for (const t of productionTools) {
      expect(
        t.outputSchema,
        `outputSchema missing on production tool ${t.name} — the DU was dropped on the way to the wire`,
      ).toBeDefined();
    }
  });

  it('ToolsList_EveryAdvertisedOutputSchema_DeclaresDraft2020_12', async () => {
    const tools = await listTools();
    const withOutputSchema = tools.filter((t) => t.outputSchema);
    expect(withOutputSchema.length).toBeGreaterThan(0);
    for (const t of withOutputSchema) {
      expect(
        t.outputSchema?.['$schema'],
        `outputSchema.$schema on ${t.name} must be native 2020-12, got "${String(t.outputSchema?.['$schema'])}"`,
      ).toBe(DRAFT_2020_12);
    }
  });

  /**
   * C2. The advertised envelope is a discriminated union, and the MCP manifest needs an object root.
   * The test asserts the root `type` and the branches, because a schema that flattens the union
   * also passes a bare `type` check.
   */
  it('ToolsList_AdvertisedOutputSchemaRoot_HasObjectTypeAndBranches', async () => {
    const tools = await listTools();
    const withOutputSchema = tools.filter((t) => t.outputSchema);
    expect(withOutputSchema.length).toBeGreaterThan(0);
    for (const t of withOutputSchema) {
      const schema = t.outputSchema;
      expect(schema).toBeDefined();
      if (!isRecord(schema)) throw new Error(`outputSchema on ${t.name} is not an object`);
      expect(
        schema['type'],
        `outputSchema.type on ${t.name} must be "object", got ${JSON.stringify(schema['type'])}`,
      ).toBe('object');
      const branches = unionBranchesOf(schema);
      expect(
        branches?.length,
        `outputSchema on ${t.name} lost its union branches — the root marker was ` +
          `achieved by flattening the discriminated union, not by adding a type`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('ToolsList_TupleInputSchema_EmitsPrefixItems', async () => {
    const tools = await listTools();
    const fixture = tools.find((t) => t.name === TUPLE_FIXTURE_TOOL);
    expect(fixture, 'fixture tool missing from tools/list').toBeDefined();
    const keyword = findDraft2020Keyword(fixture?.inputSchema);
    expect(
      keyword,
      `fixture inputSchema did not emit any 2020-12-only structural keyword. ` +
        `If draft-7 is on the wire, tuples render as an \`items\` array — that ` +
        `is the regression signal. Schema received: ${JSON.stringify(fixture?.inputSchema)}`,
    ).toBe('prefixItems');
  });

  /**
   * NEGATIVE TWIN for the detector itself. Without it, a scanner that never returns `undefined`
   * also satisfies each "native 2020-12" assertion. For the draft-7 rendering of the same tuple, the
   * scanner must find nothing.
   */
  it('FindDraft2020Keyword_Draft7TupleRendering_FindsNothing', () => {
    expect(findDraft2020Keyword(DRAFT_7_TUPLE_SHAPE)).toBeUndefined();
    expect(findDraft2020Keyword({ type: 'array', prefixItems: [] })).toBe('prefixItems');
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function idOf(message: unknown): number | undefined {
  if (!isRecord(message)) return undefined;
  const id = message['id'];
  return typeof id === 'number' ? id : undefined;
}

function resultOf(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) return undefined;
  const result = message['result'];
  return isRecord(result) ? result : undefined;
}

async function awaitResponse(inbox: readonly unknown[], id: number): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const hit = inbox.find((message) => idOf(message) === id);
    if (hit !== undefined) return hit;
    await sleep(10);
  }
  throw new Error(`no JSON-RPC response for id ${id} after 2s`);
}

/** The production envelope: the discriminated union that `adapters/mcp/mcp.ts` advertises. */
const LCD_OUTPUT_SCHEMA = EnvelopeSchema(z.unknown());
const LCD_TOOL = '__conformance_lcd_tool';

/**
 * Starts a v2 `McpServer` with the production envelope as `outputSchema` and a tuple in
 * `inputSchema`. It does the handshake with raw JSON-RPC frames and returns the `tools/list`
 * entries. It asserts that `initialize` gives a result, because an empty tool list can also mean
 * that the connection never came up.
 */
async function listToolsUnderV2(): Promise<ToolEntry[]> {
  const server = createV2McpServer({ name: 'tools-list-2020-12-v2', version: '1.0.0' });

  server.registerTool(
    LCD_TOOL,
    {
      description: 'Conformance fixture: the production LCD envelope as outputSchema',
      inputSchema: {
        coord: z
          .tuple([z.number(), z.number()])
          .describe('A 2D coordinate — emitted as prefixItems under 2020-12'),
      },
      outputSchema: LCD_OUTPUT_SCHEMA,
    },
    async () => ({ content: [{ type: 'text' as const, text: '{}' }] }),
  );

  const [host, serverSide] = createV2LinkedTransportPair();
  const inbox: unknown[] = [];
  host.onmessage = (message) => {
    inbox.push(message);
  };
  await connectV2Server(server, serverSide);
  await host.start();

  let nextId = 1;
  const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    await host.send({ jsonrpc: '2.0', id, method, params });
    return awaitResponse(inbox, id);
  };

  const initialized = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'tools-list-2020-12-v2-probe', version: '1.0.0' },
  });
  expect(resultOf(initialized), 'v2 initialize produced no result frame').toBeDefined();
  await host.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const listed = await call('tools/list', {});
  const result = resultOf(listed);
  expect(result, 'v2 tools/list produced no result frame').toBeDefined();
  const tools = result?.['tools'];
  if (!Array.isArray(tools)) throw new Error('v2 tools/list returned no tools array');
  const entries: ToolEntry[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = tool['name'];
    if (typeof name !== 'string') continue;
    entries.push({
      name,
      inputSchema: isRecord(tool['inputSchema']) ? tool['inputSchema'] : undefined,
      outputSchema: isRecord(tool['outputSchema']) ? tool['outputSchema'] : undefined,
    });
  }
  await host.close();
  return entries;
}

/** C1 and C2 on a bare v2 `McpServer` that carries the production envelope. */
describe('tools/list schema conformance — v2 @modelcontextprotocol/server 2.0.0', () => {
  /**
   * v2 puts native draft-2020-12 on the wire with no `target` argument and no post-processing.
   *
   * BLOCKING ARM: each emitted schema declares the 2020-12 `$schema`, and the tuple renders as
   * `prefixItems`. A draft-7 conversion with a 2020-12 URL still emits an `items` array.
   * NEGATIVE TWIN: the same detector finds nothing in the draft-7 rendering of the same tuple.
   * SECOND AUTHORITY: the conversion of the same schema by Zod must agree with the wire on the
   * `$schema` marker and on the tuple rendering. The SDK and Zod are different packages.
   *
   * @kill-seam: a `$schema` string that was relabelled rather than produced by a real draft-2020-12 conversion
   * @oracle-sources: @modelcontextprotocol/server 2.0.0 live wire response, zod 4 z.toJSONSchema
   */
  it('ToolsList_UnderV2_EmitsNative2020_12', async () => {
    const tools = await listToolsUnderV2();
    expect(tools.length).toBeGreaterThan(0);

    const fixture = tools.find((t) => t.name === LCD_TOOL);
    expect(fixture, 'v2 tools/list did not carry the fixture tool').toBeDefined();

    for (const t of tools) {
      expect(
        t.inputSchema?.['$schema'],
        `v2 inputSchema.$schema on ${t.name} must be native 2020-12, got "${String(t.inputSchema?.['$schema'])}"`,
      ).toBe(DRAFT_2020_12);
    }
    expect(
      fixture?.outputSchema?.['$schema'],
      'v2 outputSchema.$schema must be native 2020-12',
    ).toBe(DRAFT_2020_12);

    expect(
      findDraft2020Keyword(fixture?.inputSchema),
      `v2 emitted no 2020-12-only structural keyword for a tuple. Schema received: ` +
        JSON.stringify(fixture?.inputSchema),
    ).toBe('prefixItems');

    expect(findDraft2020Keyword(DRAFT_7_TUPLE_SHAPE)).toBeUndefined();

    const zodEmission = z.toJSONSchema(
      z.object({ coord: z.tuple([z.number(), z.number()]) }),
      { target: 'draft-2020-12', io: 'input' },
    );
    expect(zodEmission.$schema).toBe(fixture?.inputSchema?.['$schema']);
    expect(findDraft2020Keyword(zodEmission)).toBe('prefixItems');
  });

  /**
   * The subject is the production envelope, not a toy union. v2 `registerTool` takes a Zod v4
   * discriminated union as `outputSchema` directly.
   *
   * BLOCKING ARM: the `outputSchema` reaches the wire, has `type: 'object'` at the root, and keeps
   * its union branches.
   * INDEPENDENT ORACLE: the conversion of the same schema by Zod has no root `type`, so the root
   * `type` on the wire comes from the SDK. If the SDK stops adding it, the test fails.
   *
   * @kill-seam: a root `type: "object"` contributed by Zod rather than by the SDK, or one obtained by flattening the discriminated union away
   * @oracle-sources: @modelcontextprotocol/server 2.0.0 live wire response, zod 4 z.toJSONSchema
   */
  it('ToolsList_DiscriminatedUnionRoot_HasObjectType', async () => {
    const zodEmission = z.toJSONSchema(LCD_OUTPUT_SCHEMA, {
      target: 'draft-2020-12',
      io: 'output',
    });
    expect(
      zodEmission.type,
      'Zod now emits a root `type` for a discriminated union by itself, so this ' +
        'test can no longer attribute the wire`s `type: "object"` to the SDK. ' +
        'Re-derive the attribution before trusting the assertion below.',
    ).toBeUndefined();
    expect(unionBranchesOf(zodEmission)?.length).toBeGreaterThanOrEqual(2);

    const tools = await listToolsUnderV2();
    const fixture = tools.find((t) => t.name === LCD_TOOL);
    expect(fixture, 'v2 tools/list did not carry the fixture tool').toBeDefined();

    const schema = fixture?.outputSchema;
    expect(
      schema,
      'v2 dropped the discriminated-union outputSchema — task 049`s registerTool ' +
        'lead does NOT hold and the patch cannot be retired on that basis',
    ).toBeDefined();
    if (!isRecord(schema)) throw new Error('v2 outputSchema is not an object');

    expect(
      schema['type'],
      `v2 must stamp a DU-rooted outputSchema with type "object", got ${JSON.stringify(schema['type'])}`,
    ).toBe('object');

    const branches = unionBranchesOf(schema);
    expect(
      branches?.length,
      'v2 kept the root type but lost the union branches — the marker was ' +
        'achieved by flattening the discriminated union',
    ).toBeGreaterThanOrEqual(2);
  });
});
