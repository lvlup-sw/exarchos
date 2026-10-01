// Telemetry latency, measured in the benchmark gate rather than asserted in a
// correctness test (#2029).
//
// These arms replace `latency.test.ts`, whose timing assertions ran only when
// RUN_BENCHMARKS was set. The budgets it asserted are
// `telemetry_wrapper_overhead_max_ms` (10 ms median overhead of `withTelemetry`
// over the bare handler: compare the two handler arms) and
// `telemetry_view_100_events_max_ms` (100 ms) in
// `src/projections/telemetry/benchmarks/baselines.json`.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bench, describe } from 'vitest';

import { EventStore } from '../../../../../src/events/store.js';
import { TELEMETRY_STREAM } from '../../../../../src/projections/telemetry/constants.js';
import { withTelemetry } from '../../../../../src/projections/telemetry/middleware.js';
import { handleViewTelemetry } from '../../../../../src/projections/telemetry/tools.js';
import { resetMaterializerCache } from '../../../../../src/projections/views/tools.js';

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-bench-'));
const store = new EventStore(STATE_DIR);
for (let i = 0; i < 100; i++) {
  await store.append(TELEMETRY_STREAM, {
    type: 'tool.completed',
    data: { tool: `tool_${i % 10}`, durationMs: i, responseBytes: 100 * i, tokenEstimate: 25 * i },
  });
}

/** The handler both wrapper arms call, so their difference is the wrapper's cost. */
const bareHandler = async (): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> => ({
  content: [{ type: 'text', text: JSON.stringify({ success: true, data: {} }) }],
  isError: false,
});
const instrumented = withTelemetry(bareHandler, 'latency_test', store);

describe('Telemetry latency budgets', () => {
  bench(
    'handler_Bare',
    async () => {
      await bareHandler();
    },
    { warmupIterations: 5, iterations: 100 },
  );

  bench(
    'handler_WithTelemetry',
    async () => {
      await instrumented({});
      resetMaterializerCache();
    },
    { warmupIterations: 5, iterations: 100 },
  );

  bench(
    'viewTelemetry_100Events',
    async () => {
      resetMaterializerCache();
      await handleViewTelemetry({}, STATE_DIR);
    },
    { warmupIterations: 3, iterations: 30 },
  );
});
