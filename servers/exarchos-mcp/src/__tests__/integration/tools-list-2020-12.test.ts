// ─── C-W8 HARD GATE: tools/list emits native draft-2020-12 (#1366) ──────────
//
// This is the headline acceptance test for the Zod v3 → v4 migration. The
// ratified plan in `docs/research/2026-05-13-zod-v4-decision-record-addendum.md`
// §4 promotes "native 2020-12 at the tools/list SDK boundary" from a SHOULD
// to a HARD GATE: no draft-7 fallback, no $schema relabel — the JSON Schema
// emitted by the SDK must be true draft-2020-12.
//
// The prior F.1 test (`tools-list.test.ts`) accepts BOTH 2020-12 and draft-7
// because at the time of authoring the SDK 1.26.x line emitted draft-7. After
// PR-C foundation (C-W2) the local SDK is patched to emit 2020-12 via three
// fixes:
//
//   1. Gap 1 — `target: 'draft-2020-12'` passed to `toJsonSchemaCompat()` in
//      `mcp.js` for both `inputSchema` and `outputSchema` paths.
//   2. Gap 2 — `normalizeObjectSchema()` in `zod-compat.js` accepts v4
//      `ZodDiscriminatedUnion` (root-level DU schemas) instead of returning
//      `undefined` and falling back to `EMPTY_OBJECT_JSON_SCHEMA`. This is
//      what reactivates the canonical LCD envelope as the advertised
//      outputSchema.
//   3. Gap 3 — post-emission splice of `type: 'object'` onto DU-rooted
//      outputs in `mcp.js`. Zod v4's `z.toJSONSchema` emits a DU as a
//      top-level `anyOf` with no `type` field, but the MCP spec requires
//      `type: 'object'` on every tools/list schema. The splice keeps the
//      `anyOf` branches intact for structurally typed clients and adds the
//      MCP-mandated root type marker.
//
// All three gaps are tested here at the live `tools/list` SDK boundary, NOT
// at the lower-level `zodToJsonSchema()` adapter — that distinction is the
// whole point of "headline acceptance".
//
// If this test fails, the migration has not delivered. The correct response
// is to surface a regression, NOT to soften the assertion.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../adapters/mcp.js';
import { EventStore } from '../../event-store/store.js';
import { TOOL_REGISTRY } from '../../registry.js';
import type { DispatchContext } from '../../core/dispatch.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

// 2020-12-only structural keywords. Any of these in any emitted schema
// proves the wire format is native 2020-12 (draft-7 cannot produce them
// from `z.toJSONSchema`). `prefixItems` is the canonical signal for a
// tuple — draft-7 used per-index `items` arrays instead.
const DRAFT_2020_12_ONLY_KEYWORDS = [
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
] as const;

interface ToolEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Recursively scan a JSON Schema for any draft-2020-12-only structural
 * keyword. Returns the first keyword name encountered, or `undefined` if
 * none of them appear. We walk the standard `properties`/`items`/`anyOf`/
 * `oneOf`/`allOf` shape — enough to catch the keyword regardless of nesting
 * depth in production schemas.
 */
function findDraft2020Keyword(schema: unknown): string | undefined {
  if (schema === null || typeof schema !== 'object') return undefined;
  if (Array.isArray(schema)) {
    for (const item of schema) {
      const hit = findDraft2020Keyword(item);
      if (hit) return hit;
    }
    return undefined;
  }
  const obj = schema as Record<string, unknown>;
  for (const keyword of DRAFT_2020_12_ONLY_KEYWORDS) {
    if (keyword in obj) return keyword;
  }
  for (const value of Object.values(obj)) {
    const hit = findDraft2020Keyword(value);
    if (hit) return hit;
  }
  return undefined;
}

