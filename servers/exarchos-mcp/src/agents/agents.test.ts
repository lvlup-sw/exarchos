// ─── Agent Spec Types & Definitions Tests ──────────────────────────────────

import { describe, it, expect } from 'vitest';
import type { AgentSpec, AgentSkill, AgentValidationRule, AgentSpecId } from './types.js';

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
