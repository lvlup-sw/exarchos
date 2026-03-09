// ─── Agent Spec Handler Tests ──────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { handleAgentSpec, agentSpecSchema } from './handler.js';

describe('handleAgentSpec', () => {
  it('AgentSpec_ValidAgent_ReturnsFullSpec', async () => {
    // Arrange
    const args = { agent: 'implementer' as const, format: 'full' as const };

    // Act
    const result = await handleAgentSpec(args);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.agent).toBe('implementer');
    expect(data.systemPrompt).toBeDefined();
    expect(data.tools).toContain('Read');
    expect(data.tools).toContain('Write');
    expect(data.model).toBe('opus');
    expect(data.isolation).toBe('worktree');
    expect(data.resumable).toBe(true);
    expect(data.memoryScope).toBe('project');
    expect(data.validationRules).toBeDefined();
    expect(data.skills).toBeDefined();
    // Skills should have name but empty content (deferred to runtime)
    const skills = data.skills as Array<{ name: string; content: string }>;
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.name).toBeTruthy();
      expect(skill.content).toBe('');
    }
  });

  it('AgentSpec_UnknownAgent_ReturnsError', async () => {
    // Arrange
    const args = { agent: 'unknown-agent' } as unknown as Parameters<typeof handleAgentSpec>[0];

    // Act
    const result = await handleAgentSpec(args);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_AGENT');
    expect(result.error?.message).toContain('unknown-agent');
    // Should include validTargets in the error (matching codebase error pattern)
    expect(result.error?.validTargets).toBeDefined();
    const validTargets = result.error!.validTargets as string[];
    expect(validTargets).toContain('implementer');
    expect(validTargets).toContain('fixer');
    expect(validTargets).toContain('reviewer');
  });

  it('AgentSpec_WithContext_InterpolatesTemplateVars', async () => {
    // Arrange
    const args = {
      agent: 'implementer' as const,
      context: {
        taskDescription: 'Build the login page',
        requirements: 'Must validate email format',
        filePaths: 'src/login.ts, src/login.test.ts',
      },
      format: 'full' as const,
    };

    // Act
    const result = await handleAgentSpec(args);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const prompt = data.systemPrompt as string;
    expect(prompt).toContain('Build the login page');
    expect(prompt).toContain('Must validate email format');
    expect(prompt).toContain('src/login.ts, src/login.test.ts');
    expect(prompt).not.toContain('{{taskDescription}}');
    expect(prompt).not.toContain('{{requirements}}');
    expect(prompt).not.toContain('{{filePaths}}');
  });

  it('AgentSpec_UnresolvedVars_ReportsUnresolved', async () => {
    // Arrange: only provide one of three template vars
    const args = {
      agent: 'implementer' as const,
      context: {
        taskDescription: 'Build it',
      },
      format: 'full' as const,
    };

    // Act
    const result = await handleAgentSpec(args);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const unresolvedVars = data.unresolvedVars as string[];
    expect(unresolvedVars).toBeDefined();
    expect(unresolvedVars.length).toBeGreaterThan(0);
    expect(unresolvedVars).toContain('requirements');
    expect(unresolvedVars).toContain('filePaths');
    expect(unresolvedVars).not.toContain('taskDescription');
  });

  it('AgentSpec_PromptOnlyFormat_ReturnsJustPrompt', async () => {
    // Arrange
    const args = {
      agent: 'reviewer' as const,
      context: {
        reviewScope: 'PR #42',
        designRequirements: 'DR-1: Must have tests',
      },
      format: 'prompt-only' as const,
    };

    // Act
    const result = await handleAgentSpec(args);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.agent).toBe('reviewer');
    expect(data.systemPrompt).toBeDefined();
    expect(data.systemPrompt).toContain('PR #42');
    // prompt-only format should NOT include tools, model, etc.
    expect(data.tools).toBeUndefined();
    expect(data.model).toBeUndefined();
    expect(data.isolation).toBeUndefined();
    expect(data.validationRules).toBeUndefined();
    expect(data.skills).toBeUndefined();
    expect(data.resumable).toBeUndefined();
    // unresolvedVars should still be reported
    expect(data.unresolvedVars).toBeDefined();
  });
});

describe('agentSpecSchema', () => {
  it('should accept valid full format', () => {
    const result = agentSpecSchema.safeParse({
      agent: 'implementer',
      format: 'full',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid prompt-only format', () => {
    const result = agentSpecSchema.safeParse({
      agent: 'reviewer',
      format: 'prompt-only',
    });
    expect(result.success).toBe(true);
  });

  it('should default format to full', () => {
    const result = agentSpecSchema.safeParse({
      agent: 'fixer',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.format).toBe('full');
    }
  });

  it('should accept optional context', () => {
    const result = agentSpecSchema.safeParse({
      agent: 'implementer',
      context: { taskDescription: 'Build it' },
    });
    expect(result.success).toBe(true);
  });
});
