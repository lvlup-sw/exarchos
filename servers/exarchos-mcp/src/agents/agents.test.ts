// ─── Agent Spec Types & Definitions Tests ──────────────────────────────────

import { describe, it, expect } from 'vitest';
import type { AgentSpec, AgentSkill, AgentValidationRule, AgentSpecId } from './types.js';
import { IMPLEMENTER, FIXER, REVIEWER, ALL_AGENT_SPECS } from './definitions.js';

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
      tools: ['Read', 'Write', 'Edit'],
      disallowedTools: ['Agent'],
      model: 'opus',
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
    expect(spec.tools).toEqual(['Read', 'Write', 'Edit']);
    expect(spec.disallowedTools).toEqual(['Agent']);
    expect(spec.model).toBe('opus');
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
      tools: ['Read'],
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
});

// ─── Task 2: Agent Spec Definitions ─────────────────────────────────────────

describe('Agent Spec Definitions', () => {
  it('ImplementerSpec_HasRequiredFields_Complete', () => {
    expect(IMPLEMENTER.id).toBe('implementer');
    expect(IMPLEMENTER.model).toBe('opus');
    expect(IMPLEMENTER.isolation).toBe('worktree');
    expect(IMPLEMENTER.resumable).toBe(true);
    expect(IMPLEMENTER.memoryScope).toBe('project');
    expect(IMPLEMENTER.tools).toContain('Read');
    expect(IMPLEMENTER.tools).toContain('Write');
    expect(IMPLEMENTER.tools).toContain('Edit');
    expect(IMPLEMENTER.tools).toContain('Bash');
    expect(IMPLEMENTER.tools).toContain('Grep');
    expect(IMPLEMENTER.tools).toContain('Glob');
    expect(IMPLEMENTER.disallowedTools).toContain('Agent');
    expect(IMPLEMENTER.skills.length).toBeGreaterThanOrEqual(2);
    const skillNames = IMPLEMENTER.skills.map(s => s.name);
    expect(skillNames).toContain('tdd-patterns');
    expect(skillNames).toContain('testing-patterns');
    expect(IMPLEMENTER.validationRules.length).toBeGreaterThanOrEqual(2);
    expect(IMPLEMENTER.systemPrompt).toContain('{{taskDescription}}');
    expect(IMPLEMENTER.systemPrompt).toContain('{{requirements}}');
    expect(IMPLEMENTER.systemPrompt).toContain('{{filePaths}}');
    expect(IMPLEMENTER.description).toBeTruthy();
  });

  it('FixerSpec_IsNotResumable_ReturnsTrue', () => {
    expect(FIXER.id).toBe('fixer');
    expect(FIXER.resumable).toBe(false);
    expect(FIXER.model).toBe('opus');
    expect(FIXER.systemPrompt).toContain('{{failureContext}}');
    expect(FIXER.tools).toContain('Read');
    expect(FIXER.tools).toContain('Write');
    expect(FIXER.tools).toContain('Edit');
    expect(FIXER.tools).toContain('Bash');
  });

  it('ReviewerSpec_HasReadOnlyTools_NoWriteEdit', () => {
    expect(REVIEWER.id).toBe('reviewer');
    expect(REVIEWER.model).toBe('opus');
    expect(REVIEWER.resumable).toBe(false);
    expect(REVIEWER.tools).toContain('Read');
    expect(REVIEWER.tools).toContain('Grep');
    expect(REVIEWER.tools).toContain('Glob');
    expect(REVIEWER.tools).toContain('Bash');
    expect(REVIEWER.tools).not.toContain('Write');
    expect(REVIEWER.tools).not.toContain('Edit');
    expect(REVIEWER.disallowedTools).toContain('Write');
    expect(REVIEWER.disallowedTools).toContain('Edit');
    expect(REVIEWER.disallowedTools).toContain('Agent');
    expect(REVIEWER.systemPrompt).toContain('{{reviewScope}}');
    expect(REVIEWER.systemPrompt).toContain('{{designRequirements}}');
  });

  it('AllSpecs_HaveUniqueIds_NoDuplicates', () => {
    const ids = ALL_AGENT_SPECS.map(s => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('AllSpecs_ToolsAreValid_KnownToolNames', () => {
    const KNOWN_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebFetch', 'WebSearch']);
    for (const spec of ALL_AGENT_SPECS) {
      for (const tool of spec.tools) {
        expect(KNOWN_TOOLS.has(tool), `${spec.id}: unknown tool '${tool}'`).toBe(true);
      }
      if (spec.disallowedTools) {
        for (const tool of spec.disallowedTools) {
          expect(KNOWN_TOOLS.has(tool), `${spec.id}: unknown disallowed tool '${tool}'`).toBe(true);
        }
      }
    }
  });
});
