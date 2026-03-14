import { describe, it, expect } from 'vitest';
import { getToolsConfig } from './tools-config.js';
import { DEFAULTS, resolveConfig } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

describe('getToolsConfig — wiring validation (R6)', () => {
  it('getToolsConfig_WithDefaults_ReturnsDefaultTools', () => {
    const tools = getToolsConfig(DEFAULTS);

    expect(tools.defaultBranch).toBeUndefined();
    expect(tools.commitStyle).toBe('conventional');
    expect(tools.autoMerge).toBe(true);
    expect(tools.prStrategy).toBe('github-native');
  });

  it('getToolsConfig_WithOverrides_ReturnsOverriddenTools', () => {
    const config = resolveConfig({
      tools: {
        'default-branch': 'develop',
        'commit-style': 'freeform',
        'auto-merge': false,
        'pr-strategy': 'single',
      },
    });
    const tools = getToolsConfig(config);

    expect(tools.defaultBranch).toBe('develop');
    expect(tools.commitStyle).toBe('freeform');
    expect(tools.autoMerge).toBe(false);
    expect(tools.prStrategy).toBe('single');
  });

  it('getToolsConfig_UndefinedConfig_ReturnsDefaults', () => {
    const tools = getToolsConfig(undefined);

    expect(tools.commitStyle).toBe('conventional');
    expect(tools.autoMerge).toBe(true);
  });

  it('getToolsConfig_AccessibleFromProjectConfig_ViaContext', () => {
    // Verify the function works with the config shape that comes from
    // DispatchContext.projectConfig — ensuring end-to-end wiring
    const projectConfig: ResolvedProjectConfig = resolveConfig({
      tools: { 'auto-merge': false },
    });

    const tools = getToolsConfig(projectConfig);
    expect(tools.autoMerge).toBe(false);

    // Verify other defaults are preserved
    expect(tools.commitStyle).toBe('conventional');
    expect(tools.prStrategy).toBe('github-native');
  });
});
