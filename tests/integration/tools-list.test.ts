// Integration test for the shape of the MCP `tools/list` manifest.
//
// The test lists the tools in-process through the in-memory transport pair of the SDK. It asserts:
//
//   - Each visible composite tool is present, and each entry has `outputSchema` and `annotations`.
//   - Each schema declares a recognised JSON Schema `$schema` URL.
//   - `annotations` holds the four boolean hint fields.
//   - A hidden tool (`exarchos_sync`) is absent from the model-facing surface.

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
} from '../../src/contract/sdk/seam.js';
import { createMcpServer } from '../../src/adapters/mcp/mcp.js';
import { EventStore } from '../../src/events/store.js';
import { TOOL_REGISTRY } from '../../src/registry.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/**
 * The `$schema` URLs that this shape test accepts. `tools-list-2020-12.test.ts` pins the exact
 * draft.
 */
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

  /** The hook ignores a failure of `client.close()`, so it always removes the temp directory. */
  afterEach(async () => {
    try {
      await client.close();
    } catch {
    }
    await rmrfAsync(tmpDir);
  });

  /** A hidden tool must be absent from the model-facing `tools/list`, and each visible tool present. */
  it('ToolsList_VisibleTools_HaveOutputSchemaAndAnnotations', async () => {
    const { tools } = await client.listTools();

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

  /**
   * `aggregateToolAnnotations` always sets the four hints, so a client can show them with no
   * `undefined` check.
   */
  it('ToolsList_EveryEntry_AdvertisesPopulatedAnnotations', async () => {
    const { tools } = await client.listTools();
    for (const t of tools as ToolEntry[]) {
      const ann = t.annotations;
      expect(ann, `annotations missing on ${t.name}`).toBeDefined();
      expect(typeof ann!.readOnlyHint).toBe('boolean');
      expect(typeof ann!.destructiveHint).toBe('boolean');
      expect(typeof ann!.idempotentHint).toBe('boolean');
      expect(typeof ann!.openWorldHint).toBe('boolean');
    }
  });

  /**
   * Pins the aggregation formula at the `tools/list` boundary. `readOnlyHint` and `idempotentHint`
   * are true only when each action of the tool has the flag. `destructiveHint` and `openWorldHint`
   * are true when one action or more has the flag.
   */
  it('ToolsList_AnnotationsAggregation_MatchesRegistryFormula', async () => {
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
