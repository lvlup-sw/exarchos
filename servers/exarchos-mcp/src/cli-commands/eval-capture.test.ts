import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: vi.fn().mockReturnValue({
    query: vi.fn().mockResolvedValue([]),
  }),
}));

import { handleEvalCapture } from './eval-capture.js';
import { getOrCreateEventStore } from '../views/tools.js';

const mockGetOrCreateEventStore = vi.mocked(getOrCreateEventStore);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleEvalCapture', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-capture-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleEvalCapture_ValidInput_WritesJSONLFile', async () => {
    // Arrange
    const outputFile = path.join(tmpDir, 'captured.jsonl');
    const mockStore = {
      query: vi.fn().mockResolvedValue([
        {
          type: 'workflow.started',
          data: { featureId: 'feat-1', workflowType: 'feature' },
          streamId: 'test-stream',
          sequence: 1,
          timestamp: '2025-01-01T00:00:00.000Z',
          schemaVersion: '1.0',
        },
        {
          type: 'task.completed',
          data: { taskId: 'task-1', artifacts: ['file.ts'] },
          streamId: 'test-stream',
          sequence: 2,
          timestamp: '2025-01-01T00:00:01.000Z',
          schemaVersion: '1.0',
        },
      ]),
    };
    mockGetOrCreateEventStore.mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);

    // Act
    const result = await handleEvalCapture(
      { stream: 'test-stream', output: outputFile },
      tmpDir,
    );

    // Assert
    expect(result.error).toBeUndefined();
    const content = await fs.readFile(outputFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.id).toBeTruthy();
      expect(parsed.type).toBe('trace');
    }
  });

  it('handleEvalCapture_MissingStream_ReturnsError', async () => {
    // Arrange — no stream field
    const stdinData = { output: path.join(tmpDir, 'out.jsonl') };

    // Act
    const result = await handleEvalCapture(stdinData, tmpDir);

    // Assert
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('MISSING_STREAM');
  });
});
