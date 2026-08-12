// ─── tools/list schema CONFORMANCE (DR-0) ───────────────────────────────────
//
// WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT.
//
// It is a **conformance check on the Exarchos `tools/list` wire contract**:
//
//   C1. every advertised schema is native JSON Schema draft-2020-12, and
//   C2. a discriminated-union-rooted `outputSchema` reaches the wire carrying
//       `type: 'object'` with its union branches intact.
//
// It is NOT a guard for `patches/@modelcontextprotocol+sdk+1.29.0.patch`.
// That distinction is the whole point of task 050. A test that exists only to
// prove a patch is applied dies with the patch; a test that states the wire
// contract outlives whichever SDK generation happens to deliver it. So the two
// properties above are asserted against BOTH installed generations — v1 (the
// generation the production adapter runs on today) and v2 (the generation the
// migration is heading for). When task 053 moves `adapters/mcp.ts` onto v2 and
// the patch is deleted, the v2 block below is already green and already the
// contract; only the v1 block goes away with v1.
//
// ── Task 050: the patch decision, and the measurements behind it ────────────
//
// The patch does two things: it forces `target: 'draft-2020-12'`, and it
// splices `type: 'object'` onto DU-rooted schemas (plus the `normalizeObject-
// Schema` change that stops a DU being dropped outright). Three questions were
// measured against the pinned `@modelcontextprotocol/server@2.0.0`, not read
// off release notes:
//
//   Q1. Does v2 emit native 2020-12 by itself?  → YES.
//       `ToolsList_UnderV2_EmitsNative2020_12` below is that measurement.
//       v2 hard-codes `JSON_SCHEMA_CONVERSION_TARGET = 'draft-2020-12'` for
//       every conversion; there is no draft-7 path left to fall back to.
//
//   Q2. Does v2 splice `type: 'object'` onto a DU root by itself?  → YES.
//       `ToolsList_DiscriminatedUnionRoot_HasObjectType` below is that
//       measurement, and it runs against the PRODUCTION LCD envelope rather
//       than a toy union. Note the SEP-2106 nuance: v2 stamps `type:'object'`
//       on an `outputSchema` only when the root is *provably object-shaped*
//       (a DU of objects qualifies); SEP-2106 itself permits any root for
//       `outputSchema`. The v1 patch stamps unconditionally instead. For our
//       LCD the two agree, which is why the wire golden is unmoved.
//
//   Q3. So can the patch be dropped now?  → NO, and this was measured too.
//       Reversing the patch (`npx patch-package --reverse`) and re-running
//       this file plus `tools-list-golden.test.ts` fails 6/6: `$schema` reverts
//       to `http://json-schema.org/draft-07/schema#`, every production tool
//       loses its `outputSchema` entirely, the fixture tuple renders as an
//       `items` array instead of `prefixItems`, and the byte golden diverges.
//       The source tree still runs entirely on v1, so v1's emission IS the
//       wire.
//
// DECISION — the patch is **RE-BASED, not dropped**. Re-based in justification
// rather than in content: it is no longer "a workaround for an unfixed upstream
// bug awaiting an upstream PR", because upstream shipped both fixes in v2
// 2.0.0. It is now a **v1-only backport of v2-native behaviour**, and its death
// condition is the removal of `@modelcontextprotocol/sdk`, not an upstream
// release. `src/__tests__/sdk-patch-policy.test.ts` makes that lifetime
// enforceable instead of merely documented.
//
// Task 049's lead HELD: v2's `registerTool` accepts a Zod v4 discriminated
// union as `outputSchema` directly — no drop to an empty schema, no throw.
//
// Both generations are drawn through the owned SDK seam (`src/contract/sdk/seam.ts`),
// which is the one module permitted to import both; that is what lets a single
// conformance file span the generation boundary without tripping the
// `lintSdkGenerationMixing` rung-3 gate.

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
} from '../../contract/sdk/seam.js';
import { createMcpServer } from '../../adapters/mcp.js';
import { EventStore } from '../../events/store.js';
import { TOOL_REGISTRY } from '../../registry.js';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

// 2020-12-only structural keywords. Any of these in any emitted schema proves
// the wire format is native 2020-12 (draft-7 cannot produce them from Zod's
// JSON-Schema conversion). `prefixItems` is the canonical signal for a tuple —
// draft-7 used per-index `items` arrays instead.
const DRAFT_2020_12_ONLY_KEYWORDS = [
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
] as const;

/** The tuple fixture both generations register, and its draft-7 counter-shape. */
const TUPLE_FIXTURE_TOOL = '__conformance_fixture_tuple_tool';
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
 * Recursively scan a JSON Schema for any draft-2020-12-only structural keyword.
 * Returns the first keyword name encountered, or `undefined` if none appear.
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

// ════════════════════════════════════════════════════════════════════════════
// C1 + C2 against v1 — the generation the production adapter runs on today
// ════════════════════════════════════════════════════════════════════════════

