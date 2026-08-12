// ─── F.6: Output validation overhead benchmark (Wave 0, design §7) ─────────
//
// Wires the same read-only dispatch (`exarchos_view.pipeline`) 100 times via
// the MCP carrier (in-process SDK), measures the median wall-clock per call,
// and asserts the median sits beneath a CI-robust threshold. The intent is
// not microbenchmark accuracy but a load-bearing alarm: if a future change
// makes the per-call validation path dominate (e.g. accidental recursive
// Zod parse, an O(actions) re-lookup on every call), this test fails.
//
// Threshold rationale
// -------------------
// On a hot Node 20 path locally, `view.pipeline` through the full carrier
// (dispatch → toEnvelope → per-action schema validate → toMcpResult →
// SDK in-memory transport → client deserialise) measures well under 10ms
// per call on dev hardware. A 75ms median floor leaves ~7-10x headroom for
// shared-CI flakiness (loaded test runners, fork-pool contention, cold
// V8 paths on the first few iterations) and still catches an order-of-
// magnitude regression. If the threshold ever flakes in CI, raise it
// (with a comment + a tracking issue) rather than chasing percentiles.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createV2Client,
  createV2LinkedTransportPair,
  connectV2Client,
  connectV2Server,
  type V2Client,
} from '../../sdk/seam.js';
import { createMcpServer } from '../../adapters/mcp.js';
import { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

const ITERATIONS = 100;
const WARMUP = 5;
const MEDIAN_BUDGET_MS = 75;

describe('F.6 — output validation overhead', () => {
  let tmpDir: string;
  let client: V2Client;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-validation-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
    };
    const server = createMcpServer(ctx);
    const [clientTransport, serverTransport] = createV2LinkedTransportPair();
    client = createV2Client(
      { name: 'perf-validation-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      connectV2Server(server, serverTransport),
      connectV2Client(client, clientTransport),
    ]);
  });

  afterAll(async () => {
    try {
      await client.close();
    } catch (err) {
      // Only swallow benign close-state errors — the transport
      // sometimes reports already-closed sockets here when the suite
      // exits abruptly. Anything else (e.g. an SDK-side handshake or
      // protocol regression) should surface so we don't silently
      // tolerate a real shutdown break (CodeRabbit minor on PR #1369).
      const message = err instanceof Error ? err.message : String(err);
      const isBenignCloseStateError =
        /already closed|not connected|transport.*closed|ECONNRESET/i.test(message);
      if (!isBenignCloseStateError) {
        throw err;
      }
    }
    await rmrfAsync(tmpDir);
  });

  it('PerfValidation_RepeatedDispatch_MedianBelowBudget', async () => {
    // Warmup: drive a few calls through the path so the JIT, the event-
    // store handles, and the Zod schema closures are hot before timing.
    for (let i = 0; i < WARMUP; i++) {
      await client.callTool({
        name: 'exarchos_view',
        arguments: { action: 'pipeline' },
      });
    }

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      await client.callTool({
        name: 'exarchos_view',
        arguments: { action: 'pipeline' },
      });
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];

    expect(
      median,
      `median ${median.toFixed(2)}ms > budget ${MEDIAN_BUDGET_MS}ms — full samples sorted: ${samples
        .map((s) => s.toFixed(2))
        .join(', ')}`,
    ).toBeLessThan(MEDIAN_BUDGET_MS);
  });
});
