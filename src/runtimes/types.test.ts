import { describe, it, expect } from 'vitest';
import { RuntimeMapSchema } from './types.js';
import type { RuntimeMap } from './types.js';

/**
 * Canonical valid fixture matching the full RuntimeMap schema shape.
 * Individual tests derive invalid variants from this baseline by mutation.
 */
const validFixture: RuntimeMap = {
  name: 'claude',
  capabilities: {
    hasSubagents: true,
    hasSlashCommands: true,
    hasHooks: true,
    hasSkillChaining: true,
    mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
  },
  skillsInstallPath: '~/.claude/skills',
  detection: {
    binaries: ['claude'],
    envVars: ['CLAUDE_CODE_SESSION'],
  },
  placeholders: {
    agentLabel: 'subagent',
    skillInvocation: 'Skill',
  },
};

describe('RuntimeMapSchema', () => {
  it('RuntimeMapSchema_ValidYaml_Parses', () => {
    const parsed = RuntimeMapSchema.parse(validFixture);
    expect(parsed).toEqual(validFixture);
    expect(parsed.name).toBe('claude');
    expect(parsed.capabilities.hasSubagents).toBe(true);
    expect(parsed.capabilities.mcpPrefix).toBe('mcp__plugin_exarchos_exarchos__');
    expect(parsed.skillsInstallPath).toBe('~/.claude/skills');
    expect(parsed.detection.binaries).toEqual(['claude']);
    expect(parsed.placeholders.agentLabel).toBe('subagent');
  });

  it('RuntimeMapSchema_MissingName_ThrowsWithPath', () => {
    const { name: _name, ...withoutName } = validFixture;
    const result = RuntimeMapSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameIssue = result.error.issues.find(
        (issue) => issue.path.length === 1 && issue.path[0] === 'name',
      );
      expect(nameIssue).toBeDefined();
    }
  });

  it('RuntimeMapSchema_MissingCapability_ThrowsWithFieldName', () => {
    const { hasSubagents: _hasSubagents, ...capabilitiesWithoutSubagents } =
      validFixture.capabilities;
    const invalid = {
      ...validFixture,
      capabilities: capabilitiesWithoutSubagents,
    };
    const result = RuntimeMapSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const capIssue = result.error.issues.find(
        (issue) =>
          issue.path.length === 2 &&
          issue.path[0] === 'capabilities' &&
          issue.path[1] === 'hasSubagents',
      );
      expect(capIssue).toBeDefined();
    }
  });

  it('RuntimeMapSchema_UnknownTopLevelField_Rejected', () => {
    const invalid = {
      ...validFixture,
      rogueField: 'x',
    };
    const result = RuntimeMapSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasUnknownKeyError = result.error.issues.some((issue) =>
        // Zod raises an "unrecognized_keys" issue for strict-mode rejections
        String(issue.code ?? '').includes('unrecognized') ||
        (Array.isArray((issue as { keys?: unknown }).keys) &&
          ((issue as { keys: unknown[] }).keys).includes('rogueField')),
      );
      expect(hasUnknownKeyError).toBe(true);
    }
  });

  it('RuntimeMapSchema_EmptyPlaceholdersMap_Accepted', () => {
    const fixture = {
      ...validFixture,
      placeholders: {},
    };
    const parsed = RuntimeMapSchema.parse(fixture);
    expect(parsed.placeholders).toEqual({});
  });

  it('RuntimeMapSchema_CapabilityBooleans_TypedCorrectly', () => {
    const invalid = {
      ...validFixture,
      capabilities: {
        ...validFixture.capabilities,
        // deliberately wrong type to assert strict boolean enforcement
        hasSubagents: 'yes' as unknown as boolean,
      },
    };
    const result = RuntimeMapSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const typeIssue = result.error.issues.find(
        (issue) =>
          issue.path.length === 2 &&
          issue.path[0] === 'capabilities' &&
          issue.path[1] === 'hasSubagents',
      );
      expect(typeIssue).toBeDefined();
    }
  });
});
