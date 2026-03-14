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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal EvalCase-shaped JSONL line. */
function makeCase(id: string, layer = 'regression'): string {
  return JSON.stringify({
    id,
    type: 'trace',
    description: `Test case ${id}`,
    input: { eventType: 'workflow.started' },
    expected: { eventType: 'task.completed' },
    tags: ['captured'],
    layer,
  });
}

/** Build a minimal suite.json. */
function makeSuiteJson(version = '1.0.0'): string {
  return JSON.stringify({
    description: 'Test suite',
    metadata: { skill: 'test-skill', phaseAffinity: 'delegate', version },
    assertions: [],
    datasets: {
      regression: { path: './datasets/regression.jsonl', description: 'Regression cases' },
    },
  });
}

/**
 * Create a temporary suite directory layout:
 *   <evalsDir>/<suiteName>/suite.json
 *   <evalsDir>/<suiteName>/datasets/<dataset>.jsonl
 */
async function createSuiteFixture(
  evalsDir: string,
  suiteName: string,
  opts?: { version?: string; datasetName?: string; existingCases?: string[] },
): Promise<{ suiteJsonPath: string; datasetPath: string }> {
  const suiteDir = path.join(evalsDir, suiteName);
  const datasetsDir = path.join(suiteDir, 'datasets');
  await fs.mkdir(datasetsDir, { recursive: true });

  const datasetName = opts?.datasetName ?? 'regression';
  const suiteJsonPath = path.join(suiteDir, 'suite.json');
  const datasetPath = path.join(datasetsDir, `${datasetName}.jsonl`);

  await fs.writeFile(suiteJsonPath, makeSuiteJson(opts?.version ?? '1.0.0'), 'utf-8');

  const existingContent = opts?.existingCases?.length
    ? opts.existingCases.join('\n') + '\n'
    : '';
  await fs.writeFile(datasetPath, existingContent, 'utf-8');

  return { suiteJsonPath, datasetPath };
}

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

  // ─── Promote Tests ─────────────────────────────────────────────────────────

  describe('promote', () => {
    let evalsDir: string;

    beforeEach(async () => {
      evalsDir = path.join(tmpDir, 'evals');
      await fs.mkdir(evalsDir, { recursive: true });
    });

    it('EvalCapture_PromoteFlag_AppendsCaseToDataset', async () => {
      // Arrange
      const candidatesPath = path.join(tmpDir, 'candidates.jsonl');
      await fs.writeFile(candidatesPath, makeCase('trace-42') + '\n', 'utf-8');

      const { datasetPath } = await createSuiteFixture(evalsDir, 'delegation');

      // Act
      const result = await handleEvalCapture(
        {
          promote: candidatesPath,
          suite: 'delegation',
          dataset: 'regression',
          ids: ['trace-42'],
          evalsDir,
        },
        tmpDir,
      );

      // Assert
      expect(result.error).toBeUndefined();
      const content = await fs.readFile(datasetPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const promoted = JSON.parse(lines[0]);
      expect(promoted.id).toBe('trace-42');
      expect(promoted.layer).toBe('regression');
    });

    it('EvalCapture_PromoteWithIds_OnlyAddsSelectedCases', async () => {
      // Arrange — candidates has 3, we select 2
      const candidatesPath = path.join(tmpDir, 'candidates.jsonl');
      await fs.writeFile(
        candidatesPath,
        [makeCase('trace-42'), makeCase('trace-88'), makeCase('trace-99')].join('\n') + '\n',
        'utf-8',
      );

      const { datasetPath } = await createSuiteFixture(evalsDir, 'delegation');

      // Act
      const result = await handleEvalCapture(
        {
          promote: candidatesPath,
          suite: 'delegation',
          dataset: 'regression',
          ids: ['trace-42', 'trace-88'],
          evalsDir,
        },
        tmpDir,
      );

      // Assert
      expect(result.error).toBeUndefined();
      const content = await fs.readFile(datasetPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      const ids = lines.map((l) => JSON.parse(l).id);
      expect(ids).toContain('trace-42');
      expect(ids).toContain('trace-88');
      expect(ids).not.toContain('trace-99');
    });

    it('EvalCapture_PromoteToNonexistentSuite_ReturnsError', async () => {
      // Arrange — suite doesn't exist
      const candidatesPath = path.join(tmpDir, 'candidates.jsonl');
      await fs.writeFile(candidatesPath, makeCase('trace-42') + '\n', 'utf-8');

      // Act
      const result = await handleEvalCapture(
        {
          promote: candidatesPath,
          suite: 'nonexistent-suite',
          dataset: 'regression',
          ids: ['trace-42'],
          evalsDir,
        },
        tmpDir,
      );

      // Assert
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('SUITE_NOT_FOUND');
    });

    it('EvalCapture_PromoteDuplicate_SkipsDuplicateCase', async () => {
      // Arrange — dataset already has trace-42
      const candidatesPath = path.join(tmpDir, 'candidates.jsonl');
      await fs.writeFile(candidatesPath, makeCase('trace-42') + '\n', 'utf-8');

      const { datasetPath } = await createSuiteFixture(evalsDir, 'delegation', {
        existingCases: [makeCase('trace-42')],
      });

      // Act
      const result = await handleEvalCapture(
        {
          promote: candidatesPath,
          suite: 'delegation',
          dataset: 'regression',
          ids: ['trace-42'],
          evalsDir,
        },
        tmpDir,
      );

      // Assert
      expect(result.error).toBeUndefined();
      expect(result['skipped']).toBe(1);
      expect(result['promoted']).toBe(0);
      // Dataset should still only have 1 line (the original)
      const content = await fs.readFile(datasetPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
    });

    it('EvalCapture_Promote_IncrementsMetadataVersion', async () => {
      // Arrange
      const candidatesPath = path.join(tmpDir, 'candidates.jsonl');
      await fs.writeFile(candidatesPath, makeCase('trace-42') + '\n', 'utf-8');

      const { suiteJsonPath } = await createSuiteFixture(evalsDir, 'delegation', {
        version: '1.2.3',
      });

      // Act
      const result = await handleEvalCapture(
        {
          promote: candidatesPath,
          suite: 'delegation',
          dataset: 'regression',
          ids: ['trace-42'],
          evalsDir,
        },
        tmpDir,
      );

      // Assert
      expect(result.error).toBeUndefined();
      const suiteJson = JSON.parse(await fs.readFile(suiteJsonPath, 'utf-8'));
      expect(suiteJson.metadata.version).toBe('1.2.4');
    });
  });
});
