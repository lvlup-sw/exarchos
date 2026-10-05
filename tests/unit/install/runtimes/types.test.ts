import { describe, it, expect } from 'vitest';
import { RuntimeMapSchema } from '../../../../src/install/runtimes/types.js';
import type { RuntimeMap } from '../../../../src/install/runtimes/types.js';

/** A valid `RuntimeMap`. Each test derives its variant from this value. */
const validFixture: RuntimeMap = {
  name: 'claude',
  capabilities: {
    hasSubagents: true,
    hasSlashCommands: true,
    hasSkillChaining: true,
    mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
  },
  preferredFacade: 'mcp',
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

  /** A strict Zod object rejects an unknown key with an `unrecognized_keys` issue. */
  it('RuntimeMapSchema_UnknownTopLevelField_Rejected', () => {
    const invalid = {
      ...validFixture,
      rogueField: 'x',
    };
    const result = RuntimeMapSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasUnknownKeyError = result.error.issues.some((issue) =>
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

  /** A string in a boolean capability field must fail the parse. */
  it('RuntimeMapSchema_CapabilityBooleans_TypedCorrectly', () => {
    const invalid = {
      ...validFixture,
      capabilities: {
        ...validFixture.capabilities,
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

  /** `preferredFacade` is required, so the renderer always has an explicit facade (`mcp` or `cli`) for each runtime. */
  it('RuntimeMapSchema_MissingPreferredFacade_ThrowsValidationError', () => {
    const { preferredFacade: _preferredFacade, ...withoutFacade } = validFixture;
    const result = RuntimeMapSchema.safeParse(withoutFacade);
    expect(result.success).toBe(false);
    if (!result.success) {
      const missingIssue = result.error.issues.find(
        (issue) => issue.path.length === 1 && issue.path[0] === 'preferredFacade',
      );
      expect(missingIssue).toBeDefined();
    }
  });

  /**
   * The issue must have an invalid-enum-value code (`invalid_enum_value` or `invalid_value`).
   * A schema without the field gives an unrecognized-key issue, which must not pass this test.
   */
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
      expect(enumIssue).toBeDefined();
      expect(String(enumIssue?.code ?? '')).toMatch(/invalid_enum_value|invalid_value/);
    }
  });

  it('CapabilitiesSchema_AcceptsHooksDescriptor_Parses', () => {
    const withHooks: RuntimeMap = {
      ...validFixture,
      capabilities: {
        ...validFixture.capabilities,
        hooks: {
          profile: 'claude-json',
          canInjectContext: true,
          sessionStartEvent: 'SessionStart',
          sessionEndEvent: 'SessionEnd',
        },
      },
    };
    const parsed = RuntimeMapSchema.parse(withHooks);
    expect(parsed.capabilities.hooks?.profile).toBe('claude-json');
    expect(parsed.capabilities.hooks?.canInjectContext).toBe(true);
  });

  it('CapabilitiesSchema_HooksProfileNone_AllowsNullEvents', () => {
    const noneHooks: RuntimeMap = {
      ...validFixture,
      capabilities: {
        ...validFixture.capabilities,
        hooks: {
          profile: 'none',
          canInjectContext: false,
          sessionStartEvent: null,
          sessionEndEvent: null,
        },
      },
    };
    const parsed = RuntimeMapSchema.parse(noneHooks);
    expect(parsed.capabilities.hooks?.profile).toBe('none');
    expect(parsed.capabilities.hooks?.sessionStartEvent).toBeNull();
  });

  /** The capabilities schema is strict and has no `hasHooks` field, so a bare `hasHooks` boolean must fail the parse. */
  it('CapabilitiesSchema_RejectsBareHasHooks_Throws', () => {
    const legacy = {
      ...validFixture,
      capabilities: { ...validFixture.capabilities, hasHooks: true },
    };
    const result = RuntimeMapSchema.safeParse(legacy);
    expect(result.success).toBe(false);
  });

  it('CapabilitiesSchema_InvalidHooksProfile_Throws', () => {
    const badProfile = {
      ...validFixture,
      capabilities: {
        ...validFixture.capabilities,
        hooks: {
          profile: 'not-a-real-profile',
          canInjectContext: false,
          sessionStartEvent: null,
          sessionEndEvent: null,
        },
      },
    };
    expect(() => RuntimeMapSchema.parse(badProfile)).toThrow();
  });

  /** A cross-field refinement rejects the `none` profile together with context injection or an event name. */
  it('CapabilitiesSchema_NoneProfileWithInjection_Throws', () => {
    const inconsistent = {
      ...validFixture,
      capabilities: {
        ...validFixture.capabilities,
        hooks: {
          profile: 'none',
          canInjectContext: true,
          sessionStartEvent: 'SessionStart',
          sessionEndEvent: null,
        },
      },
    };
    expect(RuntimeMapSchema.safeParse(inconsistent).success).toBe(false);
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
