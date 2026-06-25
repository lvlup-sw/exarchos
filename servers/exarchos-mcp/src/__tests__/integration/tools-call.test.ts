// ─── F.2: tools/call carrier integration test (Wave 0, design §7) ──────────
//
// Drives `tools/call` for one read-only action per visible composite tool
// through the SDK's `InMemoryTransport` pair and asserts the D.1/D.7 carrier
// contract:
//
//   1. The response carries BOTH `content[0].text` (the legacy "SHOULD" per
//      MCP 2025-11-25 Tools/Structured Content) AND `structuredContent`
//      (the typed envelope payload).
//   2. `JSON.parse(content[0].text)` deep-equals `structuredContent` — i.e.
//      no carrier-side reshaping or truncation between the two surfaces.
//   3. `structuredContent` validates against `EnvelopeSchema(z.unknown())`
//      from `schemas/envelope.ts`, the per-action contract surface.
//
// Failure in any of these would mean the carrier swap has drifted from the
// design's "both surfaces, exact mirror" contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../adapters/mcp.js';
import { EventStore } from '../../event-store/store.js';
import { EnvelopeSchema } from '../../schemas/envelope.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

interface CallToolEnvelopeResult {
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ReadOnlyProbe {
  /** Visible composite tool name. */
  tool: string;
  /** Action discriminator chosen for the probe (read-only, no setup). */
  action: string;
  /** Additional arguments beyond `action`. */
  args?: Record<string, unknown>;
}

// One read-only action per visible composite tool. Each must succeed on a
// fresh empty state directory — no `init`, no pre-seeded events. The picks:
//   • exarchos_view.pipeline      — aggregated view, returns empty list.
//   • exarchos_workflow.describe  — schema introspection, pure metadata.
//   • exarchos_event.query        — queries an empty stream; returns [].
//   • exarchos_orchestrate.describe — registry introspection.
const READ_ONLY_PROBES: readonly ReadOnlyProbe[] = [
  { tool: 'exarchos_view', action: 'pipeline' },
  { tool: 'exarchos_workflow', action: 'describe' },
  { tool: 'exarchos_event', action: 'query', args: { stream: 'nonexistent' } },
  { tool: 'exarchos_orchestrate', action: 'describe' },
];

describe('F.2 — tools/call carrier round-trip (Wave 0 §7)', () => {
  let tmpDir: string;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-call-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
    };

    const server = createMcpServer(ctx);
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: 'tools-call-test', version: '1.0.0' },
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
    await rmrfAsync(tmpDir);
  });

  for (const probe of READ_ONLY_PROBES) {
    it(`ToolsCall_${probe.tool}_${probe.action}_BothCarriersPresent`, async () => {
      const args: Record<string, unknown> = {
        action: probe.action,
        ...(probe.args ?? {}),
      };

      const result = (await client.callTool({
        name: probe.tool,
        arguments: args,
      })) as CallToolEnvelopeResult;

      // 1. Both surfaces present.
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content!.length).toBeGreaterThan(0);
      const textBlock = result.content![0];
      expect(textBlock.type).toBe('text');
      expect(typeof textBlock.text).toBe('string');
      expect(result.structuredContent).toBeDefined();

      // 2. Exact mirror: parsed legacy text equals structuredContent.
      const parsed = JSON.parse(textBlock.text) as Record<string, unknown>;
      expect(parsed).toEqual(result.structuredContent);

      // 3. Envelope schema conformance — the per-action contract surface.
      const envParse = EnvelopeSchema(z.unknown()).safeParse(result.structuredContent);
      expect(
        envParse.success,
        envParse.success
          ? undefined
          : `EnvelopeSchema validation failed for ${probe.tool}.${probe.action}: ${JSON.stringify(envParse.error.issues)}`,
      ).toBe(true);
    });
  }
});
