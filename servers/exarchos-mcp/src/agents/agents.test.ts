// ─── Agent Spec Types & Definitions Tests ──────────────────────────────────

import { describe, it, expect } from 'vitest';
import type { AgentSpec, AgentSkill, AgentValidationRule, AgentSpecId } from './types.js';
import { IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER, ALL_AGENT_SPECS } from './definitions.js';

// ─── Task 1: AgentSpec Types ────────────────────────────────────────────────

describe('AgentSpec Types', () => {
  it('AgentSpecTypes_ValidateShape_AcceptsCompleteSpec', () => {
    // Arrange: create a complete spec using the type interfaces
    const skill: AgentSkill = { name: 'test-skill', content: 'skill content' };
    const rule: AgentValidationRule = { trigger: 'pre-write', rule: 'test must exist', command: 'test' };
    const ruleNoCommand: AgentValidationRule = { trigger: 'post-test', rule: 'must pass' };

    const spec: AgentSpec = {
      id: 'implementer' as AgentSpecId,
      description: 'TDD implementer',
      systemPrompt: 'You are an implementer',
      capabilities: ['fs:read', 'fs:write'],
      disallowedTools: ['Agent'],
      model: 'inherit',
      isolation: 'worktree',
      skills: [skill],
      validationRules: [rule, ruleNoCommand],
      resumable: true,
      memoryScope: 'project',
      maxTurns: 50,
    };

    // Assert: all fields are accessible and correctly typed
    expect(spec.id).toBe('implementer');
    expect(spec.description).toBe('TDD implementer');
    expect(spec.systemPrompt).toBe('You are an implementer');
    expect(spec.capabilities).toEqual(['fs:read', 'fs:write']);
    expect(spec.disallowedTools).toEqual(['Agent']);
    expect(spec.model).toBe('inherit');
    expect(spec.isolation).toBe('worktree');
    expect(spec.skills).toHaveLength(1);
    expect(spec.skills[0].name).toBe('test-skill');
    expect(spec.validationRules).toHaveLength(2);
    expect(spec.validationRules[0].command).toBe('test');
    expect(spec.validationRules[1].command).toBeUndefined();
    expect(spec.resumable).toBe(true);
    expect(spec.memoryScope).toBe('project');
    expect(spec.maxTurns).toBe(50);

    // Assert: optional fields can be omitted
    const minimalSpec: AgentSpec = {
      id: 'reviewer' as AgentSpecId,
      description: 'Code reviewer',
      systemPrompt: 'You review code',
      capabilities: ['fs:read'],
      model: 'sonnet',
      skills: [],
      validationRules: [],
      resumable: false,
    };
    expect(minimalSpec.disallowedTools).toBeUndefined();
    expect(minimalSpec.isolation).toBeUndefined();
    expect(minimalSpec.memoryScope).toBeUndefined();
    expect(minimalSpec.maxTurns).toBeUndefined();
  });

  it('AgentSpecTypes_EffortField_AcceptsValidValues', () => {
    // Arrange: effort field is optional and accepts specific string literals
    const lowEffort: AgentSpec = {
      id: 'scaffolder' as AgentSpecId,
      description: 'Scaffolder',
      systemPrompt: 'scaffold',
      capabilities: ['fs:read'],
      model: 'sonnet',
      effort: 'low',
      skills: [],
      validationRules: [],
      resumable: false,
    };

    const mediumEffort: AgentSpec = {
      id: 'implementer' as AgentSpecId,
      description: 'Implementer',
      systemPrompt: 'implement',
      capabilities: ['fs:read'],
      model: 'opus',
      effort: 'medium',
      skills: [],
      validationRules: [],
      resumable: true,
    };

    const highEffort: AgentSpec = {
      id: 'fixer' as AgentSpecId,
      description: 'Fixer',
      systemPrompt: 'fix',
      capabilities: ['fs:read'],
      model: 'opus',
      effort: 'high',
      skills: [],
      validationRules: [],
      resumable: false,
    };

    const maxEffort: AgentSpec = {
      id: 'reviewer' as AgentSpecId,
      description: 'Reviewer',
      systemPrompt: 'review',
      capabilities: ['fs:read'],
      model: 'opus',
      effort: 'max',
      skills: [],
      validationRules: [],
      resumable: false,
    };

    const noEffort: AgentSpec = {
      id: 'implementer' as AgentSpecId,
      description: 'Implementer',
      systemPrompt: 'implement',
      capabilities: ['fs:read'],
      model: 'inherit',
      skills: [],
      validationRules: [],
      resumable: true,
    };

    // Assert: all effort values are accepted
    expect(lowEffort.effort).toBe('low');
    expect(mediumEffort.effort).toBe('medium');
    expect(highEffort.effort).toBe('high');
    expect(maxEffort.effort).toBe('max');
    expect(noEffort.effort).toBeUndefined();
  });
});

// ─── Task 2: Agent Spec Definitions ─────────────────────────────────────────

