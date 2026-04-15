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

  // preferredFacade (DR-1): each runtime declares its preferred skill-authoring
  // facade — `"mcp"` for runtimes where agents call Exarchos via MCP tools,
  // `"cli"` for runtimes that prefer bash-style CLI invocations. The field is
  // required so the renderer always has an explicit answer per runtime.

  it('RuntimeMapSchema_MissingPreferredFacade_ThrowsValidationError', () => {
    // `validFixture` currently has no `preferredFacade` — constructing the
    // parse input from it directly exercises the "missing required field"
    // case without needing to delete a key.
    const result = RuntimeMapSchema.safeParse(validFixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const missingIssue = result.error.issues.find(
        (issue) => issue.path.length === 1 && issue.path[0] === 'preferredFacade',
      );
      expect(missingIssue).toBeDefined();
    }
  });

  it('RuntimeMapSchema_InvalidPreferredFacade_ThrowsValidationError', () => {
    const invalid = {
      ...validFixture,
      preferredFacade: 'grpc',
    };
    const result = RuntimeMapSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const enumIssue = result.error.issues.find(
        (issue) => issue.path.length === 1 && issue.path[0] === 'preferredFacade',
      );
      // Must be an enum-invalid-value error, not an unrecognized-keys error —
      // otherwise the test would pass trivially against the pre-DR-1 schema.
      expect(enumIssue).toBeDefined();
      expect(String(enumIssue?.code ?? '')).toMatch(/invalid_enum_value|invalid_value/);
    }
  });

  it('RuntimeMapSchema_ValidPreferredFacade_ParsesSuccessfully', () => {
    const mcpFixture = { ...validFixture, preferredFacade: 'mcp' as const };
    const cliFixture = { ...validFixture, preferredFacade: 'cli' as const };

    const mcpParsed = RuntimeMapSchema.parse(mcpFixture);
    const cliParsed = RuntimeMapSchema.parse(cliFixture);

    expect(mcpParsed.preferredFacade).toBe('mcp');
    expect(cliParsed.preferredFacade).toBe('cli');
  });
});
