import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleGuard } from './guard.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

/** Create a minimal valid state file JSON for a given phase. */
function makeStateJson(featureId: string, phase: string, updatedAt?: string): string {
  const now = updatedAt ?? new Date().toISOString();
  return JSON.stringify({
    version: '1.1',
    featureId,
    workflowType: 'feature',
    createdAt: now,
    updatedAt: now,
    phase,
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
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
      timestamp: now,
      phase,
      summary: 'Test state',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: now,
      staleAfterMinutes: 120,
    },
  });
}

/** Build stdin data that mimics a PreToolUse hook invocation. */
function makePreToolUseInput(
  mcpToolName: string,
  action: string,
  extraInput?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: mcpToolName,
    tool_input: { action, ...extraInput },
  };
}

describe('guard command', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Allow Cases ────────────────────────────────────────────────────────

  describe('allow decisions', () => {
    it('should allow workflow "set" action in ideate phase', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'ideate'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_workflow', 'set');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — empty object means allow
      expect(result).toEqual({});
    });

    it('should allow view "tasks" action in delegate phase', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'delegate'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_view', 'tasks');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert
      expect(result).toEqual({});
    });

    it('should allow orchestrate "task_claim" action in delegate phase', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'delegate'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'task_claim');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert
      expect(result).toEqual({});
    });
  });

  // ─── Init Enforcement ──────────────────────────────────────────────────

  describe('init enforcement', () => {
    it('should deny init when targeting a featureId with active workflow', async () => {
      // Arrange — active workflow with same featureId as init target
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'delegate'));
      const input = makePreToolUseInput(
        'mcp__exarchos__exarchos_workflow', 'init',
        { featureId: 'test-feature', workflowType: 'feature' },
      );

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — init denied for existing active workflow (duplicate prevention)
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          reason: expect.stringContaining('init'),
        },
      });
    });

    it('should deny init for same featureId even in ideate phase', async () => {
      // Arrange — prevents re-initializing an in-progress workflow
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'ideate'));
      const input = makePreToolUseInput(
        'mcp__exarchos__exarchos_workflow', 'init',
        { featureId: 'test-feature', workflowType: 'feature' },
      );

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — init should be denied to prevent duplicate workflows
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          reason: expect.stringContaining('init'),
        },
      });
    });

    it('should allow init when no active workflow exists', async () => {
      // Arrange — empty state directory
      const input = makePreToolUseInput('mcp__exarchos__exarchos_workflow', 'init');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — null phase means no active workflow, allow
      expect(result).toEqual({});
    });
  });

  // ─── Blocked Phase ────────────────────────────────────────────────────

  describe('blocked phase', () => {
    it('should allow workflow get in blocked phase', async () => {
      // Arrange — workflow is blocked, should still be inspectable
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'blocked'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_workflow', 'get');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — must be able to read blocked workflows
      expect(result).toEqual({});
    });

    it('should allow workflow set in blocked phase', async () => {
      // Arrange — need set to transition out of blocked
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'blocked'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_workflow', 'set');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — must be able to unblock workflows
      expect(result).toEqual({});
    });

    it('should allow workflow cancel in blocked phase', async () => {
      // Arrange — need cancel to clean up blocked workflows
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'blocked'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_workflow', 'cancel');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert
      expect(result).toEqual({});
    });
  });

  // ─── Debug Workflow Phases ────────────────────────────────────────────

  describe('debug workflow phases', () => {
    it('should allow team_spawn in debug-implement phase', async () => {
      // Arrange — debug thorough track uses team coordination
      const stateFile = path.join(tmpDir, 'debug-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('debug-feature', 'debug-implement'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'team_spawn');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — debug-implement is in DELEGATE_PHASES
      expect(result).toEqual({});
    });

    it('should allow task_claim in debug-implement phase', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'debug-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('debug-feature', 'debug-implement'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'task_claim');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert
      expect(result).toEqual({});
    });
  });

  // ─── Per-Workflow Scoping ─────────────────────────────────────────────

  describe('per-workflow scoping', () => {
    it('should allow init when unrelated active workflows exist', async () => {
      // Arrange — active workflow "existing-feature" in delegate phase
      // but init targets a NEW workflow "new-refactor"
      await fs.writeFile(
        path.join(tmpDir, 'existing-feature.state.json'),
        makeStateJson('existing-feature', 'delegate'),
      );
      const input = makePreToolUseInput(
        'mcp__exarchos__exarchos_workflow', 'init',
        { featureId: 'new-refactor', workflowType: 'refactor' },
      );

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — init targets a non-existent workflow, should be allowed
      expect(result).toEqual({});
    });

    it('should deny init when targeting a featureId that already has an active workflow', async () => {
      // Arrange — active workflow "my-feature" already exists
      await fs.writeFile(
        path.join(tmpDir, 'my-feature.state.json'),
        makeStateJson('my-feature', 'delegate'),
      );
      const input = makePreToolUseInput(
        'mcp__exarchos__exarchos_workflow', 'init',
        { featureId: 'my-feature', workflowType: 'feature' },
      );

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — init for existing active workflow should be denied
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          reason: expect.stringContaining('init'),
        },
      });
    });

    it('should allow init when targeting a featureId whose workflow is completed', async () => {
      // Arrange — "old-feature" exists but is completed; another active workflow also exists
      await fs.writeFile(
        path.join(tmpDir, 'old-feature.state.json'),
        makeStateJson('old-feature', 'completed'),
      );
      await fs.writeFile(
        path.join(tmpDir, 'active-other.state.json'),
        makeStateJson('active-other', 'delegate'),
      );
      const input = makePreToolUseInput(
        'mcp__exarchos__exarchos_workflow', 'init',
        { featureId: 'old-feature', workflowType: 'feature' },
      );

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — completed workflow can be re-initialized
      expect(result).toEqual({});
    });

    it('should check targeted workflow phase for set action, not unrelated workflow', async () => {
      // Arrange — workflow A in ideate, workflow B in delegate
      // set on workflow A should check ideate (allow), not delegate
      await fs.writeFile(
        path.join(tmpDir, 'workflow-a.state.json'),
        makeStateJson('workflow-a', 'ideate', '2025-01-01T00:00:00.000Z'),
      );
      await fs.writeFile(
        path.join(tmpDir, 'workflow-b.state.json'),
        makeStateJson('workflow-b', 'delegate', '2025-06-01T00:00:00.000Z'),
      );
      const input = makePreToolUseInput(
        'mcp__exarchos__exarchos_workflow', 'set',
        { featureId: 'workflow-a' },
      );

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — should check workflow-a's phase (ideate), not workflow-b's (delegate)
      // "set" is valid in ALL_PHASES, so this should allow
      expect(result).toEqual({});
    });

    it('should fall back to most recent active workflow when no featureId in input', async () => {
      // Arrange — orchestrate tools don't always specify featureId
      await fs.writeFile(
        path.join(tmpDir, 'active-workflow.state.json'),
        makeStateJson('active-workflow', 'ideate'),
      );
      const input = makePreToolUseInput(
        'mcp__exarchos__exarchos_orchestrate', 'team_spawn',
      );

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — no featureId, falls back to global check; team_spawn denied in ideate
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          reason: expect.stringContaining('team_spawn'),
        },
      });
    });
  });

  // ─── Deny Cases ─────────────────────────────────────────────────────────

  describe('deny decisions', () => {
    it('should deny orchestrate "team_spawn" action in ideate phase', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'ideate'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'team_spawn');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          reason: expect.stringContaining('team_spawn'),
        },
      });
    });

    it('should deny orchestrate "team_spawn" action in review phase', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'review'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'team_spawn');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          reason: expect.stringContaining('team_spawn'),
        },
      });
    });
  });

  // ─── Deny Format Verification ──────────────────────────────────────────

  describe('deny output format', () => {
    it('should return correct PreToolUse deny JSON structure', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'ideate'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'team_spawn');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — verify exact structure
      expect(result).toHaveProperty('hookSpecificOutput');
      const output = (result as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
      expect(output).toHaveProperty('hookEventName', 'PreToolUse');
      expect(output).toHaveProperty('permissionDecision', 'deny');
      expect(output).toHaveProperty('reason');
      expect(typeof output.reason).toBe('string');
      expect(output.reason as string).toMatch(/team_spawn/);
      expect(output.reason as string).toMatch(/ideate/);
      expect(output.reason as string).toMatch(/delegate/);
    });
  });

  // ─── Graceful Degradation ──────────────────────────────────────────────

  describe('graceful degradation', () => {
    it('should allow when no active workflow exists', async () => {
      // Arrange — tmpDir is empty, no state files
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'team_spawn');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — allow when no workflow to guard
      expect(result).toEqual({});
    });

    it('should allow when state directory does not exist', async () => {
      // Arrange — nonexistent directory
      const nonExistentDir = path.join(tmpDir, 'does-not-exist');
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'team_spawn');

      // Act
      const result = await handleGuard(input, nonExistentDir);

      // Assert
      expect(result).toEqual({});
    });

    it('should allow when tool_name is not an exarchos MCP tool', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'ideate'));
      const input = {
        hook_event_name: 'PreToolUse',
        tool_name: 'some_other_tool',
        tool_input: { action: 'do_something' },
      };

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — not an exarchos tool, allow
      expect(result).toEqual({});
    });

    it('should allow when action is not found in registry', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'ideate'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_workflow', 'nonexistent_action');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — unknown action, allow (graceful degradation)
      expect(result).toEqual({});
    });

    it('should allow when composite tool is not found in registry', async () => {
      // Arrange
      const stateFile = path.join(tmpDir, 'test-feature.state.json');
      await fs.writeFile(stateFile, makeStateJson('test-feature', 'ideate'));
      const input = makePreToolUseInput('mcp__exarchos__exarchos_unknown', 'some_action');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — unknown composite tool, allow
      expect(result).toEqual({});
    });
  });

  // ─── Deterministic Workflow Selection ─────────────────────────────────

  describe('deterministic workflow selection', () => {
    it('should select the most recently updated active workflow when multiple exist', async () => {
      // Arrange — create two active workflows with different updatedAt timestamps
      // "older" workflow is in delegate phase, "newer" workflow is in ideate phase
      const olderTimestamp = '2025-01-01T00:00:00.000Z';
      const newerTimestamp = '2025-06-01T00:00:00.000Z';

      // Write files in alphabetical order that differs from temporal order
      // to ensure sorting by updatedAt, not filesystem order
      await fs.writeFile(
        path.join(tmpDir, 'aaa-older.state.json'),
        makeStateJson('aaa-older', 'delegate', olderTimestamp),
      );
      await fs.writeFile(
        path.join(tmpDir, 'zzz-newer.state.json'),
        makeStateJson('zzz-newer', 'ideate', newerTimestamp),
      );

      // team_spawn is denied in ideate but allowed in delegate
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'team_spawn');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — should pick "zzz-newer" (ideate, most recent updatedAt) and deny team_spawn
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          reason: expect.stringContaining('ideate'),
        },
      });
    });

    it('should be deterministic regardless of filesystem ordering', async () => {
      // Arrange — create three workflows; the one with the latest updatedAt
      // has a name that would sort in the middle alphabetically
      const timestamps = {
        aaa: '2025-01-01T00:00:00.000Z',
        mmm: '2025-12-01T00:00:00.000Z', // most recent
        zzz: '2025-06-01T00:00:00.000Z',
      };

      await fs.writeFile(
        path.join(tmpDir, 'aaa-first.state.json'),
        makeStateJson('aaa-first', 'delegate', timestamps.aaa),
      );
      await fs.writeFile(
        path.join(tmpDir, 'mmm-middle.state.json'),
        makeStateJson('mmm-middle', 'review', timestamps.mmm),
      );
      await fs.writeFile(
        path.join(tmpDir, 'zzz-last.state.json'),
        makeStateJson('zzz-last', 'ideate', timestamps.zzz),
      );

      // team_spawn is denied in review but allowed in delegate
      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'team_spawn');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — should pick "mmm-middle" (review, most recent updatedAt) and deny team_spawn
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          reason: expect.stringContaining('review'),
        },
      });
    });

    it('should allow any action when all workflows are completed', async () => {
      // Arrange — all workflows completed, no active workflow to guard
      const olderTimestamp = '2025-01-01T00:00:00.000Z';
      const newerTimestamp = '2025-06-01T00:00:00.000Z';

      await fs.writeFile(
        path.join(tmpDir, 'aaa-old-completed.state.json'),
        makeStateJson('aaa-old-completed', 'completed', olderTimestamp),
      );
      await fs.writeFile(
        path.join(tmpDir, 'zzz-new-completed.state.json'),
        makeStateJson('zzz-new-completed', 'completed', newerTimestamp),
      );

      const input = makePreToolUseInput('mcp__exarchos__exarchos_orchestrate', 'team_spawn');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — no active workflows, allow (enables starting new workflows or
      // invoking intermediate steps like /delegate without prior state)
      expect(result).toEqual({});
    });

    it('should allow any action when all workflows are cancelled', async () => {
      // Arrange — only cancelled workflows exist
      await fs.writeFile(
        path.join(tmpDir, 'cancelled-workflow.state.json'),
        makeStateJson('cancelled-workflow', 'cancelled'),
      );

      const input = makePreToolUseInput('mcp__exarchos__exarchos_workflow', 'init');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — cancelled is a final state, no active workflow to guard
      expect(result).toEqual({});
    });

    it('should prefer active workflows over completed ones even if completed is newer', async () => {
      // Arrange — one completed (newer) and one active (older)
      const completedTimestamp = '2025-12-01T00:00:00.000Z'; // newer
      const activeTimestamp = '2025-01-01T00:00:00.000Z'; // older

      await fs.writeFile(
        path.join(tmpDir, 'completed-newer.state.json'),
        makeStateJson('completed-newer', 'completed', completedTimestamp),
      );
      await fs.writeFile(
        path.join(tmpDir, 'active-older.state.json'),
        makeStateJson('active-older', 'ideate', activeTimestamp),
      );

      // team_spawn is denied in ideate but would also be denied in completed
      // Use workflow "set" which IS allowed in ideate to distinguish
      const input = makePreToolUseInput('mcp__exarchos__exarchos_workflow', 'set');

      // Act
      const result = await handleGuard(input, tmpDir);

      // Assert — should pick "active-older" (ideate phase, the active workflow)
      // and allow the "set" action (which is valid in ideate)
      expect(result).toEqual({});
    });
  });
});
