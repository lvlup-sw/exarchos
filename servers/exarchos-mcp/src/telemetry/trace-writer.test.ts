import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TraceWriter } from './trace-writer.js';
import { withTelemetry } from './middleware.js';
import { EventStore } from '../event-store/store.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHandler(response: Record<string, unknown> = { success: true, data: {} }) {
  return async (_args: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(response) }],
    isError: false,
  });
}

// ─── TraceWriter Unit Tests ─────────────────────────────────────────────────

describe('TraceWriter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-writer-test-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('TraceWriter_SessionScoped_WritesToCorrectFile', async () => {
    // Arrange
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);
    const writer = new TraceWriter();

    // Act
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

    // Assert — file should be named {featureId}-{sessionId}.trace.jsonl
    const expectedFile = path.join(tmpDir, 'feat-123-sess-abc.trace.jsonl');
    const content = await fs.readFile(expectedFile, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.toolName).toBe('exarchos_workflow');
    expect(parsed.action).toBe('get');
    expect(parsed.durationMs).toBe(42);
  });

  it('TraceWriter_AppendMode_AppendsToExistingFile', async () => {
    // Arrange
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

    // Act — write two entries
    await writer.writeTrace(baseEntry);
    await writer.writeTrace({ ...baseEntry, action: 'set', durationMs: 20 });

    // Assert — both entries should be in the same file, one per line
    const expectedFile = path.join(tmpDir, 'feat-1-sess-1.trace.jsonl');
    const content = await fs.readFile(expectedFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).action).toBe('get');
    expect(JSON.parse(lines[1]).action).toBe('set');
  });

  it('TraceWriter_WriteFailure_DoesNotThrowOrBlockToolCall', async () => {
    // Arrange — point to an invalid directory that can't be created
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', '/dev/null/impossible/path');
    const writer = new TraceWriter();

    // Act & Assert — should not throw
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

// ─── withTelemetry + TraceWriter Integration Tests ──────────────────────────

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
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(eventStoreDir, { recursive: true, force: true });
  });

  it('WithTelemetry_CaptureEnabled_WritesTraceEntry', async () => {
    // Arrange
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);

    const handler = makeHandler({ success: true, data: { key: 'val' } });
    const wrapped = withTelemetry(handler, 'exarchos_workflow', eventStore);

    // Act
    await wrapped({
      action: 'get',
      featureId: 'feat-abc',
      sessionId: 'sess-xyz',
    });

    // Assert — trace file should exist with the entry
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

  it('WithTelemetry_CaptureDisabled_NoTraceWritten', async () => {
    // Arrange — EXARCHOS_EVAL_CAPTURE is NOT set (default: disabled)
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);

    const handler = makeHandler();
    const wrapped = withTelemetry(handler, 'exarchos_workflow', eventStore);

    // Act
    await wrapped({ action: 'get', featureId: 'feat-1', sessionId: 'sess-1' });

    // Assert — no trace files should be written
    const files = await fs.readdir(tmpDir);
    const traceFiles = files.filter((f) => f.endsWith('.trace.jsonl'));
    expect(traceFiles).toHaveLength(0);
  });

  it('WithTelemetry_CaptureEnabled_TruncatesLargeInput', async () => {
    // Arrange
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);

    const largeInput = 'x'.repeat(5000);
    const handler = makeHandler();
    const wrapped = withTelemetry(handler, 'exarchos_workflow', eventStore);

    // Act
    await wrapped({
      action: 'set',
      featureId: 'feat-big',
      sessionId: 'sess-big',
      largeField: largeInput,
    });

    // Assert — input should be truncated to 2KB
    const files = await fs.readdir(tmpDir);
    const traceFiles = files.filter((f) => f.endsWith('.trace.jsonl'));
    expect(traceFiles).toHaveLength(1);

    const content = await fs.readFile(path.join(tmpDir, traceFiles[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.input.length).toBeLessThanOrEqual(2048);
  });

  it('WithTelemetry_CaptureEnabled_IncludesSkillContext', async () => {
    // Arrange
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE', '1');
    vi.stubEnv('EXARCHOS_EVAL_CAPTURE_DIR', tmpDir);

    const handler = makeHandler();
    const wrapped = withTelemetry(handler, 'exarchos_view', eventStore);

    // Act
    await wrapped({
      action: 'pipeline',
      featureId: 'feat-ctx',
      sessionId: 'sess-ctx',
      skillContext: 'delegation',
    });

    // Assert — trace entry should include skillContext
    const files = await fs.readdir(tmpDir);
    const traceFiles = files.filter((f) => f.endsWith('.trace.jsonl'));
    expect(traceFiles).toHaveLength(1);

    const content = await fs.readFile(path.join(tmpDir, traceFiles[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.skillContext).toBe('delegation');
  });
});
