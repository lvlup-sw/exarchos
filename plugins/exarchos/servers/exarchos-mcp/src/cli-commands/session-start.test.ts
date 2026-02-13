import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleSessionStart } from './session-start.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal valid checkpoint data matching the pre-compact output format. */
function createCheckpointFile(overrides: Partial<CheckpointData> = {}): CheckpointData {
  return {
    featureId: 'test-feature',
    timestamp: '2025-01-01T00:00:00Z',
    phase: 'delegate',
    summary: 'Delegating tasks to subagents',
    nextAction: 'AUTO:delegate',
    tasks: [
      { id: 'T1', status: 'complete', title: 'Task one' },
      { id: 'T2', status: 'pending', title: 'Task two' },
    ],
    artifacts: { design: 'design.md' },
    stateFile: '/tmp/test-feature.state.json',
    ...overrides,
  };
}

interface CheckpointData {
  readonly featureId: string;
  readonly timestamp: string;
  readonly phase: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly tasks: ReadonlyArray<{ id: string; status: string; title: string }>;
  readonly artifacts: Record<string, unknown>;
  readonly stateFile: string;
}

/** Minimal valid workflow state file for testing. */
function createValidStateFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.1',
    featureId: 'test-feature',
    workflowType: 'feature',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    phase: 'delegate',
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _version: 1,
    _history: {},
    _checkpoint: {
      timestamp: '2025-01-01T00:00:00Z',
      phase: 'delegate',
      summary: 'Test',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '2025-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    },
    ...overrides,
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('session-start command', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-start-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('handleSessionStart', () => {
    it('should output resume context when checkpoint exists', async () => {
      // Arrange
      const checkpoint = createCheckpointFile();
      await fs.writeFile(
        path.join(tmpDir, `${checkpoint.featureId}.checkpoint.json`),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows).toBeDefined();
      expect(result.workflows).toHaveLength(1);
      const workflow = result.workflows![0];
      expect(workflow.featureId).toBe('test-feature');
      expect(workflow.phase).toBe('delegate');
      expect(workflow.summary).toBe('Delegating tasks to subagents');
      expect(workflow.nextAction).toBe('AUTO:delegate');
    });

    it('should include auto directive from checkpoint nextAction', async () => {
      // Arrange
      const checkpoint = createCheckpointFile({ nextAction: 'AUTO:review' });
      await fs.writeFile(
        path.join(tmpDir, `${checkpoint.featureId}.checkpoint.json`),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows).toBeDefined();
      expect(result.workflows![0].nextAction).toBe('AUTO:review');
    });

    it('should include task progress from checkpoint', async () => {
      // Arrange
      const checkpoint = createCheckpointFile({
        tasks: [
          { id: 'T1', status: 'complete', title: 'First' },
          { id: 'T2', status: 'in-progress', title: 'Second' },
          { id: 'T3', status: 'pending', title: 'Third' },
        ],
      });
      await fs.writeFile(
        path.join(tmpDir, `${checkpoint.featureId}.checkpoint.json`),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows![0].tasks).toHaveLength(3);
      expect(result.workflows![0].tasks![0]).toEqual({
        id: 'T1',
        status: 'complete',
        title: 'First',
      });
    });

    it('should clean up checkpoint file after reading', async () => {
      // Arrange
      const checkpoint = createCheckpointFile();
      const checkpointPath = path.join(tmpDir, `${checkpoint.featureId}.checkpoint.json`);
      await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));

      // Act
      await handleSessionStart({}, tmpDir);

      // Assert
      await expect(fs.access(checkpointPath)).rejects.toThrow();
    });

    it('should output nothing when no checkpoints and no active workflows', async () => {
      // Arrange — empty state directory, no checkpoints, no state files

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('should discover active workflows when no checkpoint exists', async () => {
      // Arrange — state file but no checkpoint
      const stateData = createValidStateFile();
      await fs.writeFile(
        path.join(tmpDir, 'test-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows).toBeDefined();
      expect(result.workflows).toHaveLength(1);
      const workflow = result.workflows![0];
      expect(workflow.featureId).toBe('test-feature');
      expect(workflow.phase).toBe('delegate');
    });

    it('should skip completed workflows during discovery', async () => {
      // Arrange — only a completed workflow, no checkpoint
      const stateData = createValidStateFile({ phase: 'completed' });
      await fs.writeFile(
        path.join(tmpDir, 'done-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows).toBeUndefined();
    });

    it('should skip cancelled workflows during discovery', async () => {
      // Arrange — only a cancelled workflow, no checkpoint
      const stateData = createValidStateFile({ phase: 'cancelled' });
      await fs.writeFile(
        path.join(tmpDir, 'cancelled-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows).toBeUndefined();
    });

    it('should handle multiple checkpoint files', async () => {
      // Arrange
      const checkpoint1 = createCheckpointFile({
        featureId: 'feature-one',
        phase: 'delegate',
        nextAction: 'AUTO:delegate',
      });
      const checkpoint2 = createCheckpointFile({
        featureId: 'feature-two',
        phase: 'review',
        nextAction: 'AUTO:review',
      });
      await fs.writeFile(
        path.join(tmpDir, 'feature-one.checkpoint.json'),
        JSON.stringify(checkpoint1),
      );
      await fs.writeFile(
        path.join(tmpDir, 'feature-two.checkpoint.json'),
        JSON.stringify(checkpoint2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows).toHaveLength(2);
      const featureIds = result.workflows!.map((w) => w.featureId);
      expect(featureIds).toContain('feature-one');
      expect(featureIds).toContain('feature-two');
    });

    it('should handle non-existent state directory gracefully', async () => {
      // Arrange
      const nonExistentDir = path.join(tmpDir, 'does-not-exist');

      // Act
      const result = await handleSessionStart({}, nonExistentDir);

      // Assert
      expect(result.workflows).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('should prefer checkpoint over state file for the same workflow', async () => {
      // Arrange — both checkpoint and state file exist
      const checkpoint = createCheckpointFile({
        featureId: 'test-feature',
        summary: 'Checkpoint summary',
        nextAction: 'AUTO:synthesize',
      });
      const stateData = createValidStateFile({ featureId: 'test-feature' });

      await fs.writeFile(
        path.join(tmpDir, 'test-feature.checkpoint.json'),
        JSON.stringify(checkpoint),
      );
      await fs.writeFile(
        path.join(tmpDir, 'test-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert — should have exactly 1 entry (checkpoint takes precedence)
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows![0].summary).toBe('Checkpoint summary');
      expect(result.workflows![0].nextAction).toBe('AUTO:synthesize');
    });

    it('should handle malformed checkpoint file gracefully', async () => {
      // Arrange — invalid JSON in checkpoint
      await fs.writeFile(
        path.join(tmpDir, 'bad-feature.checkpoint.json'),
        '{ not valid json }',
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert — should not crash, just skip the bad checkpoint
      expect(result.error).toBeUndefined();
    });
  });
});
