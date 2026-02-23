import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleQualityCheck } from './quality-check.js';
import { EventStore } from '../event-store/store.js';
import { resetMaterializerCache } from '../views/tools.js';

describe('handleQualityCheck', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-quality-check-'));
  });

  afterEach(async () => {
    resetMaterializerCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('HandleQualityCheck_WithRegressions_OutputsReport', async () => {
    // Arrange: seed 3 consecutive gate failures to trigger regression detection
    const store = new EventStore(tmpDir);
    for (let i = 1; i <= 3; i++) {
      await store.append('test', {
        streamId: 'test',
        sequence: i,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        data: {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 100,
          details: { skill: 'delegation', commit: `commit-${i}`, reason: 'type error' },
        },
        schemaVersion: '1.0',
      });
    }

    // Act
    const result = await handleQualityCheck({ workflowId: 'test' }, tmpDir);

    // Assert
    expect(result.error).toBeUndefined();
    expect(result).toHaveProperty('regressions');
    expect(result).toHaveProperty('summary');
    const regressions = result.regressions as unknown[];
    expect(regressions.length).toBeGreaterThanOrEqual(1);
    const summary = result.summary as Record<string, unknown>;
    expect(summary.status).toBe('regressions-detected');
    expect(summary.regressionCount).toBeGreaterThanOrEqual(1);
  });

  it('HandleQualityCheck_NoRegressions_ReportsClean', async () => {
    // Arrange: empty state dir (no events)

    // Act
    const result = await handleQualityCheck({}, tmpDir);

    // Assert
    expect(result.error).toBeUndefined();
    expect(result.regressions).toEqual([]);
    const summary = result.summary as Record<string, unknown>;
    expect(summary.status).toBe('clean');
    expect(summary.regressionCount).toBe(0);
  });
});
