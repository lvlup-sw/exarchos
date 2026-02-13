import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleGuard } from './guard.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

/** Create a minimal valid state file JSON for a given phase. */
function makeStateJson(featureId: string, phase: string): string {
  const now = new Date().toISOString();
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
): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: mcpToolName,
    tool_input: { action },
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
});