describe('Agent Spec Definitions', () => {
  it('ImplementerSpec_HasRequiredFields_Complete', () => {
    expect(IMPLEMENTER.id).toBe('implementer');
    expect(IMPLEMENTER.model).toBe('inherit');
    expect(IMPLEMENTER.isolation).toBe('worktree');
    expect(IMPLEMENTER.resumable).toBe(true);
    expect(IMPLEMENTER.memoryScope).toBe('project');
    expect(IMPLEMENTER.capabilities).toContain('fs:read');
    expect(IMPLEMENTER.capabilities).toContain('fs:write');
    expect(IMPLEMENTER.capabilities).toContain('shell:exec');
    expect(IMPLEMENTER.capabilities).toContain('mcp:exarchos');
    expect(IMPLEMENTER.capabilities).toContain('isolation:worktree');
    expect(IMPLEMENTER.disallowedTools).toContain('Agent');
    expect(IMPLEMENTER.skills.length).toBeGreaterThanOrEqual(2);
    const skillNames = IMPLEMENTER.skills.map(s => s.name);
    expect(skillNames).toContain('tdd-patterns');
    expect(skillNames).toContain('testing-patterns');
    expect(IMPLEMENTER.validationRules.length).toBeGreaterThanOrEqual(2);
    expect(IMPLEMENTER.systemPrompt).toContain('{{taskDescription}}');
    expect(IMPLEMENTER.systemPrompt).toContain('{{requirements}}');
    expect(IMPLEMENTER.systemPrompt).toContain('{{filePaths}}');
    expect(IMPLEMENTER.mcpServers).toEqual(['exarchos']);
    expect(IMPLEMENTER.description).toBeTruthy();
  });

  it('FixerSpec_IsNotResumable_ReturnsTrue', () => {
    expect(FIXER.id).toBe('fixer');
    expect(FIXER.resumable).toBe(false);
    expect(FIXER.model).toBe('inherit');
    expect(FIXER.systemPrompt).toContain('{{failureContext}}');
    expect(FIXER.capabilities).toContain('fs:read');
    expect(FIXER.capabilities).toContain('fs:write');
    expect(FIXER.capabilities).toContain('shell:exec');
    expect(FIXER.capabilities).toContain('mcp:exarchos');
    expect(FIXER.mcpServers).toEqual(['exarchos']);
  });

  it('ReviewerSpec_HasReadOnlyTools_NoWriteEdit', () => {
    expect(REVIEWER.id).toBe('reviewer');
    expect(REVIEWER.model).toBe('inherit');
    expect(REVIEWER.resumable).toBe(false);
    expect(REVIEWER.capabilities).toContain('fs:read');
    expect(REVIEWER.capabilities).toContain('shell:exec');
    expect(REVIEWER.capabilities).toContain('mcp:exarchos');
    expect(REVIEWER.capabilities).not.toContain('fs:write');
    expect(REVIEWER.disallowedTools).toContain('Write');
    expect(REVIEWER.disallowedTools).toContain('Edit');
    expect(REVIEWER.disallowedTools).toContain('Agent');
    expect(REVIEWER.systemPrompt).toContain('{{reviewScope}}');
    expect(REVIEWER.systemPrompt).toContain('{{designRequirements}}');
    expect(REVIEWER.mcpServers).toEqual(['exarchos']);
  });

  it('ScaffolderSpec_HasCorrectConfig_SonnetModelLowEffort', () => {
    // Assert: scaffolder identity and model config
    expect(SCAFFOLDER.id).toBe('scaffolder');
    expect(SCAFFOLDER.model).toBe('sonnet');
    expect(SCAFFOLDER.effort).toBe('low');
    expect(SCAFFOLDER.isolation).toBe('worktree');
    expect(SCAFFOLDER.resumable).toBe(false);

    // Assert: capabilities include filesystem + shell + MCP access
    expect(SCAFFOLDER.capabilities).toContain('fs:read');
    expect(SCAFFOLDER.capabilities).toContain('fs:write');
    expect(SCAFFOLDER.capabilities).toContain('shell:exec');
    expect(SCAFFOLDER.capabilities).toContain('mcp:exarchos');

    // Assert: Agent tool is disallowed
    expect(SCAFFOLDER.disallowedTools).toContain('Agent');

    // Assert: conciseness-focused system prompt with required template vars
    expect(SCAFFOLDER.systemPrompt).toContain('{{taskDescription}}');
    expect(SCAFFOLDER.systemPrompt).toContain('{{filePaths}}');
    expect(SCAFFOLDER.systemPrompt.toLowerCase()).toMatch(/concis/);

    // Assert: description is present
    expect(SCAFFOLDER.description).toBeTruthy();
  });

  it('AllSpecs_HaveUniqueIds_NoDuplicates', () => {
    const ids = ALL_AGENT_SPECS.map(s => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    // Must include all 4 agent specs
    expect(ids).toHaveLength(4);
    expect(ids).toContain('implementer');
    expect(ids).toContain('fixer');
    expect(ids).toContain('reviewer');
    expect(ids).toContain('scaffolder');
  });

  it('AllSpecs_CapabilitiesAreValid_KnownCapabilityNames', () => {
    const KNOWN_CAPS = new Set([
      'fs:read', 'fs:write', 'shell:exec',
      'subagent:spawn', 'subagent:completion-signal', 'subagent:start-signal',
      'mcp:exarchos', 'isolation:worktree', 'team:agent-teams', 'session:resume',
    ]);
    const KNOWN_DISALLOWED = new Set(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebFetch', 'WebSearch']);
    for (const spec of ALL_AGENT_SPECS) {
      for (const cap of spec.capabilities) {
        expect(KNOWN_CAPS.has(cap), `${spec.id}: unknown capability '${cap}'`).toBe(true);
      }
      if (spec.disallowedTools) {
        for (const tool of spec.disallowedTools) {
          expect(KNOWN_DISALLOWED.has(tool), `${spec.id}: unknown disallowed tool '${tool}'`).toBe(true);
        }
      }
    }
  });
});
