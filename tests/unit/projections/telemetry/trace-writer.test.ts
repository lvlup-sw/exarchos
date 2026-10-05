import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TraceWriter } from '../../../../src/projections/telemetry/trace-writer.js';
import { withTelemetry } from '../../../../src/projections/telemetry/middleware.js';
import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

function makeHandler(response: Record<string, unknown> = { success: true, data: {} }) {
  return async (_args: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(response) }],
    isError: false,
  });
}

describe('TraceWriter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-writer-test-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rmrfAsync(tmpDir);
  });

  /** The file name is `{featureId}-{sessionId}.trace.jsonl`. */
  it('TraceWriter_SessionScoped_WritesToCorrectFile', async () => {
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);
    const writer = new TraceWriter();

    await writer.writeTrace({
      toolName: 'exarchos_workflow',
      action: 'get',
      input: { featureId: 'feat-123' },
      output: { success: true },
      durationMs: 42,
      timestamp: '2025-01-01T00:00:00.000Z',
      featureId: 'feat-123',
      sessionId: 'sess-abc',
    });

    const expectedFile = path.join(tmpDir, 'feat-123-sess-abc.trace.jsonl');
    const content = await fs.readFile(expectedFile, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.toolName).toBe('exarchos_workflow');
    expect(parsed.action).toBe('get');
    expect(parsed.durationMs).toBe(42);
  });

  it('TraceWriter_AppendMode_AppendsToExistingFile', async () => {
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);
    const writer = new TraceWriter();

    const baseEntry = {
      toolName: 'exarchos_workflow',
      action: 'get',
      input: { featureId: 'feat-1' },
      output: { success: true },
      durationMs: 10,
      timestamp: '2025-01-01T00:00:00.000Z',
      featureId: 'feat-1',
      sessionId: 'sess-1',
    };

    await writer.writeTrace(baseEntry);
    await writer.writeTrace({ ...baseEntry, action: 'set', durationMs: 20 });

    const expectedFile = path.join(tmpDir, 'feat-1-sess-1.trace.jsonl');
    const content = await fs.readFile(expectedFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).action).toBe('get');
    expect(JSON.parse(lines[1]).action).toBe('set');
  });

  /** `/dev/null` is not a directory, so the writer cannot create the capture directory. */
  it('TraceWriter_WriteFailure_DoesNotThrowOrBlockToolCall', async () => {
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', '/dev/null/impossible/path');
    const writer = new TraceWriter();

    await expect(
      writer.writeTrace({
        toolName: 'exarchos_workflow',
        action: 'get',
        input: {},
        output: {},
        durationMs: 10,
        timestamp: '2025-01-01T00:00:00.000Z',
        featureId: 'feat-1',
        sessionId: 'sess-1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('withTelemetry trace capture', () => {
  let tmpDir: string;
  let eventStoreDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-middleware-test-'));
    eventStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-eventstore-test-'));
    eventStore = new EventStore(eventStoreDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rmrfAsync(tmpDir);
    await rmrfAsync(eventStoreDir);
  });

  it('WithTelemetry_CaptureEnabled_WritesTraceEntry', async () => {
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);

    const handler = makeHandler({ success: true, data: { key: 'val' } });
    const wrapped = withTelemetry(handler, 'exarchos_workflow', eventStore);

    await wrapped({
      action: 'get',
      featureId: 'feat-abc',
      sessionId: 'sess-xyz',
    });

    const files = await fs.readdir(tmpDir);
    const traceFiles = files.filter((f) => f.endsWith('.trace.jsonl'));
    expect(traceFiles).toHaveLength(1);
    expect(traceFiles[0]).toBe('feat-abc-sess-xyz.trace.jsonl');

    const content = await fs.readFile(path.join(tmpDir, traceFiles[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.toolName).toBe('exarchos_workflow');
    expect(entry.action).toBe('get');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.timestamp).toBeDefined();
  });

  /** Only the value `1` enables capture, so an empty `EXARCHOS_EVAL_CAPTURE` disables it. */
  it('WithTelemetry_CaptureDisabled_NoTraceWritten', async () => {
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);

    const handler = makeHandler();
    const wrapped = withTelemetry(handler, 'exarchos_workflow', eventStore);

    await wrapped({ action: 'get', featureId: 'feat-1', sessionId: 'sess-1' });

    const files = await fs.readdir(tmpDir);
    const traceFiles = files.filter((f) => f.endsWith('.trace.jsonl'));
    expect(traceFiles).toHaveLength(0);
  });

  /** The writer truncates the serialized input to 2048 bytes. */
  it('WithTelemetry_CaptureEnabled_TruncatesLargeInput', async () => {
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);

    const largeInput = 'x'.repeat(5000);
    const handler = makeHandler();
    const wrapped = withTelemetry(handler, 'exarchos_workflow', eventStore);

    await wrapped({
      action: 'set',
      featureId: 'feat-big',
      sessionId: 'sess-big',
      largeField: largeInput,
    });

    const files = await fs.readdir(tmpDir);
    const traceFiles = files.filter((f) => f.endsWith('.trace.jsonl'));
    expect(traceFiles).toHaveLength(1);

    const content = await fs.readFile(path.join(tmpDir, traceFiles[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.input.length).toBeLessThanOrEqual(2048);
  });

  it('WithTelemetry_CaptureEnabled_IncludesSkillContext', async () => {
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);

    const handler = makeHandler();
    const wrapped = withTelemetry(handler, 'exarchos_view', eventStore);

    await wrapped({
      action: 'pipeline',
      featureId: 'feat-ctx',
      sessionId: 'sess-ctx',
      skillContext: 'delegation',
    });

    const files = await fs.readdir(tmpDir);
    const traceFiles = files.filter((f) => f.endsWith('.trace.jsonl'));
    expect(traceFiles).toHaveLength(1);

    const content = await fs.readFile(path.join(tmpDir, traceFiles[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.skillContext).toBe('delegation');
  });
});
