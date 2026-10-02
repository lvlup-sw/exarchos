// Per-call cost of output validation through the full MCP carrier, measured in
// the benchmark gate rather than asserted in a correctness test (#2029).
//
// This arm replaces `tests/integration/perf-validation.test.ts`, which asserted
// a 75 ms median over 100 calls and so measured the host as much as the code.
// The path is unchanged: `exarchos_view.pipeline` through dispatch, the
// per-action schema validation and the in-memory SDK transport. An
// order-of-magnitude regression (a recursive Zod parse, a per-call registry
// scan) shows here as a mean far above the low single-digit milliseconds this
// path costs today.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bench, describe } from 'vitest';

import { createMcpServer } from '../../../../src/adapters/mcp/mcp.js';
import {
  connectV2Client,
  connectV2Server,
  createV2Client,
  createV2LinkedTransportPair,
} from '../../../../src/contract/sdk/seam.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'output-validation-bench-'));
const eventStore = new EventStore(STATE_DIR);
await eventStore.initialize();
const ctx: DispatchContext = { stateDir: STATE_DIR, eventStore, enableTelemetry: false };
const [clientTransport, serverTransport] = createV2LinkedTransportPair();
const client = createV2Client({ name: 'output-validation-bench', version: '1.0.0' }, { capabilities: {} });
await Promise.all([
  connectV2Server(createMcpServer(ctx), serverTransport),
  connectV2Client(client, clientTransport),
]);

describe('MCP output validation overhead', () => {
  bench(
    'ViewPipeline_ThroughTheMcpCarrier',
    async () => {
      await client.callTool({ name: 'exarchos_view', arguments: { action: 'pipeline' } });
    },
    { warmupIterations: 5, iterations: 100 },
  );
});
