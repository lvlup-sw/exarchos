import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  filterToolsForPhaseAndRole,
  formatToolGuidance,
  findActiveWorkflowPhase,
  handleSubagentContext,
  type FilteredComposite,
} from './subagent-context.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

async function createTempStateDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-ctx-'));
  return tmpDir;
}

async function writeStateFile(
  stateDir: string,
  featureId: string,
  phase: string,
): Promise<void> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const state = {
    version: 2,
    featureId,
    workflowType: 'feature',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase,
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
      timestamp: new Date().toISOString(),
      phase,
      summary: 'Test state',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: new Date().toISOString(),
      staleAfterMinutes: 120,
    },
  };
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('subagent-context', () => {
  describe('filterToolsForPhaseAndRole', () => {
    it('should return task actions for delegate phase with teammate role', () => {
      // Arrange
      const phase = 'delegate';
      const role = 'teammate';

      // Act
      const result = filterToolsForPhaseAndRole(phase, role);

      // Assert — should include task_claim, task_complete, task_fail from exarchos_orchestrate
      const orchestrate = result.available.find((c) => c.name === 'exarchos_orchestrate');
      expect(orchestrate).toBeDefined();
      expect(orchestrate!.actions).toContain('task_claim');
      expect(orchestrate!.actions).toContain('task_complete');
      expect(orchestrate!.actions).toContain('task_fail');
    });

    it('should not have any denied orchestrate actions for delegate phase with teammate role', () => {
      // Arrange — with team actions removed, only task actions remain (all teammate-accessible)
      const phase = 'delegate';
      const role = 'teammate';

      // Act
      const result = filterToolsForPhaseAndRole(phase, role);

      // Assert — no orchestrate actions should be denied (all 3 remaining are teammate-accessible)
      const deniedOrchestrate = result.denied.find(
        (c) => c.name === 'exarchos_orchestrate',
      );
      expect(deniedOrchestrate).toBeUndefined();
    });

    it('should include event actions for delegate phase with teammate role', () => {
      // Arrange
      const phase = 'delegate';
      const role = 'teammate';

      // Act
      const result = filterToolsForPhaseAndRole(phase, role);

      // Assert
      const event = result.available.find((c) => c.name === 'exarchos_event');
      expect(event).toBeDefined();
      expect(event!.actions).toContain('append');
      expect(event!.actions).toContain('query');
    });

    it('should include view actions for review phase with teammate role', () => {
      // Arrange
      const phase = 'review';
      const role = 'teammate';

      // Act
      const result = filterToolsForPhaseAndRole(phase, role);

      // Assert — view tools should be available in review phase
      const view = result.available.find((c) => c.name === 'exarchos_view');
      expect(view).toBeDefined();
      expect(view!.actions).toContain('pipeline');
      expect(view!.actions).toContain('tasks');
      expect(view!.actions).toContain('workflow_status');
    });

    it('should exclude orchestrate actions for review phase with teammate role', () => {
      // Arrange
      const phase = 'review';
      const role = 'teammate';

      // Act
      const result = filterToolsForPhaseAndRole(phase, role);

      // Assert — all orchestrate actions should be denied (delegate phase only)
      const deniedOrchestrate = result.denied.find(
        (c) => c.name === 'exarchos_orchestrate',
      );
      expect(deniedOrchestrate).toBeDefined();
      // All 3 orchestrate actions should be denied in review phase
      expect(deniedOrchestrate!.actions.length).toBe(3);
    });

    it('should deny workflow init and cancel for teammate role', () => {
      // Arrange
      const phase = 'delegate';
      const role = 'teammate';

      // Act
      const result = filterToolsForPhaseAndRole(phase, role);

      // Assert — init and cancel are lead-only
      const deniedWorkflow = result.denied.find((c) => c.name === 'exarchos_workflow');
      expect(deniedWorkflow).toBeDefined();
      expect(deniedWorkflow!.actions).toContain('init');
      expect(deniedWorkflow!.actions).toContain('cancel');
    });

    it('should allow workflow get for teammate role in any phase', () => {
      // Arrange
      const phase = 'delegate';
      const role = 'teammate';

      // Act
      const result = filterToolsForPhaseAndRole(phase, role);

      // Assert — get is role: any
      const availWorkflow = result.available.find((c) => c.name === 'exarchos_workflow');
      expect(availWorkflow).toBeDefined();
      expect(availWorkflow!.actions).toContain('get');
    });
  });

  describe('formatToolGuidance', () => {
    it('should format available tools section', () => {
      // Arrange
      const available: FilteredComposite[] = [
        { name: 'exarchos_orchestrate', actions: ['task_claim', 'task_complete', 'task_fail'] },
        { name: 'exarchos_event', actions: ['append', 'query'] },
      ];
      const denied: FilteredComposite[] = [
        { name: 'exarchos_workflow', actions: ['init', 'set', 'cancel'] },
      ];

      // Act
      const output = formatToolGuidance(available, denied);

      // Assert
      expect(output).toContain('Your available Exarchos tools:');
      expect(output).toContain('exarchos_orchestrate');
      expect(output).toContain('task_claim');
      expect(output).toContain('task_complete');
      expect(output).toContain('task_fail');
      expect(output).toContain('exarchos_event');
      expect(output).toContain('append');
      expect(output).toContain('query');
    });

    it('should format denied tools section', () => {
      // Arrange
      const available: FilteredComposite[] = [
        { name: 'exarchos_event', actions: ['append', 'query'] },
      ];
      const denied: FilteredComposite[] = [
        { name: 'exarchos_orchestrate', actions: ['task_claim', 'task_complete'] },
        { name: 'exarchos_workflow', actions: ['init', 'cancel'] },
      ];

      // Act
      const output = formatToolGuidance(available, denied);

      // Assert
      expect(output).toContain('Do NOT call:');
      expect(output).toContain('exarchos_orchestrate');
      expect(output).toContain('task_claim');
      expect(output).toContain('exarchos_workflow');
      expect(output).toContain('init');
      expect(output).toContain('cancel');
    });

    it('should output empty string when no available and no denied', () => {
      // Act
      const output = formatToolGuidance([], []);

      // Assert
      expect(output).toBe('');
    });
  });

  describe('handleSubagentContext', () => {
    it('should throw when HOME and USERPROFILE are both undefined', async () => {
      // Arrange — save and remove home dir env vars
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      const originalStateDir = process.env.WORKFLOW_STATE_DIR;
      delete process.env.HOME;
      delete process.env.USERPROFILE;
      delete process.env.WORKFLOW_STATE_DIR;

      try {
        // Act & Assert
        await expect(handleSubagentContext({})).rejects.toThrow(
          'Cannot determine home directory: HOME and USERPROFILE are both undefined',
        );
      } finally {
        // Restore env vars
        if (originalHome !== undefined) process.env.HOME = originalHome;
        if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
        if (originalStateDir !== undefined) process.env.WORKFLOW_STATE_DIR = originalStateDir;
      }
    });
  });

  describe('findActiveWorkflowPhase', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempStateDir();
    });

    afterEach(async () => {
      await cleanupDir(tempDir);
    });

    it('should return phase for an active workflow', async () => {
      // Arrange
      await writeStateFile(tempDir, 'my-feature', 'delegate');

      // Act
      const result = await findActiveWorkflowPhase(tempDir);

      // Assert
      expect(result).toBe('delegate');
    });

    it('should return null when no state files exist', async () => {
      // Act (tempDir is empty)
      const result = await findActiveWorkflowPhase(tempDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when state directory does not exist', async () => {
      // Act
      const result = await findActiveWorkflowPhase('/nonexistent/path/nowhere');

      // Assert
      expect(result).toBeNull();
    });

    it('should skip completed workflows and find active one', async () => {
      // Arrange
      await writeStateFile(tempDir, 'old-feature', 'completed');
      await writeStateFile(tempDir, 'active-feature', 'review');

      // Act
      const result = await findActiveWorkflowPhase(tempDir);

      // Assert
      expect(result).toBe('review');
    });

    it('should return null when all workflows are completed', async () => {
      // Arrange
      await writeStateFile(tempDir, 'done-1', 'completed');
      await writeStateFile(tempDir, 'done-2', 'completed');

      // Act
      const result = await findActiveWorkflowPhase(tempDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should skip cancelled workflows and find active one', async () => {
      // Arrange
      await writeStateFile(tempDir, 'cancelled-feature', 'cancelled');
      await writeStateFile(tempDir, 'active-feature', 'delegate');

      // Act
      const result = await findActiveWorkflowPhase(tempDir);

      // Assert
      expect(result).toBe('delegate');
    });

    it('should return null when all workflows are cancelled', async () => {
      // Arrange
      await writeStateFile(tempDir, 'cancelled-1', 'cancelled');
      await writeStateFile(tempDir, 'cancelled-2', 'cancelled');

      // Act
      const result = await findActiveWorkflowPhase(tempDir);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when workflows are mix of completed and cancelled', async () => {
      // Arrange
      await writeStateFile(tempDir, 'done', 'completed');
      await writeStateFile(tempDir, 'stopped', 'cancelled');

      // Act
      const result = await findActiveWorkflowPhase(tempDir);

      // Assert
      expect(result).toBeNull();
    });
  });
});
