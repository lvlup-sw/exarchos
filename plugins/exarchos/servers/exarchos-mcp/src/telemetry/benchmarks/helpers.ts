import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../event-store/store.js';
import { resetMaterializerCache } from '../../views/tools.js';
import { TELEMETRY_STREAM } from '../constants.js';

export async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-bench-'));
}

export async function seedTelemetryEvents(
  stateDir: string,
  events: Array<{
    tool: string;
    durationMs: number;
    responseBytes: number;
    tokenEstimate: number;
  }>,
): Promise<EventStore> {
  const store = new EventStore(stateDir);
  for (const e of events) {
    await store.append(TELEMETRY_STREAM, {
      type: 'tool.completed',
      data: e,
    });
  }
  return store;
}

export function resetCache(): void {
  resetMaterializerCache();
}
