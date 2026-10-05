/**
 * CLI and MCP parity. The tests run the same read-only action through two carriers and compare the payloads.
 * A mask removes the timestamps and the ids that differ between calls.
 * - CLI, in-process: `buildCli(ctx).parseAsync([..., 'vw', 'ls', '--json'])`, with `process.stdout.write` captured.
 * - MCP, in-process: `tools/call`, read from `structuredContent`.
 *
 * Both carriers share one `DispatchContext` and one state directory, so a payload difference comes from the carrier.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createV2Client,
  createV2LinkedTransportPair,
  connectV2Client,
  connectV2Server,
  type V2Client,
} from '../../src/contract/sdk/seam.js';
import { createMcpServer } from '../../src/adapters/mcp/mcp.js';
import { buildCli } from '../../src/adapters/cli/cli.js';
import { EventStore } from '../../src/events/store.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  UUID_ANY_RE,
} from '../unit/parity-harness.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/**
 * Removes the fields that differ between calls, so that the payloads of two carriers compare structurally.
 * It removes `_perf`, `updatedAt`, `timestamp`, and an `id` string that looks like a hex id. Every other field stays.
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
  let client: V2Client;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-parity-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };

    const server = createMcpServer(ctx);
    const [clientTransport, serverTransport] = createV2LinkedTransportPair();
    client = createV2Client(
      { name: 'cli-parity-test', version: '1.0.0' },
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
    }
    await rmrfAsync(tmpDir);
  });

  /**
   * The CLI arm uses `buildCli` in-process, not a spawned `tsx`, so both arms use the SQLite backend alias of the vitest process.
   * `exitOverride` stops a Commander parse exit from ending the test worker.
   * The test compares the two arms on `success` and on the masked `data` only.
   */
  it('CliParity_VwLs_DataLevelMatch_AcrossCarriers', async () => {
    const chunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((data: unknown): boolean => {
        chunks.push(typeof data === 'string' ? data : String(data));
        return true;
      });
    try {
      const program = buildCli(ctx);
      program.exitOverride();
      await program.parseAsync(['node', 'exarchos', 'vw', 'ls', '--json']);
    } finally {
      stdoutSpy.mockRestore();
    }

    const cliRaw = chunks.join('').trim();
    expect(cliRaw.length).toBeGreaterThan(0);
    const cliPayload = JSON.parse(cliRaw) as Record<string, unknown>;

    const mcpResult = (await client.callTool({
      name: 'exarchos_view',
      arguments: { action: 'pipeline' },
    })) as { structuredContent?: Record<string, unknown> };
    expect(mcpResult.structuredContent).toBeDefined();

    expect(cliPayload.success).toBe(true);
    expect((mcpResult.structuredContent as { success: boolean }).success).toBe(true);

    const cliData = (cliPayload.data ?? {}) as Record<string, unknown>;
    const mcpData = ((mcpResult.structuredContent as { data?: Record<string, unknown> })
      .data ?? {}) as Record<string, unknown>;
    expect(maskNondeterministic(cliData)).toEqual(maskNondeterministic(mcpData));
  });

  /**
   * The JSON stdout of the CLI must carry the same envelope as MCP `structuredContent`, apart from the transient fields.
   * `emitResult` prints `toCliResult(toEnvelope(...))`, and the harness `callMcp` returns `toEnvelope(dispatch(...))`.
   * So the test deep-compares two envelopes after `normalize` replaces timestamps and UUIDs and removes `_perf` and `updatedAt`.
   * The fixture is the `pipeline` view: CLI alias `ls` on tool `vw`, and MCP `exarchos_view` with `action: 'pipeline'`.
   */
  it('CliParity_VwLs_ByteEqualEnvelope_AcrossCarriers', async () => {
    const cliCall = await harnessCallCli(ctx, 'vw', 'ls', {});
    const mcpEnvelope = await harnessCallMcp(ctx, 'exarchos_view', {
      action: 'pipeline',
    });

    expect(cliCall.result.success).toBe(true);
    expect(mcpEnvelope.success).toBe(true);

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
