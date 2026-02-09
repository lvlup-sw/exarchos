// ─── Role Definitions + Spawn Prompt Templates ─────────────────────────────

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RoleDefinition {
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly model: string;
  readonly worktreeRequired: boolean;
}

export interface SpawnContext {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly viewState?: Record<string, unknown>;
}

// ─── Role Definitions ───────────────────────────────────────────────────────

export const ROLES: Record<string, RoleDefinition> = {
  implementer: {
    name: 'implementer',
    capabilities: ['code-generation', 'tdd', 'refactoring', 'file-editing'],
    model: 'claude-sonnet-4-20250514',
    worktreeRequired: true,
  },
  reviewer: {
    name: 'reviewer',
    capabilities: ['code-review', 'quality-analysis', 'security-audit'],
    model: 'claude-sonnet-4-20250514',
    worktreeRequired: false,
  },
  integrator: {
    name: 'integrator',
    capabilities: ['merge-resolution', 'test-execution', 'branch-management'],
    model: 'claude-sonnet-4-20250514',
    worktreeRequired: true,
  },
  researcher: {
    name: 'researcher',
    capabilities: ['documentation-search', 'api-exploration', 'design-analysis'],
    model: 'claude-sonnet-4-20250514',
    worktreeRequired: false,
  },
  specialist: {
    name: 'specialist',
    capabilities: ['domain-expertise', 'architecture-guidance', 'troubleshooting'],
    model: 'claude-sonnet-4-20250514',
    worktreeRequired: false,
  },
} as const;

// ─── Spawn Prompt Generator ─────────────────────────────────────────────────

export function generateSpawnPrompt(role: RoleDefinition, context: SpawnContext): string {
  const sections: string[] = [];

  sections.push(`# Role: ${role.name}`);
  sections.push(`You are a ${role.name} agent with capabilities: ${role.capabilities.join(', ')}.`);
  sections.push('');
  sections.push(`## Task Assignment`);
  sections.push(`- **Task ID:** ${context.taskId}`);
  sections.push(`- **Title:** ${context.taskTitle}`);

  if (context.worktreePath) {
    sections.push(`- **Worktree:** ${context.worktreePath}`);
  }

  if (context.branch) {
    sections.push(`- **Branch:** ${context.branch}`);
  }

  if (context.viewState && Object.keys(context.viewState).length > 0) {
    sections.push('');
    sections.push('## Current State');
    for (const [key, value] of Object.entries(context.viewState)) {
      sections.push(`- **${key}:** ${String(value)}`);
    }
  }

  return sections.join('\n');
}