describe('tools/list schema conformance — v1 production adapter', () => {
  let tmpDir: string;
  let client: ReturnType<typeof createV2Client>;

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

    // A fixture tool whose input schema carries a Zod v4 tuple. Tuples render
    // as `prefixItems` only under draft-2020-12 — under draft-7 they render as
    // an `items` array. This guarantees at least one tools/list entry carries a
    // 2020-12-only structural keyword even if no production tool currently
    // exercises tuples at its top-level input shape.
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

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
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

  // The silent-drop property. Unpatched v1 returns `undefined` from
  // `normalizeObjectSchema` for a `ZodDiscriminatedUnion`, skips the
  // `toolDefinition.outputSchema = …` branch entirely, and ships a manifest
  // with no advertised outputSchema at all. Measured: that is exactly what
  // happens with the patch reversed.
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

  // C2 on v1. The advertised LCD is a discriminated union; the MCP manifest
  // requires an object root. Both the root marker AND the surviving branches
  // are asserted — a `type: 'object'` obtained by flattening the union away
  // would satisfy a bare type check while destroying the contract.
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

  // NEGATIVE TWIN for the detector itself. Without this, every "native 2020-12"
  // assertion above rests on a scanner that might simply never return
  // `undefined`. Fed the draft-7 rendering of the SAME tuple, it must find
  // nothing — that is what makes finding `prefixItems` above informative.
  it('FindDraft2020Keyword_Draft7TupleRendering_FindsNothing', () => {
    expect(findDraft2020Keyword(DRAFT_7_TUPLE_SHAPE)).toBeUndefined();
    expect(findDraft2020Keyword({ type: 'array', prefixItems: [] })).toBe('prefixItems');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C1 + C2 against v2 — the generation the migration is heading for.
//
// Driven by raw JSON-RPC frames rather than a `Client`: `@modelcontextprotocol/
// client` is not an installed dependency, and the v1 client must never be
// paired with a v2 server (a cross-generation "linked pair" is not linked at
// all — see `src/contract/sdk/seam.ts`). Raw frames keep the measurement honest and the
// generations apart.
// ════════════════════════════════════════════════════════════════════════════

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

/** The production LCD envelope — the exact DU `adapters/mcp.ts` advertises. */
const LCD_OUTPUT_SCHEMA = EnvelopeSchema(z.unknown());
const LCD_TOOL = '__conformance_lcd_tool';

/**
 * Stand up a live v2 `McpServer` carrying the production LCD as `outputSchema`
 * and a tuple-bearing `inputSchema`, complete the handshake, and return its
 * `tools/list` entries.
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
  // Anti-vacuity on the handshake: an empty tools list below could otherwise
  // just mean the connection never came up.
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

describe('tools/list schema conformance — v2 @modelcontextprotocol/server 2.0.0', () => {
  /**
   * Q1, decided empirically. v2 needs no `target` argument, no patch and no
   * post-processing to put native draft-2020-12 on the wire.
   *
   * BLOCKING ARM — every emitted schema declares the 2020-12 `$schema`, AND the
   * tuple renders as `prefixItems`. The second half is what makes it *native*
   * rather than a relabel: a draft-7 conversion wearing a 2020-12 URL would
   * still emit an `items` array.
   *
   * NEGATIVE TWIN — the same detector, fed the draft-7 rendering of the same
   * tuple, finds nothing (`FindDraft2020Keyword_Draft7TupleRendering_FindsNothing`
   * above, and re-asserted here so this block stands alone once v1 is gone).
   *
   * SECOND AUTHORITY — Zod's own conversion of the same schema, asked for
   * draft-2020-12, is compared against what the SDK actually put on the wire.
   * The two are different packages and neither is computed from the other, so
   * they can genuinely disagree: an SDK that re-labelled `$schema` without
   * moving its conversion target would satisfy the wire assertion alone and
   * diverge from Zod here.
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

    // Native, not relabelled.
    expect(
      findDraft2020Keyword(fixture?.inputSchema),
      `v2 emitted no 2020-12-only structural keyword for a tuple. Schema received: ` +
        JSON.stringify(fixture?.inputSchema),
    ).toBe('prefixItems');

    // The detector discriminates.
    expect(findDraft2020Keyword(DRAFT_7_TUPLE_SHAPE)).toBeUndefined();

    // SECOND AUTHORITY — Zod, asked for the same dialect independently of the
    // SDK, must agree with the wire on both the marker and the tuple rendering.
    const zodEmission = z.toJSONSchema(
      z.object({ coord: z.tuple([z.number(), z.number()]) }),
      { target: 'draft-2020-12', io: 'input' },
    );
    expect(zodEmission.$schema).toBe(fixture?.inputSchema?.['$schema']);
    expect(findDraft2020Keyword(zodEmission)).toBe('prefixItems');
  });

  /**
   * Q2, decided empirically, against the PRODUCTION LCD rather than a toy
   * union — and this doubles as the verification of task 049's lead that v2's
   * `registerTool` takes a Zod v4 discriminated union for `outputSchema`
   * directly.
   *
   * BLOCKING ARM — the DU-rooted `outputSchema` reaches the wire at all (v1
   * unpatched drops it), carries `type: 'object'` at the root, and keeps its
   * union branches.
   *
   * INDEPENDENT ORACLE — Zod's own conversion of the SAME schema is asserted to
   * carry NO root `type`. That is what attributes the `type: 'object'` to the
   * SDK rather than to Zod: the two authorities are different packages and can
   * genuinely disagree, so if v2 ever stopped stamping the root this test goes
   * red instead of quietly passing on Zod's output.
   *
   * @kill-seam: a root `type: "object"` contributed by Zod rather than by the SDK, or one obtained by flattening the discriminated union away
   * @oracle-sources: @modelcontextprotocol/server 2.0.0 live wire response, zod 4 z.toJSONSchema
   */
  it('ToolsList_DiscriminatedUnionRoot_HasObjectType', async () => {
    // Independent oracle first: Zod alone does NOT produce a root `type` for
    // this discriminated union.
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
