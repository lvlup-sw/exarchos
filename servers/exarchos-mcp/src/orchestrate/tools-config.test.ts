import { describe, it, expect } from 'vitest';
import { getToolsConfig } from './tools-config.js';
import { DEFAULTS } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

describe('Tools Config', () => {
  it('ToolsConfig_DefaultValues_MatchExpected', () => {
    expect(DEFAULTS.tools.commitStyle).toBe('conventional');
    expect(DEFAULTS.tools.autoMerge).toBe(true);
    expect(DEFAULTS.tools.prStrategy).toBe('github-native');
    expect(DEFAULTS.tools.defaultBranch).toBeUndefined();
    expect(DEFAULTS.tools.prTemplate).toBeUndefined();
  });

  it('ToolsConfig_AutoMergeFalse_Configurable', () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      tools: { ...DEFAULTS.tools, autoMerge: false },
    };
    expect(config.tools.autoMerge).toBe(false);
  });

  it('ToolsConfig_CommitStyleConventional_IsDefault', () => {
    expect(DEFAULTS.tools.commitStyle).toBe('conventional');
  });

  it('ToolsConfig_PrStrategyGithubNative_IsDefault', () => {
    expect(DEFAULTS.tools.prStrategy).toBe('github-native');
  });

  it('ToolsConfig_PrStrategySingle_Configurable', () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      tools: { ...DEFAULTS.tools, prStrategy: 'single' },
    };
    expect(config.tools.prStrategy).toBe('single');
  });

  it('ToolsConfig_DefaultBranch_Configurable', () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      tools: { ...DEFAULTS.tools, defaultBranch: 'develop' },
    };
    expect(config.tools.defaultBranch).toBe('develop');
  });

  it('ToolsConfig_FreeformCommitStyle_Configurable', () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      tools: { ...DEFAULTS.tools, commitStyle: 'freeform' },
    };
    expect(config.tools.commitStyle).toBe('freeform');
  });

  it('getToolsConfig_WithConfig_ReturnsConfigTools', () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      tools: { ...DEFAULTS.tools, autoMerge: false, commitStyle: 'freeform' },
    };
    const tools = getToolsConfig(config);
    expect(tools.autoMerge).toBe(false);
    expect(tools.commitStyle).toBe('freeform');
  });

  it('getToolsConfig_WithoutConfig_ReturnsDefaults', () => {
    const tools = getToolsConfig(undefined);
    expect(tools.commitStyle).toBe('conventional');
    expect(tools.autoMerge).toBe(true);
    expect(tools.prStrategy).toBe('github-native');
  });

  it('getToolsConfig_WithDefaults_MatchesDefaultsTools', () => {
    const tools = getToolsConfig(DEFAULTS);
    expect(tools).toEqual(DEFAULTS.tools);
  });
});
