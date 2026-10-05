/** Tests for the `AgentSpec` types and the four agent spec definitions. */

import { describe, it, expect } from 'vitest';
import type { AgentSpec, AgentSkill, AgentValidationRule, AgentSpecId } from '../../../../src/runtime/agents/types.js';
import { IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER, ALL_AGENT_SPECS } from '../../../../src/runtime/agents/definitions.js';
import { resolveCapabilities } from '../../../../src/workflow/capabilities/posture-mapping.js';

describe('AgentSpec Types', () => {
  /**
   * The capabilities come from `resolveCapabilities`, because `AgentSpec` has no `capabilities` field.
   * The second spec omits each optional field.
   */
  it('AgentSpecTypes_ValidateShape_AcceptsCompleteSpec', () => {
    const skill: AgentSkill = { name: 'test-skill', content: 'skill content' };
    const rule: AgentValidationRule = { trigger: 'pre-write', rule: 'test must exist', command: 'test' };
    const ruleNoCommand: AgentValidationRule = { trigger: 'post-test', rule: 'must pass' };

    const spec: AgentSpec = {
      id: 'implementer' as AgentSpecId,
      description: 'TDD implementer',
      systemPrompt: 'You are an implementer',
      posture: 'task-isolated',
      disallowedTools: ['Agent'],
      model: 'inherit',
      isolation: 'worktree',
      skills: [skill],
      validationRules: [rule, ruleNoCommand],
      resumable: true,
      memoryScope: 'project',
      maxTurns: 50,
    };

    expect(spec.id).toBe('implementer');
    expect(spec.description).toBe('TDD implementer');
    expect(spec.systemPrompt).toBe('You are an implementer');
    const resolved = resolveCapabilities(spec.posture, spec.id);
    expect(resolved.has('fs:read')).toBe(true);
    expect(resolved.has('fs:write')).toBe(true);
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

    const minimalSpec: AgentSpec = {
      id: 'reviewer' as AgentSpecId,
      description: 'Code reviewer',
      systemPrompt: 'You review code',
      posture: 'read-only',
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

  /** `effort` is optional. Its type accepts `low`, `medium`, `high` and `max`. */
  it('AgentSpecTypes_EffortField_AcceptsValidValues', () => {
    const lowEffort: AgentSpec = {
      id: 'scaffolder' as AgentSpecId,
      description: 'Scaffolder',
      systemPrompt: 'scaffold',
      posture: 'read-only',
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
      posture: 'read-only',
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
      posture: 'read-only',
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
      posture: 'read-only',
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
      posture: 'read-only',
      model: 'inherit',
      skills: [],
      validationRules: [],
      resumable: true,
    };

    expect(lowEffort.effort).toBe('low');
    expect(mediumEffort.effort).toBe('medium');
    expect(highEffort.effort).toBe('high');
    expect(maxEffort.effort).toBe('max');
    expect(noEffort.effort).toBeUndefined();
  });
});

describe('Agent Spec Definitions', () => {
  it('ImplementerSpec_HasRequiredFields_Complete', () => {
    expect(IMPLEMENTER.id).toBe('implementer');
    expect(IMPLEMENTER.model).toBe('inherit');
    expect(IMPLEMENTER.isolation).toBe('worktree');
    expect(IMPLEMENTER.resumable).toBe(true);
    expect(IMPLEMENTER.memoryScope).toBe('project');
    const implementerCaps = resolveCapabilities(IMPLEMENTER.posture, IMPLEMENTER.id);
    expect(implementerCaps.has('fs:read')).toBe(true);
    expect(implementerCaps.has('fs:write')).toBe(true);
    expect(implementerCaps.has('shell:exec')).toBe(true);
    expect(implementerCaps.has('mcp:exarchos')).toBe(true);
    expect(implementerCaps.has('isolation:worktree')).toBe(true);
    expect(implementerCaps.has('session:resume')).toBe(true);
    expect(IMPLEMENTER.disallowedTools).toContain('Agent');
    expect(IMPLEMENTER.skills.length).toBeGreaterThanOrEqual(1);
    const skillNames = IMPLEMENTER.skills.map(s => s.name);
    expect(skillNames).not.toContain('tdd-patterns');
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
    const fixerCaps = resolveCapabilities(FIXER.posture, FIXER.id);
    expect(fixerCaps.has('fs:read')).toBe(true);
    expect(fixerCaps.has('fs:write')).toBe(true);
    expect(fixerCaps.has('shell:exec')).toBe(true);
    expect(fixerCaps.has('mcp:exarchos')).toBe(true);
    expect(FIXER.mcpServers).toEqual(['exarchos']);
  });

  /**
   * The reviewer keeps MCP access for read-only views through the `mcp:exarchos:readonly` tier.
   * The capability tier and the dispatch-layer action allowlist enforce the trust boundary, so the prompt has no "Forbidden MCP Actions" block.
   */
  it('ReviewerSpec_HasReadOnlyTools_NoWriteEdit', () => {
    expect(REVIEWER.id).toBe('reviewer');
    expect(REVIEWER.model).toBe('inherit');
    expect(REVIEWER.resumable).toBe(false);
    const reviewerCaps = resolveCapabilities(REVIEWER.posture, REVIEWER.id);
    expect(reviewerCaps.has('fs:read')).toBe(true);
    expect(reviewerCaps.has('mcp:exarchos:readonly')).toBe(true);
    expect(reviewerCaps.has('mcp:exarchos')).toBe(false);
    expect(reviewerCaps.has('shell:exec')).toBe(false);
    expect(reviewerCaps.has('fs:write')).toBe(false);
    expect(REVIEWER.disallowedTools).toContain('Write');
    expect(REVIEWER.disallowedTools).toContain('Edit');
    expect(REVIEWER.disallowedTools).toContain('Agent');
    expect(REVIEWER.disallowedTools).toContain('Bash');
    expect(REVIEWER.systemPrompt).toContain('{{reviewScope}}');
    expect(REVIEWER.systemPrompt).toContain('{{designRequirements}}');
    expect(REVIEWER.systemPrompt).not.toContain('Forbidden MCP Actions');
    expect(REVIEWER.mcpServers).toEqual(['exarchos']);
  });

  /**
   * The model must be `inherit`. A pinned model id outranks the `agents.tier-models` policy, which selects the model from the risk tier of the task.
   * `effort` stays `low`, because it describes the role of the scaffolder, not a model tier.
   */
  it('ScaffolderSpec_HasCorrectConfig_InheritsModelLowEffort', () => {
    expect(SCAFFOLDER.id).toBe('scaffolder');
    expect(SCAFFOLDER.model).toBe('inherit');
    expect(SCAFFOLDER.effort).toBe('low');
    expect(SCAFFOLDER.isolation).toBe('worktree');
    expect(SCAFFOLDER.resumable).toBe(false);

    const scaffolderCaps = resolveCapabilities(SCAFFOLDER.posture, SCAFFOLDER.id);
    expect(scaffolderCaps.has('fs:read')).toBe(true);
    expect(scaffolderCaps.has('fs:write')).toBe(true);
    expect(scaffolderCaps.has('shell:exec')).toBe(true);
    expect(scaffolderCaps.has('mcp:exarchos')).toBe(true);

    expect(SCAFFOLDER.disallowedTools).toContain('Agent');

    expect(SCAFFOLDER.systemPrompt).toContain('{{taskDescription}}');
    expect(SCAFFOLDER.systemPrompt).toContain('{{filePaths}}');
    expect(SCAFFOLDER.systemPrompt.toLowerCase()).toMatch(/concis/);

    expect(SCAFFOLDER.description).toBeTruthy();
  });

  it('AllSpecs_HaveUniqueIds_NoDuplicates', () => {
    const ids = ALL_AGENT_SPECS.map(s => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    expect(ids).toHaveLength(4);
    expect(ids).toContain('implementer');
    expect(ids).toContain('fixer');
    expect(ids).toContain('reviewer');
    expect(ids).toContain('scaffolder');
  });

  /** The test validates the output of `resolveCapabilities` for each spec, because a spec holds no capability list. */
  it('AllSpecs_CapabilitiesAreValid_KnownCapabilityNames', () => {
    const KNOWN_CAPS = new Set([
      'fs:read', 'fs:write', 'shell:exec',
      'subagent:spawn', 'subagent:completion-signal', 'subagent:start-signal',
      'mcp:exarchos', 'mcp:exarchos:readonly',
      'isolation:worktree', 'team:agent-teams', 'session:resume',
    ]);
    const KNOWN_DISALLOWED = new Set(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebFetch', 'WebSearch']);
    for (const spec of ALL_AGENT_SPECS) {
      for (const cap of resolveCapabilities(spec.posture, spec.id)) {
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
