// ─── Team Composition Strategy ──────────────────────────────────────────────

import { ROLES } from './roles.js';
import type { RoleDefinition } from './roles.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompositionConfig {
  readonly maxTeammates: number;
  readonly defaultModel: string;
}

export interface TaskInput {
  readonly taskId: string;
  readonly title: string;
  readonly type?: string;
  readonly requiresReview?: boolean;
}

export interface TeammateAssignment {
  readonly taskId: string;
  readonly role: RoleDefinition;
  readonly model: string;
  readonly batch: number;
}

// ─── Role Mapping ───────────────────────────────────────────────────────────

const TYPE_TO_ROLE: Record<string, string> = {
  research: 'researcher',
  review: 'reviewer',
  integration: 'integrator',
  specialist: 'specialist',
};

function resolveRole(task: TaskInput): RoleDefinition {
  if (task.type && TYPE_TO_ROLE[task.type]) {
    const roleName = TYPE_TO_ROLE[task.type];
    return ROLES[roleName] ?? ROLES.implementer;
  }
  return ROLES.implementer;
}

// ─── Composition ────────────────────────────────────────────────────────────

export function determineComposition(
  tasks: TaskInput[],
  config: CompositionConfig,
): TeammateAssignment[] {
  if (tasks.length === 0) {
    return [];
  }

  if (config.maxTeammates < 1) {
    throw new Error(`maxTeammates must be >= 1, got ${config.maxTeammates}`);
  }

  const assignments: TeammateAssignment[] = [];

  // First pass: assign primary roles for each task
  for (const task of tasks) {
    assignments.push({
      taskId: task.taskId,
      role: resolveRole(task),
      model: config.defaultModel,
      batch: 0, // Will be assigned below
    });
  }

  // Second pass: add reviewers for tasks that require review
  for (const task of tasks) {
    if (task.requiresReview) {
      assignments.push({
        taskId: task.taskId,
        role: ROLES.reviewer,
        model: config.defaultModel,
        batch: 0,
      });
    }
  }

  // Assign batches based on maxTeammates
  return assignments.map((assignment, index) => ({
    ...assignment,
    batch: Math.floor(index / config.maxTeammates) + 1,
  }));
}