describe('tools/list emits native draft-2020-12 [hard gate #1366]', () => {
  let tmpDir: string;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

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

    // Register a fixture tool whose input schema carries a Zod v4 tuple.
    // Tuples render as `prefixItems` only under draft-2020-12 — under
    // draft-7 they render as an `items` array. This guarantees at least
    // one tools/list entry carries a 2020-12-only structural keyword
    // even if no production tool currently exercises tuples at its
    // top-level input shape. Kept inline so the test owns its fixture.
    server.registerTool(
      '__cw8_fixture_tuple_tool',
      {
        description:
          'C-W8 fixture: surfaces a Zod tuple to verify prefixItems emission',
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

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: 'tools-list-2020-12-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
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

  // ─── Hard-gate assertion 1: native 2020-12 on every inputSchema ──────────

  it('every tool inputSchema declares $schema === draft/2020-12 (gap 1)', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools as ToolEntry[]) {
      expect(t.inputSchema, `inputSchema missing on ${t.name}`).toBeDefined();
      expect(
        t.inputSchema!.$schema,
        `inputSchema.$schema on ${t.name} must be native 2020-12, got "${t.inputSchema!.$schema}"`,
      ).toBe(DRAFT_2020_12);
    }
  });

  // ─── Hard-gate assertion 2: outputSchema present on every PRODUCTION tool ──
  //
  // Gap 2 was the silent-drop bug: pre-patch, the SDK's normalizeObjectSchema
  // returned undefined for `ZodDiscriminatedUnion` (our canonical LCD), so
  // the SDK skipped the `toolDefinition.outputSchema = ...` branch entirely
  // and the manifest carried no advertised outputSchema. This test pins the
  // gap-2 fix: every PRODUCTION tool (filtered to TOOL_REGISTRY visible
  // entries) MUST advertise an outputSchema. The inline fixture tool is
  // excluded because it intentionally has no outputSchema.

  it('every production visible tool advertises outputSchema (gap 2)', async () => {
    const { tools } = await client.listTools();
    const visibleProductionNames = new Set(
      TOOL_REGISTRY.filter((t) => !t.hidden).map((t) => t.name),
    );
    const productionTools = (tools as ToolEntry[]).filter((t) =>
      visibleProductionNames.has(t.name),
    );
    expect(productionTools.length).toBeGreaterThan(0);
    for (const t of productionTools) {
      expect(
        t.outputSchema,
        `outputSchema missing on production tool ${t.name} — gap-2 regression`,
      ).toBeDefined();
    }
  });

  // ─── Hard-gate assertion 3: native 2020-12 on every advertised outputSchema ─

  it('every advertised outputSchema declares $schema === draft/2020-12 (gap 1, output path)', async () => {
    const { tools } = await client.listTools();
    const withOutputSchema = (tools as ToolEntry[]).filter((t) => t.outputSchema);
    expect(withOutputSchema.length).toBeGreaterThan(0);
    for (const t of withOutputSchema) {
      expect(
        t.outputSchema!.$schema,
        `outputSchema.$schema on ${t.name} must be native 2020-12, got "${t.outputSchema!.$schema}"`,
      ).toBe(DRAFT_2020_12);
    }
  });

  // ─── Hard-gate assertion 4: outputSchema.type === 'object' (gap 3 splice) ──
  //
  // The MCP spec requires `type: 'object'` on every tools/list outputSchema.
  // Our canonical LCD is a discriminated union (success/error envelope), and
  // Zod v4's `z.toJSONSchema` emits DUs as a top-level `anyOf` WITHOUT a
  // `type` field. The C-W6 patch (gap 3) post-processes the SDK's emission
  // to splice `type: 'object'` onto DU-rooted outputs. This test verifies
  // the splice is live at the SDK boundary.

  it("every advertised outputSchema.type === 'object' (gap 3 splice)", async () => {
    const { tools } = await client.listTools();
    const withOutputSchema = (tools as ToolEntry[]).filter((t) => t.outputSchema);
    expect(withOutputSchema.length).toBeGreaterThan(0);
    for (const t of withOutputSchema) {
      expect(
        t.outputSchema!.type,
        `outputSchema.type on ${t.name} must be "object" (gap-3 splice), got ${JSON.stringify(t.outputSchema!.type)}`,
      ).toBe('object');
    }
  });

  // ─── Hard-gate assertion 5: 2020-12-only structural keyword present ────────
  //
  // Proves the wire format is native 2020-12 rather than a $schema relabel
  // sitting atop draft-7 output. `prefixItems` is the canonical signal — a
  // Zod tuple cannot render as `prefixItems` under draft-7. The fixture
  // tool registered above guarantees at least one inputSchema exercises
  // this code path even if production schemas drift away from tuples.

  it('inputSchema for the fixture tool emits prefixItems (2020-12 keyword)', async () => {
    const { tools } = await client.listTools();
    const fixture = (tools as ToolEntry[]).find(
      (t) => t.name === '__cw8_fixture_tuple_tool',
    );
    expect(fixture, 'fixture tool missing from tools/list').toBeDefined();
    const keyword = findDraft2020Keyword(fixture!.inputSchema);
    expect(
      keyword,
      `fixture inputSchema did not emit any 2020-12-only structural keyword. ` +
        `If draft-7 is on the wire, tuples render as an \`items\` array — that ` +
        `is the regression signal. Schema received: ${JSON.stringify(fixture!.inputSchema)}`,
    ).toBe('prefixItems');
  });
});
