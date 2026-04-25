import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleSessionStart, detectNativeTeam, queryTelemetryHints } from './session-start.js';

vi.mock('../session/manifest.js', () => ({
  writeManifestEntry: vi.fn().mockResolvedValue(undefined),
  findUnextractedSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../session/transcript-parser.js', () => ({
  parseTranscript: vi.fn().mockResolvedValue([]),
}));

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
  readonly teamState?: unknown;
  readonly contextFile?: string;
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

    it('should handle state directory being a file (ENOTDIR) gracefully', async () => {
      // Arrange — create a file where a directory is expected
      const filePath = path.join(tmpDir, 'not-a-dir');
      await fs.writeFile(filePath, 'I am a file, not a directory');

      // Act
      const result = await handleSessionStart({}, filePath);

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

    it('should not include checkpoint in results if file deletion fails', async () => {
      // Arrange — write checkpoint in a subdirectory, then remove write
      // permission from the directory so fs.unlink fails with EACCES.
      const lockedDir = path.join(tmpDir, 'locked');
      await fs.mkdir(lockedDir);

      const checkpoint = createCheckpointFile({ featureId: 'undeletable' });
      const checkpointPath = path.join(lockedDir, 'undeletable.checkpoint.json');
      await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));

      // Remove write permission from directory — unlink will fail with EACCES
      await fs.chmod(lockedDir, 0o555);

      try {
        // Act
        const result = await handleSessionStart({}, lockedDir);

        // Assert — the undeletable checkpoint should NOT appear in results
        const featureIds = (result.workflows ?? []).map((w) => w.featureId);
        expect(featureIds).not.toContain('undeletable');

        // Verify the file still exists on disk (deletion failed)
        await expect(fs.access(checkpointPath)).resolves.toBeUndefined();
      } finally {
        // Restore permissions so afterEach cleanup can remove the directory
        await fs.chmod(lockedDir, 0o755);
      }
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

    it('should skip checkpoint with valid JSON but missing required fields', async () => {
      // Arrange — valid JSON but missing `tasks` and `stateFile` fields
      const malformed = {
        featureId: 'partial-feature',
        timestamp: '2025-01-01T00:00:00Z',
        phase: 'delegate',
        summary: 'Missing tasks and stateFile',
        nextAction: 'AUTO:delegate',
        // tasks and stateFile intentionally omitted
      };
      const filePath = path.join(tmpDir, 'partial-feature.checkpoint.json');
      await fs.writeFile(filePath, JSON.stringify(malformed));

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert — malformed checkpoint should be skipped entirely
      const featureIds = (result.workflows ?? []).map((w) => w.featureId);
      expect(featureIds).not.toContain('partial-feature');

      // Assert — the malformed file should NOT be deleted (skipped before unlink)
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    });

    // ─── Context Document Injection Tests ──────────────────────────────────────

    it('should include contextDocument when checkpoint has contextFile', async () => {
      // Arrange
      const contextContent = '## Workflow Context: test-feature\n**Phase:** delegate';
      const contextPath = path.join(tmpDir, 'test-feature.context.md');
      await fs.writeFile(contextPath, contextContent);

      const checkpoint = createCheckpointFile({
        featureId: 'test-feature',
        contextFile: contextPath,
      });
      await fs.writeFile(
        path.join(tmpDir, 'test-feature.checkpoint.json'),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.contextDocument).toBeDefined();
      expect(result.contextDocument).toContain('Workflow Context');
    });

    it('should not include contextDocument when checkpoint has no contextFile', async () => {
      // Arrange — checkpoint without contextFile field
      const checkpoint = createCheckpointFile({ featureId: 'test-feature' });
      await fs.writeFile(
        path.join(tmpDir, 'test-feature.checkpoint.json'),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.contextDocument).toBeUndefined();
      expect(result.workflows).toBeDefined();
      expect(result.workflows).toHaveLength(1);
    });

    it('should degrade gracefully when contextFile is referenced but missing', async () => {
      // Arrange — checkpoint references context.md that doesn't exist
      const checkpoint = createCheckpointFile({
        featureId: 'test-feature',
        contextFile: path.join(tmpDir, 'nonexistent.context.md'),
      });
      await fs.writeFile(
        path.join(tmpDir, 'test-feature.checkpoint.json'),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.contextDocument).toBeUndefined();
      expect(result.workflows).toBeDefined();
      // Should not crash — workflow info still present
    });

    it('should delete context.md after reading', async () => {
      // Arrange
      const contextPath = path.join(tmpDir, 'test-feature.context.md');
      await fs.writeFile(contextPath, '## Workflow Context: test-feature');

      const checkpoint = createCheckpointFile({
        featureId: 'test-feature',
        contextFile: contextPath,
      });
      await fs.writeFile(
        path.join(tmpDir, 'test-feature.checkpoint.json'),
        JSON.stringify(checkpoint),
      );

      // Act
      await handleSessionStart({}, tmpDir);

      // Assert — context.md should be deleted after reading
      await expect(fs.access(contextPath)).rejects.toThrow();
    });

    it('should not include contextDocument when active workflow has no checkpoint', async () => {
      // Arrange — state file but no checkpoint
      const stateData = createValidStateFile();
      await fs.writeFile(
        path.join(tmpDir, 'test-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.contextDocument).toBeUndefined();
      expect(result.workflows).toBeDefined();
    });

    it('should combine context documents from multiple checkpoints', async () => {
      // Arrange
      const contextPath1 = path.join(tmpDir, 'feature-one.context.md');
      const contextPath2 = path.join(tmpDir, 'feature-two.context.md');
      await fs.writeFile(contextPath1, '## Workflow Context: feature-one');
      await fs.writeFile(contextPath2, '## Workflow Context: feature-two');

      const checkpoint1 = createCheckpointFile({
        featureId: 'feature-one',
        contextFile: contextPath1,
      });
      const checkpoint2 = createCheckpointFile({
        featureId: 'feature-two',
        contextFile: contextPath2,
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
      expect(result.contextDocument).toBeDefined();
      expect(result.contextDocument).toContain('feature-one');
      expect(result.contextDocument).toContain('feature-two');
      expect(result.contextDocument).toContain('---');  // separator between documents
    });
  });

  describe('orphaned team recovery detection', () => {
    it('should include recovery info when delegate phase has active teammates', async () => {
      // Arrange
      const checkpoint = createCheckpointFile({
        featureId: 'team-feature',
        phase: 'delegate',
        teamState: {
          teammates: [{ name: 'w1', status: 'active' }],
        },
        tasks: [
          { id: 'T1', status: 'complete', title: 'Done task' },
          { id: 'T2', status: 'in_progress', title: 'Active task' },
          { id: 'T3', status: 'pending', title: 'Pending task' },
        ],
      });
      await fs.writeFile(
        path.join(tmpDir, 'team-feature.checkpoint.json'),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows).toBeDefined();
      const workflow = result.workflows!.find((w) => w.featureId === 'team-feature');
      expect(workflow).toBeDefined();
      expect(workflow!.recovery).toBeDefined();
      expect(workflow!.recovery!.type).toBe('orphaned_team');
      expect(workflow!.recovery!.remainingTasks).toBeGreaterThan(0);
    });

    it('should include recovery info when overhaul-delegate phase has active teammates', async () => {
      // Arrange
      const checkpoint = createCheckpointFile({
        featureId: 'overhaul-feature',
        phase: 'overhaul-delegate',
        teamState: {
          teammates: [{ name: 'w1', status: 'active' }],
        },
        tasks: [
          { id: 'T1', status: 'complete', title: 'Done task' },
          { id: 'T2', status: 'in_progress', title: 'Active task' },
        ],
      });
      await fs.writeFile(
        path.join(tmpDir, 'overhaul-feature.checkpoint.json'),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.workflows).toBeDefined();
      const workflow = result.workflows!.find((w) => w.featureId === 'overhaul-feature');
      expect(workflow).toBeDefined();
      expect(workflow!.recovery).toBeDefined();
      expect(workflow!.recovery!.type).toBe('orphaned_team');
      expect(workflow!.recovery!.completedTasks).toBe(1);
      expect(workflow!.recovery!.remainingTasks).toBe(1);
    });

    it('should not include recovery info when delegate phase has no teamState', async () => {
      // Arrange
      const checkpoint = createCheckpointFile({
        featureId: 'no-team',
        phase: 'delegate',
        // no teamState
      });
      await fs.writeFile(
        path.join(tmpDir, 'no-team.checkpoint.json'),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      const workflow = result.workflows!.find((w) => w.featureId === 'no-team');
      expect(workflow).toBeDefined();
      expect(workflow!.recovery).toBeUndefined();
    });

    it('should not include recovery info when all teammates are completed', async () => {
      // Arrange
      const checkpoint = createCheckpointFile({
        featureId: 'done-team',
        phase: 'delegate',
        teamState: {
          teammates: [
            { name: 'w1', status: 'completed' },
            { name: 'w2', status: 'completed' },
          ],
        },
      });
      await fs.writeFile(
        path.join(tmpDir, 'done-team.checkpoint.json'),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      const workflow = result.workflows!.find((w) => w.featureId === 'done-team');
      expect(workflow).toBeDefined();
      expect(workflow!.recovery).toBeUndefined();
    });

    it('should not include recovery info when review phase has teamState', async () => {
      // Arrange
      const checkpoint = createCheckpointFile({
        featureId: 'review-team',
        phase: 'review',
        teamState: {
          teammates: [{ name: 'w1', status: 'active' }],
        },
      });
      await fs.writeFile(
        path.join(tmpDir, 'review-team.checkpoint.json'),
        JSON.stringify(checkpoint),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      const workflow = result.workflows!.find((w) => w.featureId === 'review-team');
      expect(workflow).toBeDefined();
      expect(workflow!.recovery).toBeUndefined();
    });
  });

  // ─── Native Team Directory Detection ────────────────────────────────────────

  describe('detectNativeTeam', () => {
    let teamsDir: string;

    beforeEach(async () => {
      teamsDir = path.join(tmpDir, 'teams');
      await fs.mkdir(teamsDir, { recursive: true });
    });

    it('should return team info when directory format config exists with members', async () => {
      // Arrange — ~/.claude/teams/{featureId}/config.json
      const featureId = 'my-feature';
      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [
            { name: 'agent-auth', role: 'teammate' },
            { name: 'agent-api', role: 'teammate' },
          ],
        }),
      );

      // Act
      const result = await detectNativeTeam(featureId, teamsDir);

      // Assert
      expect(result).not.toBeNull();
      expect(result!.memberCount).toBe(2);
      expect(result!.memberNames).toContain('agent-auth');
      expect(result!.memberNames).toContain('agent-api');
    });

    it('should return team info when flat file format exists with members', async () => {
      // Arrange — ~/.claude/teams/{featureId}.json
      const featureId = 'flat-feature';
      await fs.writeFile(
        path.join(teamsDir, `${featureId}.json`),
        JSON.stringify({
          members: [
            { name: 'agent-ui', role: 'teammate' },
          ],
        }),
      );

      // Act
      const result = await detectNativeTeam(featureId, teamsDir);

      // Assert
      expect(result).not.toBeNull();
      expect(result!.memberCount).toBe(1);
      expect(result!.memberNames).toContain('agent-ui');
    });

    it('should return null when no team directory or file exists', async () => {
      // Arrange — nothing created

      // Act
      const result = await detectNativeTeam('nonexistent-feature', teamsDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when config file is empty or malformed', async () => {
      // Arrange — directory format with invalid JSON
      const featureId = 'malformed-feature';
      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        '{ not valid json }',
      );

      // Act
      const result = await detectNativeTeam(featureId, teamsDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when config has no members array', async () => {
      // Arrange — valid JSON but no members field
      const featureId = 'no-members-feature';
      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ name: 'some team' }),
      );

      // Act
      const result = await detectNativeTeam(featureId, teamsDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when members array is empty', async () => {
      // Arrange
      const featureId = 'empty-members-feature';
      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ members: [] }),
      );

      // Act
      const result = await detectNativeTeam(featureId, teamsDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should prefer directory format over flat file format', async () => {
      // Arrange — both formats exist with different data
      const featureId = 'both-formats';
      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [
            { name: 'dir-agent-1', role: 'teammate' },
            { name: 'dir-agent-2', role: 'teammate' },
          ],
        }),
      );
      await fs.writeFile(
        path.join(teamsDir, `${featureId}.json`),
        JSON.stringify({
          members: [{ name: 'flat-agent-1', role: 'teammate' }],
        }),
      );

      // Act
      const result = await detectNativeTeam(featureId, teamsDir);

      // Assert — directory format should take precedence
      expect(result).not.toBeNull();
      expect(result!.memberCount).toBe(2);
      expect(result!.memberNames).toContain('dir-agent-1');
    });

    it('should return null when teams base directory does not exist', async () => {
      // Act
      const result = await detectNativeTeam('any-feature', '/nonexistent/teams');

      // Assert
      expect(result).toBeNull();
    });
  });

  // ─── Native Team Cleanup Recommendations in handleSessionStart ─────────────

  describe('native team cleanup recommendations', () => {
    let teamsDir: string;

    beforeEach(async () => {
      teamsDir = path.join(tmpDir, 'teams');
      await fs.mkdir(teamsDir, { recursive: true });
    });

    it('should include cleanup recommendation when native team exists and workflow is past delegation', async () => {
      // Arrange — workflow in review phase + native team directory
      const featureId = 'team-past-delegate';
      const stateData = createValidStateFile({
        featureId,
        phase: 'review',
      });
      await fs.writeFile(
        path.join(tmpDir, `${featureId}.state.json`),
        JSON.stringify(stateData, null, 2),
      );

      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [{ name: 'agent-1', role: 'teammate' }],
        }),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir, teamsDir);

      // Assert
      expect(result.workflows).toBeDefined();
      const workflow = result.workflows!.find((w) => w.featureId === featureId);
      expect(workflow).toBeDefined();
      expect(workflow!.nativeTeamCleanup).toBeDefined();
      expect(workflow!.nativeTeamCleanup).toContain('Orphaned native team detected');
      expect(workflow!.nativeTeamCleanup).toContain(featureId);
      expect(workflow!.nativeTeamCleanup).toContain('TeamDelete');
    });

    it('should not warn when native team exists and workflow is in delegation phase', async () => {
      // Arrange — workflow in delegate phase + native team
      const featureId = 'team-in-delegate';
      const stateData = createValidStateFile({
        featureId,
        phase: 'delegate',
      });
      await fs.writeFile(
        path.join(tmpDir, `${featureId}.state.json`),
        JSON.stringify(stateData, null, 2),
      );

      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [{ name: 'agent-1', role: 'teammate' }],
        }),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir, teamsDir);

      // Assert
      expect(result.workflows).toBeDefined();
      const workflow = result.workflows!.find((w) => w.featureId === featureId);
      expect(workflow).toBeDefined();
      expect(workflow!.nativeTeamCleanup).toBeUndefined();
    });

    it('should warn about orphaned team when team exists but no workflow found', async () => {
      // Arrange — native team directory exists, but no workflow state file
      const featureId = 'orphaned-team-no-workflow';
      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [{ name: 'agent-orphan', role: 'teammate' }],
        }),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir, teamsDir);

      // Assert — should have a workflow entry for the orphaned team warning
      expect(result.orphanedTeams).toBeDefined();
      expect(result.orphanedTeams).toHaveLength(1);
      expect(result.orphanedTeams![0]).toContain(featureId);
      expect(result.orphanedTeams![0]).toContain('TeamDelete');
    });

    it('should not produce warnings when no native teams exist', async () => {
      // Arrange — workflow exists but no team directories
      const featureId = 'no-team-feature';
      const stateData = createValidStateFile({
        featureId,
        phase: 'review',
      });
      await fs.writeFile(
        path.join(tmpDir, `${featureId}.state.json`),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir, teamsDir);

      // Assert
      expect(result.workflows).toBeDefined();
      const workflow = result.workflows!.find((w) => w.featureId === featureId);
      expect(workflow).toBeDefined();
      expect(workflow!.nativeTeamCleanup).toBeUndefined();
      expect(result.orphanedTeams).toBeUndefined();
    });

    it('should include cleanup for synthesize phase workflow with native team', async () => {
      // Arrange
      const featureId = 'synth-team';
      const stateData = createValidStateFile({
        featureId,
        phase: 'synthesize',
      });
      await fs.writeFile(
        path.join(tmpDir, `${featureId}.state.json`),
        JSON.stringify(stateData, null, 2),
      );

      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [{ name: 'agent-synth', role: 'teammate' }],
        }),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir, teamsDir);

      // Assert
      expect(result.workflows).toBeDefined();
      const workflow = result.workflows!.find((w) => w.featureId === featureId);
      expect(workflow).toBeDefined();
      expect(workflow!.nativeTeamCleanup).toBeDefined();
      expect(workflow!.nativeTeamCleanup).toContain('Orphaned native team detected');
    });

    it('should not warn for overhaul-delegate phase workflow with native team', async () => {
      // Arrange — refactor workflow in overhaul-delegate phase (delegation active)
      const featureId = 'overhaul-delegate-team';
      const stateData = createValidStateFile({
        featureId,
        workflowType: 'refactor',
        phase: 'overhaul-delegate',
      });
      await fs.writeFile(
        path.join(tmpDir, `${featureId}.state.json`),
        JSON.stringify(stateData, null, 2),
      );

      const teamDir = path.join(teamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [{ name: 'agent-overhaul', role: 'teammate' }],
        }),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir, teamsDir);

      // Assert
      expect(result.workflows).toBeDefined();
      const workflow = result.workflows!.find((w) => w.featureId === featureId);
      expect(workflow).toBeDefined();
      expect(workflow!.nativeTeamCleanup).toBeUndefined();
    });

    it('should detect orphaned teams from flat file format too', async () => {
      // Arrange — flat file format team + workflow past delegation
      const featureId = 'flat-file-team';
      const stateData = createValidStateFile({
        featureId,
        phase: 'review',
      });
      await fs.writeFile(
        path.join(tmpDir, `${featureId}.state.json`),
        JSON.stringify(stateData, null, 2),
      );

      await fs.writeFile(
        path.join(teamsDir, `${featureId}.json`),
        JSON.stringify({
          members: [{ name: 'flat-agent', role: 'teammate' }],
        }),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir, teamsDir);

      // Assert
      expect(result.workflows).toBeDefined();
      const workflow = result.workflows!.find((w) => w.featureId === featureId);
      expect(workflow).toBeDefined();
      expect(workflow!.nativeTeamCleanup).toBeDefined();
      expect(workflow!.nativeTeamCleanup).toContain('Orphaned native team detected');
    });
  });

  // ─── Telemetry Hint Injection ──────────────────────────────────────────────

  describe('queryTelemetryHints', () => {
    it('should return formatted hints when telemetry exceeds thresholds', async () => {
      // Arrange — create telemetry.events.jsonl with high-threshold metrics
      // workflow_set with high duration triggers the p95DurationMs > 200 rule
      const events = [];
      for (let i = 1; i <= 5; i++) {
        events.push(JSON.stringify({
          streamId: 'telemetry',
          sequence: i,
          timestamp: new Date().toISOString(),
          type: 'tool.completed',
          data: { tool: 'workflow_set', durationMs: 300, responseBytes: 100, tokenEstimate: 50 },
        }));
      }
      await fs.writeFile(
        path.join(tmpDir, 'telemetry.events.jsonl'),
        events.join('\n') + '\n',
      );

      // Act
      const hints = await queryTelemetryHints(tmpDir);

      // Assert
      expect(hints.length).toBeGreaterThanOrEqual(1);
      const workflowSetHint = hints.find((h) => h.startsWith('workflow_set:'));
      expect(workflowSetHint).toBeDefined();
      expect(workflowSetHint).toContain('Batch multiple field updates');
    });

    it('should return empty array when telemetry file does not exist', async () => {
      // Arrange — no telemetry.events.jsonl file

      // Act
      const hints = await queryTelemetryHints(tmpDir);

      // Assert
      expect(hints).toEqual([]);
    });

    it('should return empty array when no thresholds exceeded', async () => {
      // Arrange — create telemetry events with low metrics
      const events = [];
      for (let i = 1; i <= 3; i++) {
        events.push(JSON.stringify({
          streamId: 'telemetry',
          sequence: i,
          timestamp: new Date().toISOString(),
          type: 'tool.completed',
          data: { tool: 'workflow_set', durationMs: 50, responseBytes: 100, tokenEstimate: 50 },
        }));
      }
      await fs.writeFile(
        path.join(tmpDir, 'telemetry.events.jsonl'),
        events.join('\n') + '\n',
      );

      // Act
      const hints = await queryTelemetryHints(tmpDir);

      // Assert
      expect(hints).toEqual([]);
    });
  });

  describe('handleSessionStart with telemetry hints', () => {
    it('should include telemetryHints in result when thresholds exceeded', async () => {
      // Arrange — active workflow + high-threshold telemetry
      const stateData = createValidStateFile({ phase: 'delegate' });
      await fs.writeFile(
        path.join(tmpDir, 'test-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      const events = [];
      for (let i = 1; i <= 5; i++) {
        events.push(JSON.stringify({
          streamId: 'telemetry',
          sequence: i,
          timestamp: new Date().toISOString(),
          type: 'tool.completed',
          data: { tool: 'workflow_set', durationMs: 300, responseBytes: 100, tokenEstimate: 50 },
        }));
      }
      await fs.writeFile(
        path.join(tmpDir, 'telemetry.events.jsonl'),
        events.join('\n') + '\n',
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.telemetryHints).toBeDefined();
      expect(result.telemetryHints!.length).toBeGreaterThanOrEqual(1);
      expect(result.telemetryHints!.some((h) => h.includes('workflow_set'))).toBe(true);
    });

    it('should omit telemetryHints when no thresholds exceeded', async () => {
      // Arrange — active workflow but no telemetry file
      const stateData = createValidStateFile({ phase: 'delegate' });
      await fs.writeFile(
        path.join(tmpDir, 'test-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.telemetryHints).toBeUndefined();
    });
  });

  // ─── Graphite Removal Verification ─────────────────────────────────────────

  describe('handleSessionStart no graphite', () => {
    it('handleSessionStart_Result_NoGraphiteAvailableField', async () => {
      // Arrange — empty state dir (no checkpoints, no state files)

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert — graphiteAvailable field must NOT exist
      expect(result).not.toHaveProperty('graphiteAvailable');
    });
  });

  // ─── Behavioral Guidance ──────────────────────────────────────────────────

  describe('behavioral guidance', () => {
    it('handleSessionStart_WithCheckpoint_IncludesBehavioralGuidance', async () => {
      // Arrange — checkpoint for delegate phase with a state file containing workflowType
      const checkpoint = createCheckpointFile({
        featureId: 'guidance-feature',
        phase: 'delegate',
        stateFile: path.join(tmpDir, 'guidance-feature.state.json'),
      });
      await fs.writeFile(
        path.join(tmpDir, 'guidance-feature.checkpoint.json'),
        JSON.stringify(checkpoint),
      );
      // Write corresponding state file so workflowType can be read
      const stateData = createValidStateFile({
        featureId: 'guidance-feature',
        workflowType: 'feature',
        phase: 'delegate',
      });
      await fs.writeFile(
        path.join(tmpDir, 'guidance-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.behavioralGuidance).toBeDefined();
      expect(result.behavioralGuidance).toContain('exarchos_workflow');
    });

    it('handleSessionStart_NoCheckpoint_ActiveWorkflow_IncludesBehavioralGuidance', async () => {
      // Arrange — state file with phase=delegate, workflowType=feature (no checkpoint)
      const stateData = createValidStateFile({
        featureId: 'no-cp-guidance',
        workflowType: 'feature',
        phase: 'delegate',
      });
      await fs.writeFile(
        path.join(tmpDir, 'no-cp-guidance.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.behavioralGuidance).toBeDefined();
    });

    it('handleSessionStart_TerminalPhase_NoBehavioralGuidance', async () => {
      // Arrange — state file with phase=completed
      const stateData = createValidStateFile({
        featureId: 'completed-feature',
        phase: 'completed',
      });
      await fs.writeFile(
        path.join(tmpDir, 'completed-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.behavioralGuidance).toBeUndefined();
    });

    it('handleSessionStart_BehavioralGuidance_MatchesPhasePlaybook', async () => {
      // Arrange — state file with phase=review, workflowType=feature
      const stateData = createValidStateFile({
        featureId: 'review-guidance',
        workflowType: 'feature',
        phase: 'review',
      });
      await fs.writeFile(
        path.join(tmpDir, 'review-guidance.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.behavioralGuidance).toBeDefined();
      expect(result.behavioralGuidance).toContain('quality-review');
      expect(result.behavioralGuidance).toContain('gate.executed');
    });
  });

  // ─── Session Manifest Integration (Task 008) ───────────────────────────────

  describe('session manifest integration', () => {
    let manifestMocks: typeof import('../session/manifest.js');

    beforeEach(async () => {
      manifestMocks = await import('../session/manifest.js');
      vi.mocked(manifestMocks.writeManifestEntry).mockReset().mockResolvedValue(undefined);
      vi.mocked(manifestMocks.findUnextractedSessions).mockReset().mockResolvedValue([]);
    });

    it('handleSessionStart_WritesManifestEntry_WithSessionMetadata', async () => {
      // Arrange
      const stdinData = {
        session_id: 'sess-abc-123',
        transcript_path: '/home/user/.claude/projects/transcript.jsonl',
        cwd: '/home/user/project',
      };

      // Act
      await handleSessionStart(stdinData, tmpDir);

      // Assert
      expect(manifestMocks.writeManifestEntry).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(manifestMocks.writeManifestEntry).mock.calls[0];
      expect(callArgs[0]).toBe(tmpDir);
      const entry = callArgs[1];
      expect(entry.sessionId).toBe('sess-abc-123');
      expect(entry.transcriptPath).toBe('/home/user/.claude/projects/transcript.jsonl');
      expect(entry.cwd).toBe('/home/user/project');
      expect(entry.startedAt).toBeDefined();
      // startedAt should be a valid ISO date
      expect(new Date(entry.startedAt).toISOString()).toBe(entry.startedAt);
    });

    it('handleSessionStart_ResolvesWorkflowId_FromActiveWorkflows', async () => {
      // Arrange — active workflow state file
      const stdinData = {
        session_id: 'sess-with-workflow',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/home/user/project',
      };
      const stateData = createValidStateFile({
        featureId: 'active-feature',
        phase: 'delegate',
      });
      await fs.writeFile(
        path.join(tmpDir, 'active-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      await handleSessionStart(stdinData, tmpDir);

      // Assert
      expect(manifestMocks.writeManifestEntry).toHaveBeenCalledOnce();
      const entry = vi.mocked(manifestMocks.writeManifestEntry).mock.calls[0][1];
      expect(entry.workflowId).toBe('active-feature');
    });

    it('handleSessionStart_NoActiveWorkflow_ManifestEntryHasUndefinedWorkflowId', async () => {
      // Arrange — no state files, no checkpoints
      const stdinData = {
        session_id: 'sess-no-workflow',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/home/user/project',
      };

      // Act
      await handleSessionStart(stdinData, tmpDir);

      // Assert
      expect(manifestMocks.writeManifestEntry).toHaveBeenCalledOnce();
      const entry = vi.mocked(manifestMocks.writeManifestEntry).mock.calls[0][1];
      expect(entry.workflowId).toBeUndefined();
    });

    it('handleSessionStart_ManifestWriteFailure_DoesNotBreakExistingBehavior', async () => {
      // Arrange — writeManifestEntry throws
      vi.mocked(manifestMocks.writeManifestEntry).mockRejectedValue(new Error('disk full'));
      const stdinData = {
        session_id: 'sess-fail-write',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/home/user/project',
      };
      const stateData = createValidStateFile({
        featureId: 'resilient-feature',
        phase: 'review',
      });
      await fs.writeFile(
        path.join(tmpDir, 'resilient-feature.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart(stdinData, tmpDir);

      // Assert — session-start still returns workflow info
      expect(result.workflows).toBeDefined();
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows![0].featureId).toBe('resilient-feature');
      expect(result.error).toBeUndefined();
    });
  });

  // ─── Safety Rules Injection ────────────────────────────────────────────────

  describe('safety rules injection', () => {
    const originalPluginRoot = process.env.EXARCHOS_PLUGIN_ROOT;
    let pluginRootDir: string;

    beforeEach(async () => {
      pluginRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-plugin-'));
    });

    afterEach(async () => {
      // Restore env var
      if (originalPluginRoot !== undefined) {
        process.env.EXARCHOS_PLUGIN_ROOT = originalPluginRoot;
      } else {
        delete process.env.EXARCHOS_PLUGIN_ROOT;
      }
      // Clean up temp plugin root dir
      await fs.rm(pluginRootDir, { recursive: true, force: true }).catch(() => {});
    });

    it('SessionStart_IncludesSafetyRulesInContextDocument', async () => {
      // Arrange — create rules/rm-safety.md in the plugin root
      const rulesDir = path.join(pluginRootDir, 'rules');
      await fs.mkdir(rulesDir, { recursive: true });
      await fs.writeFile(
        path.join(rulesDir, 'rm-safety.md'),
        '# rm Safety\n\n**NEVER:** rm -rf /',
      );
      process.env.EXARCHOS_PLUGIN_ROOT = pluginRootDir;

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert
      expect(result.contextDocument).toBeDefined();
      expect(result.contextDocument).toContain('rm Safety');
    });

    it('SessionStart_GracefulWhenNoRulesDirectory', async () => {
      // Arrange — plugin root exists but has no rules/ subdirectory
      process.env.EXARCHOS_PLUGIN_ROOT = pluginRootDir;

      // Act
      const result = await handleSessionStart({}, tmpDir);

      // Assert — should not crash, contextDocument should be undefined or not contain safety rules
      expect(result.contextDocument === undefined || !result.contextDocument.includes('rm Safety')).toBe(true);
    });
  });

  // ─── Session Retry Mechanism (Task 011) ────────────────────────────────────

  describe('session retry mechanism', () => {
    let manifestMocks: typeof import('../session/manifest.js');
    let parserMocks: typeof import('../session/transcript-parser.js');

    beforeEach(async () => {
      manifestMocks = await import('../session/manifest.js');
      parserMocks = await import('../session/transcript-parser.js');
      vi.mocked(manifestMocks.writeManifestEntry).mockReset().mockResolvedValue(undefined);
      vi.mocked(manifestMocks.findUnextractedSessions).mockReset().mockResolvedValue([]);
      vi.mocked(parserMocks.parseTranscript).mockReset().mockResolvedValue([]);
    });

    it('handleSessionStart_UnextractedSession_RetriesExtraction', async () => {
      // Arrange — one unextracted session with existing transcript
      const transcriptPath = path.join(tmpDir, 'old-transcript.jsonl');
      await fs.writeFile(transcriptPath, '{"type":"assistant"}\n');

      vi.mocked(manifestMocks.findUnextractedSessions).mockResolvedValue([
        { sessionId: 'old-sess-1', transcriptPath, cwd: '/tmp', startedAt: '2025-01-01T00:00:00Z', workflowId: 'feat-1' },
      ]);

      const mockEvents = [
        { t: 'tool' as const, ts: '2025-01-01T00:00:01Z', tool: 'Read', cat: 'native' as const, inB: 10, outB: 20, sid: 'old-sess-1', wid: 'feat-1' },
      ];
      vi.mocked(parserMocks.parseTranscript).mockResolvedValue(mockEvents);

      const stdinData = { session_id: 'current-sess', transcript_path: '/tmp/current.jsonl', cwd: '/tmp' };

      // Act
      await handleSessionStart(stdinData, tmpDir);

      // Assert — parseTranscript called for the unextracted session
      expect(parserMocks.parseTranscript).toHaveBeenCalledWith(transcriptPath, { sessionId: 'old-sess-1', workflowId: 'feat-1' });

      // Assert — events written to sessions/{sessionId}.events.jsonl
      const eventsPath = path.join(tmpDir, 'sessions', 'old-sess-1.events.jsonl');
      const eventsContent = await fs.readFile(eventsPath, 'utf-8');
      expect(eventsContent.trim().split('\n')).toHaveLength(1);
      const parsed = JSON.parse(eventsContent.trim().split('\n')[0]);
      expect(parsed.t).toBe('tool');
    });

    it('handleSessionStart_TranscriptGone_MarksSessionAsOrphan', async () => {
      // Arrange — unextracted session whose transcript file no longer exists
      vi.mocked(manifestMocks.findUnextractedSessions).mockResolvedValue([
        { sessionId: 'orphan-sess', transcriptPath: '/nonexistent/transcript.jsonl', cwd: '/tmp', startedAt: '2025-01-01T00:00:00Z' },
      ]);

      const stdinData = { session_id: 'current-sess', transcript_path: '/tmp/current.jsonl', cwd: '/tmp' };

      // Act
      await handleSessionStart(stdinData, tmpDir);

      // Assert — parseTranscript should NOT be called
      expect(parserMocks.parseTranscript).not.toHaveBeenCalled();

      // Assert — orphan marker appended to manifest
      const manifestPath = path.join(tmpDir, 'sessions', '.manifest.jsonl');
      const content = await fs.readFile(manifestPath, 'utf-8');
      const lines = content.trim().split('\n');
      const orphanLine = lines.find((l) => l.includes('orphan-sess'));
      expect(orphanLine).toBeDefined();
      const orphanEntry = JSON.parse(orphanLine!);
      expect(orphanEntry.sessionId).toBe('orphan-sess');
      expect(orphanEntry.reason).toBe('transcript_not_found');
      expect(orphanEntry.orphanedAt).toBeDefined();
    });

    it('handleSessionStart_MultipleUnextracted_ProcessesAll', async () => {
      // Arrange — two unextracted sessions
      const transcriptPath1 = path.join(tmpDir, 'transcript-1.jsonl');
      const transcriptPath2 = path.join(tmpDir, 'transcript-2.jsonl');
      await fs.writeFile(transcriptPath1, '{"type":"assistant"}\n');
      await fs.writeFile(transcriptPath2, '{"type":"assistant"}\n');

      vi.mocked(manifestMocks.findUnextractedSessions).mockResolvedValue([
        { sessionId: 'multi-sess-1', transcriptPath: transcriptPath1, cwd: '/tmp', startedAt: '2025-01-01T00:00:00Z' },
        { sessionId: 'multi-sess-2', transcriptPath: transcriptPath2, cwd: '/tmp', startedAt: '2025-01-01T00:01:00Z' },
      ]);

      vi.mocked(parserMocks.parseTranscript).mockResolvedValue([]);

      const stdinData = { session_id: 'current-sess', transcript_path: '/tmp/current.jsonl', cwd: '/tmp' };

      // Act
      await handleSessionStart(stdinData, tmpDir);

      // Assert — parseTranscript called for both
      expect(parserMocks.parseTranscript).toHaveBeenCalledTimes(2);
      expect(parserMocks.parseTranscript).toHaveBeenCalledWith(transcriptPath1, { sessionId: 'multi-sess-1', workflowId: undefined });
      expect(parserMocks.parseTranscript).toHaveBeenCalledWith(transcriptPath2, { sessionId: 'multi-sess-2', workflowId: undefined });
    });

    it('handleSessionStart_RetryFailure_DoesNotBreakStartup', async () => {
      // Arrange — findUnextractedSessions throws
      vi.mocked(manifestMocks.findUnextractedSessions).mockRejectedValue(new Error('corrupt manifest'));

      const stdinData = { session_id: 'current-sess', transcript_path: '/tmp/current.jsonl', cwd: '/tmp' };
      const stateData = createValidStateFile({
        featureId: 'resilient-feature-2',
        phase: 'plan',
      });
      await fs.writeFile(
        path.join(tmpDir, 'resilient-feature-2.state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // Act
      const result = await handleSessionStart(stdinData, tmpDir);

      // Assert — session-start still returns workflow info normally
      expect(result.workflows).toBeDefined();
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows![0].featureId).toBe('resilient-feature-2');
      expect(result.error).toBeUndefined();
    });
  });

  // ─── Plugin-Root Version Drift Warning (Task 2.3) ──────────────────────────
  //
  // handleSessionStart invokes the shared checkPluginRootCompatibility()
  // library internally; the test asserts (a) stderr warning on drift, and
  // (b) silence in the compatible case. The check is non-blocking —
  // session-start must still return a normal result shape either way.

  describe('plugin-root version compat', () => {
    const originalPluginRoot = process.env.EXARCHOS_PLUGIN_ROOT;
    let pluginRootDir: string;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      pluginRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-plugin-compat-'));
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(async () => {
      stderrSpy.mockRestore();
      if (originalPluginRoot !== undefined) {
        process.env.EXARCHOS_PLUGIN_ROOT = originalPluginRoot;
      } else {
        delete process.env.EXARCHOS_PLUGIN_ROOT;
      }
      await fs.rm(pluginRootDir, { recursive: true, force: true }).catch(() => {});
    });

    async function writePluginJson(root: string, body: unknown): Promise<void> {
      const dir = path.join(root, '.claude-plugin');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(body), 'utf-8');
    }

    function capturedStderr(): string {
      return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    }

    it('SessionStart_PluginRootIncompatible_EmitsStderrWarning', async () => {
      // Arrange — plugin declares a newer binary than the running session.
      await writePluginJson(pluginRootDir, {
        name: 'exarchos',
        metadata: { compat: { minBinaryVersion: '99.0.0' } },
      });
      process.env.EXARCHOS_PLUGIN_ROOT = pluginRootDir;

      // Act — session-start proceeds normally even with drift.
      const result = await handleSessionStart({}, tmpDir);

      // Assert — stderr warning names the required version; result has no error.
      const stderr = capturedStderr();
      expect(stderr).toContain('99.0.0');
      expect(result.error).toBeUndefined();
    });

    it('SessionStart_PluginRootCompatible_Silent', async () => {
      // Arrange — min is well below the running binary's version.
      await writePluginJson(pluginRootDir, {
        name: 'exarchos',
        metadata: { compat: { minBinaryVersion: '0.1.0' } },
      });
      process.env.EXARCHOS_PLUGIN_ROOT = pluginRootDir;

      // Act
      await handleSessionStart({}, tmpDir);

      // Assert — no compat-related stderr output.
      const stderr = capturedStderr();
      // We only assert that no version-drift warning (as a whole phrase) appears.
      // Other stderr output (e.g. unrelated logging) is not in scope here.
      expect(stderr).not.toMatch(/incompatible/i);
      expect(stderr).not.toMatch(/minBinaryVersion/i);
    });
  });
});
