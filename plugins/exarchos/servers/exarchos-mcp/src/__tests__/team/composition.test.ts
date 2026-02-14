import { describe, it, expect } from 'vitest';
import { determineComposition } from '../../team/composition.js';
import type { TaskInput, CompositionConfig, TeammateAssignment } from '../../team/composition.js';
import { ROLES } from '../../team/roles.js';

// ─── A13: Team Composition Strategy ─────────────────────────────────────────

describe('determineComposition', () => {
  const defaultConfig: CompositionConfig = {
    maxTeammates: 5,
    defaultModel: 'claude-sonnet-4-20250514',
  };

  it('3 independent tasks produce 3 implementers', () => {
    const tasks: TaskInput[] = [
      { taskId: 't1', title: 'Build login' },
      { taskId: 't2', title: 'Build signup' },
      { taskId: 't3', title: 'Build dashboard' },
    ];

    const result = determineComposition(tasks, defaultConfig);

    expect(result).toHaveLength(3);
    for (const assignment of result) {
      expect(assignment.role.name).toBe('implementer');
      expect(assignment.batch).toBe(1);
    }

    // Each task should have a unique taskId
    const taskIds = result.map((a) => a.taskId);
    expect(new Set(taskIds).size).toBe(3);
  });

  it('task with requiresReview adds a reviewer', () => {
    const tasks: TaskInput[] = [
      { taskId: 't1', title: 'Build login', requiresReview: true },
      { taskId: 't2', title: 'Build signup' },
    ];

    const result = determineComposition(tasks, defaultConfig);

    // Should have 2 implementers + 1 reviewer
    expect(result).toHaveLength(3);

    const implementers = result.filter((a) => a.role.name === 'implementer');
    const reviewers = result.filter((a) => a.role.name === 'reviewer');

    expect(implementers).toHaveLength(2);
    expect(reviewers).toHaveLength(1);
    // Reviewer should reference the task that requires review
    expect(reviewers[0].taskId).toBe('t1');
  });

  it('8 tasks with max 5 batches correctly', () => {
    const tasks: TaskInput[] = Array.from({ length: 8 }, (_, i) => ({
      taskId: `t${i + 1}`,
      title: `Task ${i + 1}`,
    }));

    const result = determineComposition(tasks, defaultConfig);

    expect(result).toHaveLength(8);

    const batch1 = result.filter((a) => a.batch === 1);
    const batch2 = result.filter((a) => a.batch === 2);

    expect(batch1).toHaveLength(5);
    expect(batch2).toHaveLength(3);
  });

  it('task type "research" maps to researcher role', () => {
    const tasks: TaskInput[] = [
      { taskId: 't1', title: 'Investigate API options', type: 'research' },
    ];

    const result = determineComposition(tasks, defaultConfig);

    expect(result).toHaveLength(1);
    expect(result[0].role.name).toBe('researcher');
  });

  it('task type "review" maps to reviewer role', () => {
    const tasks: TaskInput[] = [
      { taskId: 't1', title: 'Review PR #42', type: 'review' },
    ];

    const result = determineComposition(tasks, defaultConfig);

    expect(result).toHaveLength(1);
    expect(result[0].role.name).toBe('reviewer');
  });

  it('task type "integration" maps to integrator role', () => {
    const tasks: TaskInput[] = [
      { taskId: 't1', title: 'Merge branches', type: 'integration' },
    ];

    const result = determineComposition(tasks, defaultConfig);

    expect(result).toHaveLength(1);
    expect(result[0].role.name).toBe('integrator');
  });

  it('uses config defaultModel for all assignments', () => {
    const config: CompositionConfig = {
      maxTeammates: 5,
      defaultModel: 'custom-model',
    };

    const tasks: TaskInput[] = [
      { taskId: 't1', title: 'Build feature' },
    ];

    const result = determineComposition(tasks, config);

    expect(result[0].model).toBe('custom-model');
  });

  it('empty tasks returns empty assignments', () => {
    const result = determineComposition([], defaultConfig);
    expect(result).toHaveLength(0);
  });
});
