import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handlePreCompact } from './pre-compact.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

/** Create a minimal valid state file for testing. */
function createMockState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.1',
    featureId: 'test-feature',
    workflowType: 'feature',
    phase: 'delegate',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    _version: 1,
    artifacts: { design: 'docs/designs/test.md', plan: 'docs/plans/test.md', pr: null },
    tasks: [
      { id: 'T1', title: 'Test task one', status: 'complete' },
      { id: 'T2', title: 'Test task two', status: 'in_progress' },
    ],
    worktrees: {},
    reviews: {},
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _history: {},
    _checkpoint: {
      timestamp: '2026-01-01T00:00:00Z',
      phase: 'delegate',
      summary: 'Delegation in progress',
      operationsSince: 5,
      fixCycleCount: 0,
      lastActivityTimestamp: '2026-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    },
    ...overrides,
  };
}

async function writeMockState(
  stateDir: string,
  featureId: string,
  stateOverrides: Record<string, unknown> = {},
): Promise<string> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const state = createMockState({ featureId, ...stateOverrides });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  return stateFile;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('pre-compact', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pre-compact-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('handlePreCompact', () => {
    it('should write checkpoint file when active workflow exists', async () => {
      // Arrange
      const stateDir = tmpDir;
      await writeMockState(stateDir, 'test-feature');

      // Act
      await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      const checkpointPath = path.join(stateDir, 'test-feature.checkpoint.json');
      const checkpointRaw = await fs.readFile(checkpointPath, 'utf-8');
      const checkpoint = JSON.parse(checkpointRaw);
      expect(checkpoint).toBeDefined();
      expect(checkpoint.featureId).toBe('test-feature');
    });

    it('should return continue false when active workflows exist', async () => {
      // Arrange
      const stateDir = tmpDir;
      await writeMockState(stateDir, 'test-feature');

      // Act
      const result = await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      expect(result.continue).toBe(false);
      expect(result.stopReason).toContain('1 workflow(s)');
    });

    it('should write checkpoint with phase, tasks, and nextAction fields', async () => {
      // Arrange
      const stateDir = tmpDir;
      await writeMockState(stateDir, 'test-feature', {
        phase: 'delegate',
        tasks: [
          { id: 'T1', title: 'First task', status: 'complete' },
          { id: 'T2', title: 'Second task', status: 'in_progress' },
        ],
      });

      // Act
      await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      const checkpointPath = path.join(stateDir, 'test-feature.checkpoint.json');
      const checkpointRaw = await fs.readFile(checkpointPath, 'utf-8');
      const checkpoint = JSON.parse(checkpointRaw);

      expect(checkpoint.phase).toBe('delegate');
      expect(checkpoint.tasks).toEqual([
        { id: 'T1', title: 'First task', status: 'complete' },
        { id: 'T2', title: 'Second task', status: 'in_progress' },
      ]);
      expect(checkpoint.nextAction).toBeDefined();
      expect(typeof checkpoint.nextAction).toBe('string');
      expect(checkpoint.summary).toBeDefined();
      expect(typeof checkpoint.summary).toBe('string');
      expect(checkpoint.timestamp).toBeDefined();
      expect(checkpoint.stateFile).toBeDefined();
      expect(checkpoint.artifacts).toBeDefined();
    });

    it('should return continue true when no active workflows exist', async () => {
      // Arrange — empty state dir
      const stateDir = tmpDir;

      // Act
      const result = await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      expect(result.continue).toBe(true);
      expect(result.stopReason).toBeUndefined();
    });

    it('should checkpoint all workflows when multiple active workflows exist', async () => {
      // Arrange
      const stateDir = tmpDir;
      await writeMockState(stateDir, 'feature-one', {
        phase: 'delegate',
        workflowType: 'feature',
      });
      await writeMockState(stateDir, 'feature-two', {
        phase: 'review',
        workflowType: 'feature',
      });

      // Act
      const result = await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      expect(result.continue).toBe(false);
      expect(result.stopReason).toContain('2 workflow(s)');

      const cp1Path = path.join(stateDir, 'feature-one.checkpoint.json');
      const cp2Path = path.join(stateDir, 'feature-two.checkpoint.json');

      const cp1 = JSON.parse(await fs.readFile(cp1Path, 'utf-8'));
      const cp2 = JSON.parse(await fs.readFile(cp2Path, 'utf-8'));

      expect(cp1.featureId).toBe('feature-one');
      expect(cp1.phase).toBe('delegate');
      expect(cp2.featureId).toBe('feature-two');
      expect(cp2.phase).toBe('review');
    });

    it('should skip completed workflows when checkpointing', async () => {
      // Arrange
      const stateDir = tmpDir;
      await writeMockState(stateDir, 'active-wf', {
        phase: 'delegate',
        workflowType: 'feature',
      });
      await writeMockState(stateDir, 'done-wf', {
        phase: 'completed',
        workflowType: 'feature',
      });

      // Act
      const result = await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      expect(result.continue).toBe(false);
      expect(result.stopReason).toContain('1 workflow(s)');

      const activeCp = path.join(stateDir, 'active-wf.checkpoint.json');
      const doneCp = path.join(stateDir, 'done-wf.checkpoint.json');

      // Active workflow should have checkpoint
      const cp = JSON.parse(await fs.readFile(activeCp, 'utf-8'));
      expect(cp.featureId).toBe('active-wf');

      // Completed workflow should not have checkpoint
      await expect(fs.access(doneCp)).rejects.toThrow();
    });

    it('should skip cancelled workflows when checkpointing', async () => {
      // Arrange
      const stateDir = tmpDir;
      await writeMockState(stateDir, 'cancelled-wf', {
        phase: 'cancelled',
        workflowType: 'feature',
      });

      // Act
      const result = await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      expect(result.continue).toBe(true);
    });

    it('should handle manual trigger type the same as auto', async () => {
      // Arrange
      const stateDir = tmpDir;
      await writeMockState(stateDir, 'test-feature');

      // Act
      const result = await handlePreCompact({ event: 'PreCompact', type: 'manual' }, stateDir);

      // Assert
      expect(result.continue).toBe(false);
    });

    it('should return continue true when state directory does not exist', async () => {
      // Arrange
      const stateDir = path.join(tmpDir, 'nonexistent');

      // Act
      const result = await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      expect(result.continue).toBe(true);
    });
  });

  describe('team composition snapshot', () => {
    it('should include teamState in checkpoint when delegate phase has teamState', async () => {
      // Arrange
      const stateDir = tmpDir;
      const teamState = {
        teammates: [{ name: 'worker-1', status: 'active', taskId: 'task-001' }],
      };
      await writeMockState(stateDir, 'team-feature', {
        phase: 'delegate',
        teamState,
      });

      // Act
      await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      const checkpointPath = path.join(stateDir, 'team-feature.checkpoint.json');
      const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf-8'));
      expect(checkpoint.teamState).toEqual(teamState);
    });

    it('should not include teamState in checkpoint when not in delegate phase', async () => {
      // Arrange
      const stateDir = tmpDir;
      const teamState = {
        teammates: [{ name: 'worker-1', status: 'active', taskId: 'task-001' }],
      };
      await writeMockState(stateDir, 'review-feature', {
        phase: 'review',
        teamState,
      });

      // Act
      await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      const checkpointPath = path.join(stateDir, 'review-feature.checkpoint.json');
      const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf-8'));
      expect(checkpoint.teamState).toBeUndefined();
    });

    it('should omit teamState from checkpoint when delegate phase has no teamState', async () => {
      // Arrange
      const stateDir = tmpDir;
      await writeMockState(stateDir, 'no-team-feature', {
        phase: 'delegate',
        // no teamState property
      });

      // Act
      await handlePreCompact({ event: 'PreCompact', type: 'auto' }, stateDir);

      // Assert
      const checkpointPath = path.join(stateDir, 'no-team-feature.checkpoint.json');
      const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf-8'));
      expect(checkpoint.teamState).toBeUndefined();
    });
  });
});
