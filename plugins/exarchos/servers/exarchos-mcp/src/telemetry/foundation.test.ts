import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../event-store/store.js';
import { TELEMETRY_STREAM } from './constants.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Telemetry Event Types', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-test-'));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should accept tool.invoked event to telemetry stream', async () => {
    const event = await store.append(TELEMETRY_STREAM, {
      type: 'tool.invoked',
      data: { tool: 'test_tool' },
    });
    expect(event.type).toBe('tool.invoked');
    expect(event.streamId).toBe(TELEMETRY_STREAM);
  });

  it('should accept tool.completed event with metrics', async () => {
    const event = await store.append(TELEMETRY_STREAM, {
      type: 'tool.completed',
      data: { tool: 'test_tool', durationMs: 42, responseBytes: 256, tokenEstimate: 64 },
    });
    expect(event.type).toBe('tool.completed');
  });

  it('should accept tool.errored event with error info', async () => {
    const event = await store.append(TELEMETRY_STREAM, {
      type: 'tool.errored',
      data: { tool: 'test_tool', durationMs: 5, errorMessage: 'TIMEOUT' },
    });
    expect(event.type).toBe('tool.errored');
  });

  it('should query telemetry stream and return all 3 events', async () => {
    await store.append(TELEMETRY_STREAM, { type: 'tool.invoked', data: { tool: 't' } });
    await store.append(TELEMETRY_STREAM, { type: 'tool.completed', data: { tool: 't', durationMs: 1, responseBytes: 10, tokenEstimate: 3 } });
    await store.append(TELEMETRY_STREAM, { type: 'tool.errored', data: { tool: 't', durationMs: 1, errorMessage: 'ERR' } });

    const events = await store.query(TELEMETRY_STREAM);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.type)).toEqual(['tool.invoked', 'tool.completed', 'tool.errored']);
  });
});
