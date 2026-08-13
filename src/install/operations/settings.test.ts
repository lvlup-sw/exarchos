import { describe, it, expect } from 'vitest';
import type { WizardSelections } from './config.js';
import {
  generateSettings,
  generatePermissions,
} from './settings.js';

describe('Settings.json Generation (C3)', () => {
  /** Helper: create a default WizardSelections. */
  function createSelections(overrides: Partial<WizardSelections> = {}): WizardSelections {
    return {
      mcpServers: ['exarchos'],
      plugins: ['serena', 'github'],
      ruleSets: ['typescript'],
      model: 'claude-opus-4-6',
      ...overrides,
    };
  }

  describe('generateSettings', () => {
    it('generateSettings_DefaultSelections_IncludesAllPermissions', () => {
      const selections = createSelections();

      const result = generateSettings(selections);

      expect(result.permissions).toBeDefined();
      expect(result.permissions.allow).toBeDefined();
      expect(Array.isArray(result.permissions.allow)).toBe(true);
      expect(result.permissions.allow.length).toBeGreaterThan(0);
      // Should contain at least some core permissions
      expect(result.permissions.allow).toContain('Bash(git:*)');
      expect(result.permissions.allow).toContain('Bash(npm:*)');
    });

    it('generateSettings_OpusModel_SetsModelField', () => {
      const selections = createSelections({ model: 'claude-opus-4-6' });

      const result = generateSettings(selections);

      expect(result.model).toBe('claude-opus-4-6');
    });

    it('generateSettings_SonnetModel_SetsModelField', () => {
      const selections = createSelections({ model: 'claude-sonnet-4-20250514' });

      const result = generateSettings(selections);

      expect(result.model).toBe('claude-sonnet-4-20250514');
    });

    it('generateSettings_SelectedPlugins_SetsEnabledPlugins', () => {
      const selections = createSelections({
        plugins: ['serena', 'github', 'context7'],
      });

      const result = generateSettings(selections);

      expect(result.enabledPlugins).toBeDefined();
      expect(result.enabledPlugins['serena']).toBe(true);
      expect(result.enabledPlugins['github']).toBe(true);
      expect(result.enabledPlugins['context7']).toBe(true);
    });

    it('generateSettings_NoPlugins_EmptyEnabledPlugins', () => {
      const selections = createSelections({ plugins: [] });

      const result = generateSettings(selections);

      expect(result.enabledPlugins).toBeDefined();
      expect(Object.keys(result.enabledPlugins)).toHaveLength(0);
    });

    it('generateSettings_WithHooks_IncludesHooksInOutput', () => {
      const selections = createSelections();
      const hooks = {
        PreCompact: [{ matcher: 'auto', hooks: [{ type: 'command', command: 'node cli.js pre-compact' }] }],
      };

      const result = generateSettings(selections, hooks);

      expect(result.hooks).toBeDefined();
      expect(result.hooks).toEqual(hooks);
    });

    it('generateSettings_WithoutHooks_OmitsHooksKey', () => {
      const selections = createSelections();

      const result = generateSettings(selections);

      expect(result.hooks).toBeUndefined();
    });

    it('generateSettings_DefaultSelections_IncludesAgentTeamsEnv', () => {
      const selections = createSelections();

      const result = generateSettings(selections);

      expect(result.env).toBeDefined();
      expect(result.env!.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    });

    it('generateSettings_DefaultSelections_IncludesTeammateModeAuto', () => {
      const selections = createSelections();

      const result = generateSettings(selections);

      expect(result.teammateMode).toBe('auto');
    });

    it('generateSettings_DefaultSelections_IncludesAutoCompactOverride', () => {
      const selections = createSelections();

      const result = generateSettings(selections);

      expect(result.env).toBeDefined();
      expect(result.env!.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('90');
    });

    it('generateSettings_HooksStructure_PreservesEventEntries', () => {
      const selections = createSelections();
      const hooks = {
        PreCompact: [{ matcher: 'auto', hooks: [{ type: 'command', command: 'node cli.js pre-compact', timeout: 30 }] }],
        SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node cli.js session-start', timeout: 10 }] }],
      };

      const result = generateSettings(selections, hooks);

      expect(result.hooks).toBeDefined();
      expect(result.hooks!.PreCompact).toHaveLength(1);
      expect(result.hooks!.SessionStart).toHaveLength(1);
    });
  });

  describe('generatePermissions', () => {
    it('generatePermissions_Always_ReturnsComprehensiveList', () => {
      const permissions = generatePermissions();

      expect(Array.isArray(permissions)).toBe(true);
      expect(permissions.length).toBeGreaterThan(10);

      // Should contain fundamental tool permissions
      expect(permissions).toContain('Read');
      expect(permissions).toContain('Write');
      expect(permissions).toContain('Edit');
      expect(permissions).toContain('Glob');
      expect(permissions).toContain('Grep');

      // Should contain bash command permissions
      expect(permissions).toContain('Bash(git:*)');
      expect(permissions).toContain('Bash(npm:*)');
      expect(permissions).toContain('Bash(npx:*)');
      expect(permissions).toContain('Bash(gt:*)');

      // Should contain MCP wildcard
      expect(permissions).toContain('mcp__*');
    });
  });
});
