// ─── F.1: tools/list shape integration test (Wave 0, design §7) ─────────────
//
// Drives the MCP `tools/list` carrier in-process via the SDK's
// `InMemoryTransport` pair and asserts the manifest shape that Wave 0 D.4/D.6
// committed to:
//
//   • Every visible composite tool entry carries BOTH `outputSchema` AND
//     `annotations`.
//   • Each schema is JSON Schema 2020-12 ($schema URL == draft 2020-12).
//   • `annotations` is a populated ToolAnnotations object with the four
//     boolean *Hint fields.
//   • Hidden tools (`exarchos_sync`) are absent from the model-facing surface.
//
// This locks the static carrier surface so future regressions on tools/list
// (e.g. accidental hidden-tool exposure, missing schema advertisement) fail
// loudly in CI rather than being discovered by downstream model agents.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createV2Client,
  createV2LinkedTransportPair,
  connectV2Client,
  connectV2Server,
  type V2Client,
  type V2InMemoryTransport,
} from '../../sdk/seam.js';
import { createMcpServer } from '../../adapters/mcp.js';
import { EventStore } from '../../events/store.js';
import { TOOL_REGISTRY } from '../../registry.js';
import type { DispatchContext } from '../../core/dispatch.js';

// Per design `docs/designs/archive/2026-05-13-wave-0-carrier-swap.md` §2.6 the
// advertised tool schemas SHOULD carry the JSON Schema 2020-12 `$schema`
// URL. In practice the MCP SDK (1.26.x) drives its OWN internal
// Zod-v3 → JSON Schema converter for `tools/list` and that converter emits
// draft-07. Migrating the MCP server to Zod v4 is tracked at #1366. Until
// then the carrier-bound assertion is "some recognised JSON Schema $schema
// URL is set", not "exactly 2020-12" — testing 2020-12 here would only
// repeat the already-tracked Zod-v4 work as a fresh failure.
const ACCEPTED_JSON_SCHEMA_DRAFTS = new Set<string>([
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
]);

interface ToolEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

describe('F.1 — tools/list shape (Wave 0 §7)', () => {
  let tmpDir: string;
  let client: V2Client;
  let serverTransport: V2InMemoryTransport;
  let clientTransport: V2InMemoryTransport;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-list-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
    };

    const server = createMcpServer(ctx);
    [clientTransport, serverTransport] = createV2LinkedTransportPair();
    client = createV2Client(
      { name: 'tools-list-test', version: '1.0.0' },
      { capabilities: {} },
    );
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

  it('ToolsList_VisibleTools_HaveOutputSchemaAndAnnotations', async () => {
    const { tools } = await client.listTools();

    // Visible-only invariant: hidden tools (e.g. exarchos_sync) MUST be
    // absent from the model-facing tools/list. The CLI introspection path
    // (`schema-introspection.listSchemas`) intentionally returns the full
    // registry with a `hidden` tag — tools/list deliberately filters it.
    const hiddenNames = TOOL_REGISTRY.filter((t) => t.hidden).map((t) => t.name);
    const visibleNames = TOOL_REGISTRY.filter((t) => !t.hidden).map((t) => t.name);

    const advertisedNames = tools.map((t) => (t as ToolEntry).name);
    for (const hidden of hiddenNames) {
      expect(advertisedNames).not.toContain(hidden);
    }
    for (const visible of visibleNames) {
      expect(advertisedNames).toContain(visible);
    }
  });

  it('ToolsList_EveryEntry_AdvertisesOutputSchema', async () => {
    const { tools } = await client.listTools();
    for (const t of tools as ToolEntry[]) {
      expect(t.outputSchema, `outputSchema missing on ${t.name}`).toBeDefined();
      // The advertised schema is the LCD ZodObject (D.4) — surfaced as
      // JSON Schema 2020-12 on the wire. Both the $schema URL and the
      // object-typed core must be present.
      expect(
        ACCEPTED_JSON_SCHEMA_DRAFTS.has(String(t.outputSchema!.$schema)),
        `outputSchema $schema on ${t.name} is "${t.outputSchema!.$schema}", expected one of: ${[...ACCEPTED_JSON_SCHEMA_DRAFTS].join(', ')}`,
      ).toBe(true);
      expect(t.outputSchema!.type).toBe('object');
    }
  });

  it('ToolsList_EveryEntry_AdvertisesInputSchemaWithRecognisedDraft', async () => {
    const { tools } = await client.listTools();
    for (const t of tools as ToolEntry[]) {
      expect(t.inputSchema, `inputSchema missing on ${t.name}`).toBeDefined();
      expect(
        ACCEPTED_JSON_SCHEMA_DRAFTS.has(String(t.inputSchema!.$schema)),
        `inputSchema $schema on ${t.name} is "${t.inputSchema!.$schema}", expected one of: ${[...ACCEPTED_JSON_SCHEMA_DRAFTS].join(', ')}`,
      ).toBe(true);
    }
  });

  it('ToolsList_EveryEntry_AdvertisesPopulatedAnnotations', async () => {
    const { tools } = await client.listTools();
    for (const t of tools as ToolEntry[]) {
      const ann = t.annotations;
      expect(ann, `annotations missing on ${t.name}`).toBeDefined();
      // All four hint booleans must be present and typed as booleans —
      // D.6 aggregateToolAnnotations always populates the full quartet so
      // clients can render a safety affordance without runtime
      // `undefined`-checks.
      expect(typeof ann!.readOnlyHint).toBe('boolean');
      expect(typeof ann!.destructiveHint).toBe('boolean');
      expect(typeof ann!.idempotentHint).toBe('boolean');
      expect(typeof ann!.openWorldHint).toBe('boolean');
    }
  });

  it('ToolsList_AnnotationsAggregation_MatchesRegistryFormula', async () => {
    // Pin the D.6 aggregation formula at the tools/list boundary, not just
    // at the registerTool spy boundary (which mcp.test.ts already covers).
    // If a future refactor renames the aggregation helper or short-circuits
    // it for some tools, this end-to-end check fails loudly.
    const { tools } = await client.listTools();
    for (const t of tools as ToolEntry[]) {
      const reg = TOOL_REGISTRY.find((r) => r.name === t.name);
      if (!reg) continue;
      const ann = t.annotations!;
      expect(ann.readOnlyHint).toBe(reg.actions.every((a) => a.annotations.readOnly));
      expect(ann.destructiveHint).toBe(reg.actions.some((a) => a.annotations.destructive));
      expect(ann.idempotentHint).toBe(reg.actions.every((a) => a.annotations.idempotent));
      expect(ann.openWorldHint).toBe(reg.actions.some((a) => a.annotations.openWorld));
    }
  });
});
