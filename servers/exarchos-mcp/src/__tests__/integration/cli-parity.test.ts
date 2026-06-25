// ─── F.3: CLI ↔ MCP parity (Wave 0, design §7) ─────────────────────────────
//
// Drives the SAME read-only action via two carriers and asserts that the
// shared dispatch core surfaces structurally identical payloads (modulo
// masks for timestamps + IDs that legitimately drift across calls):
//
//   • CLI in-process: `buildCli(ctx).parseAsync([..., 'vw', 'ls', '--json'])`
//     with `process.stdout.write` hijacked to capture the JSON line.
//   • In-process MCP `tools/call` → `structuredContent`.
//
// Both carriers share the same `DispatchContext` and the same backing
// state directory, so the payload differences are purely carrier-side
// shaping (envelope-wrapping for MCP, raw ToolResult for CLI under
// `--json`).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../adapters/mcp.js';
import { buildCli } from '../../adapters/cli.js';
import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  UUID_ANY_RE,
} from '../parity-harness.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

/**
 * Strip fields that vary across invocations (`_perf`, `updatedAt`,
 * `timestamp`, hex-id-looking strings under `id`) so two carriers can be
 * compared structurally. Conservative on what it removes — only fields
 * whose semantic role is "transient" are dropped; everything else stays.
 */
function maskNondeterministic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskNondeterministic);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(value as Record<string, unknown>)) {
      if (k === '_perf' || k === 'updatedAt' || k === 'timestamp') continue;
      if (k === 'id' && typeof sub === 'string' && /^[0-9a-f-]{8,}$/i.test(sub)) {
        continue;
      }
      out[k] = maskNondeterministic(sub);
    }
    return out;
  }
  return value;
}

describe('F.3 — CLI ↔ MCP parity (Wave 0 §7)', () => {
  let tmpDir: string;
  let client: Client;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-parity-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };

    const server = createMcpServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: 'cli-parity-test', version: '1.0.0' },
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

  it('CliParity_VwLs_DataLevelMatch_AcrossCarriers', async () => {
    // CLI arm: hijack stdout, drive `buildCli(...).parseAsync(['vw','ls',
    // '--json'])`, capture the JSON line. Using buildCli rather than
    // spawning `tsx` keeps the test hermetic (no bun:sqlite vs better-
    // sqlite3 substrate divergence — both arms run under the vitest
    // process with the same backend alias in vitest.config.ts).
    const chunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((data: unknown): boolean => {
        chunks.push(typeof data === 'string' ? data : String(data));
        return true;
      });
    try {
      const program = buildCli(ctx);
      // ExitOverride keeps a Commander parse exit from killing the test
      // worker; the action handler still sets process.exitCode for
      // observability but does not call process.exit().
      program.exitOverride();
      await program.parseAsync(['node', 'exarchos', 'vw', 'ls', '--json']);
    } finally {
      stdoutSpy.mockRestore();
    }

    // The CLI emits a single JSON line for `--json`. Concatenate captured
    // chunks (commander/printers may split) and JSON.parse the result.
    const cliRaw = chunks.join('').trim();
    expect(cliRaw.length).toBeGreaterThan(0);
    const cliPayload = JSON.parse(cliRaw) as Record<string, unknown>;

    // MCP arm: drive the same action via tools/call.
    const mcpResult = (await client.callTool({
      name: 'exarchos_view',
      arguments: { action: 'pipeline' },
    })) as { structuredContent?: Record<string, unknown> };
    expect(mcpResult.structuredContent).toBeDefined();

    // Both must succeed.
    expect(cliPayload.success).toBe(true);
    expect((mcpResult.structuredContent as { success: boolean }).success).toBe(true);

    // The CLI emits raw ToolResult (`{success, data, ...}`); MCP emits the
    // envelope (`{success, data, next_actions, _meta, _perf, ...}`).
    // Compare the shared invariants: success + masked data.
    const cliData = (cliPayload.data ?? {}) as Record<string, unknown>;
    const mcpData = ((mcpResult.structuredContent as { data?: Record<string, unknown> })
      .data ?? {}) as Record<string, unknown>;
    expect(maskNondeterministic(cliData)).toEqual(maskNondeterministic(mcpData));
  });

  // INV-2: CLI `--format json` stdout MUST carry the same envelope as MCP
  // structuredContent (modulo masks for transient fields). With PR-B (#1368)
  // wiring `toCliResult(toEnvelope(...))` into `emitResult`, both arms now
  // surface envelope-shaped output. The W2 harness mirrors that on the MCP
  // side (`callMcp` returns `toEnvelope(dispatch(...))`), so this test is a
  // deep-equal `Envelope<unknown>` ↔ `Envelope<unknown>` comparison after
  // normalization.
  it('CliParity_VwLs_ByteEqualEnvelope_AcrossCarriers', async () => {
    // Same fixture as the data-level test above: `pipeline` view, CLI
    // alias `ls` on tool `vw`, MCP `exarchos_view { action: 'pipeline' }`.
    const cliCall = await harnessCallCli(ctx, 'vw', 'ls', {});
    const mcpEnvelope = await harnessCallMcp(ctx, 'exarchos_view', {
      action: 'pipeline',
    });

    // Sanity: both arms must report success.
    expect(cliCall.result.success).toBe(true);
    expect(mcpEnvelope.success).toBe(true);

    // Normalize the full envelope on both sides — strips `_perf`,
    // `_meta.updatedAt`, ISO timestamps, and UUIDs to stable placeholders
    // so two independent invocations produce byte-equal trees.
    const normalizeOpts = {
      timestampPlaceholder: '<ISO>' as const,
      uuidPlaceholder: '<UUID>' as const,
      uuidRegex: UUID_ANY_RE,
      dropKeys: new Set(['_perf', 'updatedAt']),
    };
    expect(harnessNormalize(cliCall.result, normalizeOpts)).toEqual(
      harnessNormalize(mcpEnvelope, normalizeOpts),
    );
  });
});
