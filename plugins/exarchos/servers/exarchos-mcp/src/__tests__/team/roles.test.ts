import { describe, it, expect } from 'vitest';
import {
  ROLES,
  generateSpawnPrompt,
} from '../../team/roles.js';
import type { RoleDefinition, SpawnContext } from '../../team/roles.js';

// ─── A12: Role Definitions + Spawn Prompt Templates ─────────────────────────

describe('RoleDefinition', () => {
  it('Implementer has required fields', () => {
    const implementer = ROLES.implementer;

    expect(implementer.name).toBe('implementer');
    expect(implementer.capabilities).toBeInstanceOf(Array);
    expect(implementer.capabilities.length).toBeGreaterThan(0);
    expect(typeof implementer.model).toBe('string');
    expect(typeof implementer.worktreeRequired).toBe('boolean');
    expect(implementer.worktreeRequired).toBe(true);
  });

  it('all 5 roles are defined', () => {
    expect(ROLES.implementer).toBeDefined();
    expect(ROLES.reviewer).toBeDefined();
    expect(ROLES.integrator).toBeDefined();
    expect(ROLES.researcher).toBeDefined();
    expect(ROLES.specialist).toBeDefined();
  });

  it('each role has all required fields', () => {
    for (const [key, role] of Object.entries(ROLES)) {
      expect(role.name).toBe(key);
      expect(role.capabilities).toBeInstanceOf(Array);
      expect(role.capabilities.length).toBeGreaterThan(0);
      expect(typeof role.model).toBe('string');
      expect(role.model.length).toBeGreaterThan(0);
      expect(typeof role.worktreeRequired).toBe('boolean');
    }
  });
});

describe('generateSpawnPrompt', () => {
  it('Implementer prompt includes task and worktree', () => {
    const context: SpawnContext = {
      taskId: 'task-001',
      taskTitle: 'Implement login form',
      worktreePath: '/tmp/worktree/login',
      branch: 'feat/login',
    };

    const prompt = generateSpawnPrompt(ROLES.implementer, context);

    expect(prompt).toContain('task-001');
    expect(prompt).toContain('Implement login form');
    expect(prompt).toContain('/tmp/worktree/login');
    expect(prompt).toContain('feat/login');
    expect(prompt).toContain('implementer');
  });

  it('all roles generate valid prompts', () => {
    const context: SpawnContext = {
      taskId: 'task-002',
      taskTitle: 'Review code quality',
    };

    for (const [, role] of Object.entries(ROLES)) {
      const prompt = generateSpawnPrompt(role, context);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain(role.name);
      expect(prompt).toContain('task-002');
      expect(prompt).toContain('Review code quality');
    }
  });

  it('prompt includes viewState when provided', () => {
    const context: SpawnContext = {
      taskId: 'task-003',
      taskTitle: 'Test task',
      viewState: { phase: 'delegating', totalTasks: 5 },
    };

    const prompt = generateSpawnPrompt(ROLES.implementer, context);
    expect(prompt).toContain('delegating');
  });

  it('prompt omits worktree section when not provided', () => {
    const context: SpawnContext = {
      taskId: 'task-004',
      taskTitle: 'Research task',
    };

    const prompt = generateSpawnPrompt(ROLES.researcher, context);
    expect(prompt).toContain('task-004');
    // Should not reference worktree paths when not provided
    expect(prompt).not.toContain('undefined');
  });
});
