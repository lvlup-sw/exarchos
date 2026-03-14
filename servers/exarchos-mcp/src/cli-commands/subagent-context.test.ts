import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  filterToolsForPhaseAndRole,
  formatToolGuidance,
  findActiveWorkflowPhase,
  handleSubagentContext,
  queryModuleHistory,
  synthesizeIntelligence,
  extractModulesFromCwd,
  readNativeTaskList,
  isTeammateSubSubagent,
  isAgentTeamMode,
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

    it('should deny review_triage orchestrate action for delegate phase with teammate role', () => {
      // Arrange — task actions are teammate-accessible in delegate, but review_triage
      // is lead-only and not in delegate phases
      const phase = 'delegate';
      const role = 'teammate';

      // Act
      const result = filterToolsForPhaseAndRole(phase, role);

      // Assert — review_triage and prepare_synthesis should be denied (lead role + wrong phase)
      const deniedOrchestrate = result.denied.find(
        (c) => c.name === 'exarchos_orchestrate',
      );
      expect(deniedOrchestrate).toBeDefined();
      expect(deniedOrchestrate!.actions).toContain('review_triage');
      expect(deniedOrchestrate!.actions).toContain('prepare_delegation');
      expect(deniedOrchestrate!.actions).toContain('prepare_synthesis');
      expect(deniedOrchestrate!.actions).toContain('assess_stack');
      // 4 original + 13 check_ actions + 19 new handler actions denied for delegate+teammate
      expect(deniedOrchestrate!.actions).toHaveLength(36);
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

      // Assert — all orchestrate actions should be denied except check_event_emissions:
      // task_claim/task_complete/task_fail (delegate phase only)
      // + review_triage (lead role only)
      // + prepare_delegation (delegate phase + lead role)
      // + prepare_synthesis (lead role only)
      // + assess_stack (lead role only)
      // + 13 check_ actions (lead role only)
      const deniedOrchestrate = result.denied.find(
        (c) => c.name === 'exarchos_orchestrate',
      );
      expect(deniedOrchestrate).toBeDefined();
      expect(deniedOrchestrate!.actions.length).toBe(41);
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
    it('should degrade gracefully when no active workflow exists', async () => {
      // Arrange — point state dir to a non-existent temp location
      const originalStateDir = process.env.WORKFLOW_STATE_DIR;
      process.env.WORKFLOW_STATE_DIR = '/tmp/nonexistent-state-dir-' + Date.now();

      try {
        // Act — should not throw, returns empty result
        const result = await handleSubagentContext({});
        expect(result.guidance).toBe('');
        expect(result.context).toBe('');
        expect(result.team).toBe('');
      } finally {
        if (originalStateDir !== undefined) process.env.WORKFLOW_STATE_DIR = originalStateDir;
        else delete process.env.WORKFLOW_STATE_DIR;
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

  // ─── Task 6: Historical Intelligence ────────────────────────────────────────

  describe('historical intelligence', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempStateDir();
    });

    afterEach(async () => {
      await cleanupDir(tempDir);
    });

    describe('queryModuleHistory', () => {
      it('should return relevant events when JSONL contains matching module references', async () => {
        // Arrange
        const jsonlContent = [
          '{"streamId":"test","sequence":1,"timestamp":"2026-01-01T00:00:00Z","type":"workflow.fix-cycle","data":{"compoundStateId":"auth-review","count":2,"featureId":"test-feature"},"schemaVersion":"1.0"}',
          '{"streamId":"test","sequence":2,"timestamp":"2026-01-01T00:00:01Z","type":"task.completed","data":{"taskId":"task-001","artifacts":["src/auth/login.ts"]},"schemaVersion":"1.0"}',
          '{"streamId":"test","sequence":3,"timestamp":"2026-01-01T00:00:02Z","type":"task.completed","data":{"taskId":"task-002","artifacts":["src/api/routes.ts"]},"schemaVersion":"1.0"}',
        ].join('\n');
        await fs.writeFile(
          path.join(tempDir, 'test-feature.events.jsonl'),
          jsonlContent,
          'utf-8',
        );

        // Act
        const result = await queryModuleHistory(tempDir, ['auth']);

        // Assert — should return only events referencing 'auth'
        expect(result.length).toBe(2);
        expect(result[0]).toHaveProperty('type', 'workflow.fix-cycle');
        expect(result[1]).toHaveProperty('type', 'task.completed');
      });

      it('should return empty array when state directory has no events', async () => {
        // Act — tempDir is empty
        const result = await queryModuleHistory(tempDir, ['auth']);

        // Assert
        expect(result).toEqual([]);
      });
    });

    describe('synthesizeIntelligence', () => {
      it('should summarize fix cycle patterns from events', () => {
        // Arrange
        const events: Array<Record<string, unknown>> = [
          {
            type: 'workflow.fix-cycle',
            data: { compoundStateId: 'auth-review', count: 2, featureId: 'f1' },
          },
          {
            type: 'workflow.fix-cycle',
            data: { compoundStateId: 'auth-review', count: 3, featureId: 'f1' },
          },
          {
            type: 'task.completed',
            data: { taskId: 'task-001', artifacts: ['src/auth/login.ts'] },
          },
        ];

        // Act
        const result = synthesizeIntelligence(events);

        // Assert — should mention fix cycle count
        expect(result).toContain('fix cycle');
        expect(result.length).toBeGreaterThan(0);
        expect(result.length).toBeLessThanOrEqual(500);
      });

      it('should return empty string when no events provided', () => {
        // Act
        const result = synthesizeIntelligence([]);

        // Assert
        expect(result).toBe('');
      });
    });

    describe('extractModulesFromCwd', () => {
      it('should extract meaningful path segments from worktree path', () => {
        // Act
        const result = extractModulesFromCwd('/tmp/wt-auth-service/src');

        // Assert — should include 'auth-service'
        expect(result).toContain('auth-service');
      });

      it('should return empty array for root path', () => {
        // Act
        const result = extractModulesFromCwd('/');

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  // ─── Task 7: Enriched handleSubagentContext ─────────────────────────────────

  describe('handleSubagentContext enriched', () => {
    let tempDir: string;
    let originalStateDir: string | undefined;

    beforeEach(async () => {
      tempDir = await createTempStateDir();
      originalStateDir = process.env.WORKFLOW_STATE_DIR;
      process.env.WORKFLOW_STATE_DIR = tempDir;
    });

    afterEach(async () => {
      if (originalStateDir !== undefined) {
        process.env.WORKFLOW_STATE_DIR = originalStateDir;
      } else {
        delete process.env.WORKFLOW_STATE_DIR;
      }
      await cleanupDir(tempDir);
    });

    it('should include non-empty context field when active workflow has relevant events', async () => {
      // Arrange — active workflow + JSONL events with fix-cycle
      await writeStateFile(tempDir, 'my-feature', 'delegate');
      const jsonlContent = [
        '{"streamId":"my-feature","sequence":1,"timestamp":"2026-01-01T00:00:00Z","type":"workflow.fix-cycle","data":{"compoundStateId":"auth-review","count":2,"featureId":"my-feature"},"schemaVersion":"1.0"}',
        '{"streamId":"my-feature","sequence":2,"timestamp":"2026-01-01T00:00:01Z","type":"task.completed","data":{"taskId":"task-001","artifacts":["src/auth/login.ts"]},"schemaVersion":"1.0"}',
      ].join('\n');
      await fs.writeFile(
        path.join(tempDir, 'my-feature.events.jsonl'),
        jsonlContent,
        'utf-8',
      );

      // Act
      const result = await handleSubagentContext({ cwd: '/tmp/wt-auth-service/src' });

      // Assert
      expect(result).toHaveProperty('context');
      expect(typeof result.context).toBe('string');
      expect((result.context as string).length).toBeGreaterThan(0);
    });

    it('should have empty context when active workflow exists but no events', async () => {
      // Arrange — active workflow but no JSONL events
      await writeStateFile(tempDir, 'my-feature', 'delegate');

      // Act
      const result = await handleSubagentContext({ cwd: '/tmp/wt-auth-service/src' });

      // Assert
      expect(result).toHaveProperty('context');
      expect(result.context).toBe('');
    });

    it('should include team field with task summary when workflow has tasks', async () => {
      // Arrange — active workflow state file with tasks
      const stateFile = path.join(tempDir, 'team-feature.state.json');
      const state = {
        version: 2,
        featureId: 'team-feature',
        workflowType: 'feature',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        phase: 'delegate',
        artifacts: { design: null, plan: null, pr: null },
        tasks: [
          { id: 'task-1', title: 'Implement auth', status: 'in_progress', branch: 'auth' },
          { id: 'task-2', title: 'Implement api', status: 'complete', branch: 'api' },
          { id: 'task-3', title: 'Implement ui', status: 'pending', branch: 'ui' },
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
        _version: 1,
        _history: {},
        _checkpoint: {
          timestamp: new Date().toISOString(),
          phase: 'delegate',
          summary: 'Test state',
          operationsSince: 0,
          fixCycleCount: 0,
          lastActivityTimestamp: new Date().toISOString(),
          staleAfterMinutes: 120,
        },
      };
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');

      // Act
      const result = await handleSubagentContext({ cwd: '/some/path' });

      // Assert
      expect(result).toHaveProperty('team');
      expect(typeof result.team).toBe('string');
      expect((result.team as string).length).toBeGreaterThan(0);
    });

    it('should return empty guidance, context, and team when no active workflow', async () => {
      // Arrange — no state files in tempDir (empty)

      // Act
      const result = await handleSubagentContext({ cwd: '/some/path' });

      // Assert
      expect(result.guidance).toBe('');
      expect(result.context).toBe('');
      expect(result.team).toBe('');
    });
  });

  // ─── Task 005: Live Data Only (Deduplication) ──────────────────────────────

  describe('readNativeTaskList', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tasks-'));
    });

    afterEach(async () => {
      await cleanupDir(tempDir);
    });

    it('should return task statuses from existing tasks directory', async () => {
      // Arrange — create a tasks directory with JSON files
      const tasksDir = path.join(tempDir, 'my-feature');
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(
        path.join(tasksDir, 'task-001.json'),
        JSON.stringify({ id: 'task-001', title: 'Implement auth', status: 'complete' }),
        'utf-8',
      );
      await fs.writeFile(
        path.join(tasksDir, 'task-002.json'),
        JSON.stringify({ id: 'task-002', title: 'Implement api', status: 'in_progress' }),
        'utf-8',
      );
      await fs.writeFile(
        path.join(tasksDir, 'task-003.json'),
        JSON.stringify({ id: 'task-003', title: 'Implement ui', status: 'pending' }),
        'utf-8',
      );

      // Act
      const result = await readNativeTaskList(tasksDir);

      // Assert
      expect(result).toHaveLength(3);
      expect(result).toContainEqual(
        expect.objectContaining({ id: 'task-001', status: 'complete' }),
      );
      expect(result).toContainEqual(
        expect.objectContaining({ id: 'task-002', status: 'in_progress' }),
      );
      expect(result).toContainEqual(
        expect.objectContaining({ id: 'task-003', status: 'pending' }),
      );
    });

    it('should return empty array when tasks directory does not exist', async () => {
      // Act
      const result = await readNativeTaskList('/nonexistent/path/tasks');

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('isTeammateSubSubagent', () => {
    it('should return true when cwd contains .worktrees/ and phase is delegate', () => {
      // Arrange
      const cwd = '/Users/dev/project/.worktrees/wt-auth-service/src';
      const phase = 'delegate';

      // Act
      const result = isTeammateSubSubagent(cwd, phase);

      // Assert
      expect(result).toBe(true);
    });

    it('should return false when cwd does NOT contain .worktrees/', () => {
      // Arrange — orchestrator cwd (no worktree)
      const cwd = '/Users/dev/project/src';
      const phase = 'delegate';

      // Act
      const result = isTeammateSubSubagent(cwd, phase);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when cwd has .worktrees/ but phase is NOT delegate', () => {
      // Arrange
      const cwd = '/Users/dev/project/.worktrees/wt-auth-service/src';
      const phase = 'review';

      // Act
      const result = isTeammateSubSubagent(cwd, phase);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('isAgentTeamMode', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-'));
    });

    afterEach(async () => {
      await cleanupDir(tempDir);
    });

    it('should return true when team config directory exists', async () => {
      // Arrange — create team config at {teamsDir}/{featureId}/config.json
      const teamDir = path.join(tempDir, 'my-feature');
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ teamSize: 3 }),
        'utf-8',
      );

      // Act
      const result = await isAgentTeamMode('my-feature', tempDir);

      // Assert
      expect(result).toBe(true);
    });

    it('should return true when team config flat file exists', async () => {
      // Arrange — create team config at {teamsDir}/{featureId}.json
      await fs.writeFile(
        path.join(tempDir, 'my-feature.json'),
        JSON.stringify({ teamSize: 3 }),
        'utf-8',
      );

      // Act
      const result = await isAgentTeamMode('my-feature', tempDir);

      // Assert
      expect(result).toBe(true);
    });

    it('should return false when no team config exists', async () => {
      // Act — tempDir has no team config for this feature
      const result = await isAgentTeamMode('nonexistent-feature', tempDir);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('handleSubagentContext agent-team mode', () => {
    let tempDir: string;
    let tempTeamsDir: string;
    let tempTasksDir: string;
    let originalStateDir: string | undefined;
    let originalTeamsDir: string | undefined;
    let originalTasksDir: string | undefined;

    beforeEach(async () => {
      tempDir = await createTempStateDir();
      tempTeamsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-'));
      tempTasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-'));
      originalStateDir = process.env.WORKFLOW_STATE_DIR;
      originalTeamsDir = process.env.EXARCHOS_TEAMS_DIR;
      originalTasksDir = process.env.EXARCHOS_TASKS_DIR;
      process.env.WORKFLOW_STATE_DIR = tempDir;
      process.env.EXARCHOS_TEAMS_DIR = tempTeamsDir;
      process.env.EXARCHOS_TASKS_DIR = tempTasksDir;
    });

    afterEach(async () => {
      if (originalStateDir !== undefined) {
        process.env.WORKFLOW_STATE_DIR = originalStateDir;
      } else {
        delete process.env.WORKFLOW_STATE_DIR;
      }
      if (originalTeamsDir !== undefined) {
        process.env.EXARCHOS_TEAMS_DIR = originalTeamsDir;
      } else {
        delete process.env.EXARCHOS_TEAMS_DIR;
      }
      if (originalTasksDir !== undefined) {
        process.env.EXARCHOS_TASKS_DIR = originalTasksDir;
      } else {
        delete process.env.EXARCHOS_TASKS_DIR;
      }
      await cleanupDir(tempDir);
      await cleanupDir(tempTeamsDir);
      await cleanupDir(tempTasksDir);
    });

    it('should not call queryModuleHistory in agent-team mode', async () => {
      // Arrange — active workflow with team config present
      const featureId = 'team-feature';
      await writeStateFile(tempDir, featureId, 'delegate');

      // Create team config directory structure under EXARCHOS_TEAMS_DIR
      const teamDir = path.join(tempTeamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ teamSize: 3 }),
        'utf-8',
      );

      // Add JSONL events that would be found if queryModuleHistory were called
      const jsonlContent = [
        `{"streamId":"${featureId}","sequence":1,"timestamp":"2026-01-01T00:00:00Z","type":"workflow.fix-cycle","data":{"compoundStateId":"auth-review","count":2,"featureId":"${featureId}"},"schemaVersion":"1.0"}`,
      ].join('\n');
      await fs.writeFile(
        path.join(tempDir, `${featureId}.events.jsonl`),
        jsonlContent,
        'utf-8',
      );

      // Act
      const result = await handleSubagentContext({ cwd: '/tmp/wt-auth-service/src' });

      // Assert — context should be empty because historical intelligence is skipped
      expect(result.context).toBe('');
    });

    it('should not inject static team context in agent-team mode', async () => {
      // Arrange — active workflow with team config AND workflow tasks
      const featureId = 'team-feature-2';
      const stateFile = path.join(tempDir, `${featureId}.state.json`);
      const state = {
        version: 2,
        featureId,
        workflowType: 'feature',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        phase: 'delegate',
        artifacts: { design: null, plan: null, pr: null },
        tasks: [
          { id: 'task-1', title: 'Implement auth', status: 'in_progress', branch: 'auth' },
          { id: 'task-2', title: 'Implement api', status: 'complete', branch: 'api' },
        ],
        worktrees: {},
        reviews: {},
        synthesis: {
          integrationBranch: null, mergeOrder: [], mergedBranches: [],
          prUrl: null, prFeedback: [],
        },
        _version: 1, _history: {},
        _checkpoint: {
          timestamp: new Date().toISOString(), phase: 'delegate',
          summary: 'Test', operationsSince: 0, fixCycleCount: 0,
          lastActivityTimestamp: new Date().toISOString(), staleAfterMinutes: 120,
        },
      };
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');

      // Create team config under EXARCHOS_TEAMS_DIR
      const teamDir = path.join(tempTeamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ teamSize: 3 }),
        'utf-8',
      );

      // Act
      const result = await handleSubagentContext({ cwd: '/some/path' });

      // Assert — team field should be empty (static team context suppressed)
      expect(result.team).toBe('');
    });

    it('should inject live task status changes in agent-team mode', async () => {
      // Arrange — active workflow with team config + native task files
      const featureId = 'team-feature-3';
      await writeStateFile(tempDir, featureId, 'delegate');

      // Create team config under EXARCHOS_TEAMS_DIR
      const teamDir = path.join(tempTeamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ teamSize: 3 }),
        'utf-8',
      );

      // Create native tasks under EXARCHOS_TASKS_DIR
      const tasksDir = path.join(tempTasksDir, featureId);
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(
        path.join(tasksDir, 'task-001.json'),
        JSON.stringify({ id: 'task-001', title: 'Implement auth', status: 'complete' }),
        'utf-8',
      );
      await fs.writeFile(
        path.join(tasksDir, 'task-002.json'),
        JSON.stringify({ id: 'task-002', title: 'Implement api', status: 'in_progress' }),
        'utf-8',
      );

      // Act
      const result = await handleSubagentContext({ cwd: '/some/path' });

      // Assert — liveTaskStatus field should contain task data
      expect(result).toHaveProperty('liveTaskStatus');
      expect(typeof result.liveTaskStatus).toBe('string');
      expect((result.liveTaskStatus as string).length).toBeGreaterThan(0);
      expect(result.liveTaskStatus as string).toContain('complete');
    });

    it('should retain historical intelligence in subagent mode (no team config)', async () => {
      // Arrange — active workflow WITHOUT team config
      const featureId = 'solo-feature';
      await writeStateFile(tempDir, featureId, 'delegate');

      // EXARCHOS_TEAMS_DIR points to tempTeamsDir which has no config for this feature

      // Add JSONL events that should be found
      const jsonlContent = [
        `{"streamId":"${featureId}","sequence":1,"timestamp":"2026-01-01T00:00:00Z","type":"workflow.fix-cycle","data":{"compoundStateId":"auth-review","count":2,"featureId":"${featureId}"},"schemaVersion":"1.0"}`,
      ].join('\n');
      await fs.writeFile(
        path.join(tempDir, `${featureId}.events.jsonl`),
        jsonlContent,
        'utf-8',
      );

      // Act
      const result = await handleSubagentContext({ cwd: '/tmp/wt-auth-service/src' });

      // Assert — context should be non-empty (historical intelligence preserved in subagent mode)
      expect(typeof result.context).toBe('string');
      expect((result.context as string).length).toBeGreaterThan(0);
      expect(result.context as string).toContain('fix cycle');
    });

    it('should always retain tool guidance regardless of mode', async () => {
      // Arrange — active workflow WITH team config
      const featureId = 'guided-feature';
      await writeStateFile(tempDir, featureId, 'delegate');

      // Create team config under EXARCHOS_TEAMS_DIR
      const teamDir = path.join(tempTeamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ teamSize: 3 }),
        'utf-8',
      );

      // Act
      const result = await handleSubagentContext({ cwd: '/some/path' });

      // Assert — guidance should be present (tool filtering always applies)
      expect(result).toHaveProperty('guidance');
      expect(typeof result.guidance).toBe('string');
      expect((result.guidance as string).length).toBeGreaterThan(0);
    });

    it('should skip all injection for teammate sub-subagents during delegate', async () => {
      // Arrange — active workflow + team config + cwd in worktree + phase is delegate
      const featureId = 'sub-sub-feature';
      await writeStateFile(tempDir, featureId, 'delegate');

      // Create team config under EXARCHOS_TEAMS_DIR
      const teamDir = path.join(tempTeamsDir, featureId);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({ teamSize: 3 }),
        'utf-8',
      );

      // Add JSONL events
      const jsonlContent = [
        `{"streamId":"${featureId}","sequence":1,"timestamp":"2026-01-01T00:00:00Z","type":"workflow.fix-cycle","data":{"compoundStateId":"auth-review","count":2,"featureId":"${featureId}"},"schemaVersion":"1.0"}`,
      ].join('\n');
      await fs.writeFile(
        path.join(tempDir, `${featureId}.events.jsonl`),
        jsonlContent,
        'utf-8',
      );

      // Act — cwd is inside a .worktrees/ directory (teammate sub-subagent)
      const result = await handleSubagentContext({
        cwd: '/Users/dev/project/.worktrees/wt-auth-service/src',
      });

      // Assert — all context should be empty (sub-subagent inherits from parent)
      expect(result.guidance).toBe('');
      expect(result.context).toBe('');
      expect(result.team).toBe('');
    });
  });
});
