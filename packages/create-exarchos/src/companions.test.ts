import { describe, it, expect } from 'vitest';
import {
  COMPANIONS,
  getCompanions,
  getDefaultCompanions,
  filterCompanions,
  getCompanionInstall,
} from './companions.js';
import type { Environment } from './types.js';

describe('Companion Registry', () => {
  it('getCompanions_All_ReturnsFiveCompanions', () => {
    const all = getCompanions();
    expect(all).toHaveLength(5);
    const ids = all.map(c => c.id);
    expect(ids).toContain('axiom');
    expect(ids).toContain('impeccable');
    expect(ids).toContain('serena');
    expect(ids).toContain('context7');
    expect(ids).toContain('microsoft-learn');
  });

  it('getDefaultCompanions_DefaultsOnly_ReturnsFour', () => {
    const defaults = getDefaultCompanions();
    expect(defaults).toHaveLength(4);
    const ids = defaults.map(c => c.id);
    expect(ids).not.toContain('microsoft-learn');
  });

  it('filterCompanions_ExcludeById_RemovesSpecified', () => {
    const all = getCompanions();
    const filtered = filterCompanions(all, ['axiom']);
    expect(filtered.map(c => c.id)).not.toContain('axiom');
    expect(filtered).toHaveLength(4);
  });

  it('filterCompanions_IncludeNonDefault_AddsWhenSelected', () => {
    const defaults = getDefaultCompanions();
    expect(defaults.map(c => c.id)).not.toContain('microsoft-learn');
    const all = getCompanions();
    const msLearn = all.find(c => c.id === 'microsoft-learn')!;
    const result = [...defaults, msLearn];
    expect(result).toHaveLength(5);
  });

  it('getCompanionInstall_ClaudeCodeEnv_ReturnsPluginConfig', () => {
    const axiom = COMPANIONS.find(c => c.id === 'axiom')!;
    const install = getCompanionInstall(axiom, 'claude-code');
    expect(install).toBeDefined();
    expect(install?.plugin).toBe('axiom@lvlup-sw');
  });

  it('getCompanionInstall_CursorEnv_ReturnsSkillsOrMcpConfig', () => {
    const axiom = COMPANIONS.find(c => c.id === 'axiom')!;
    const install = getCompanionInstall(axiom, 'cursor');
    expect(install).toBeDefined();
    expect(install?.skills).toBe('lvlup-sw/axiom');
  });

  it('getCompanionInstall_GenericEnv_ReturnsMcpConfigOrNull', () => {
    const msLearn = COMPANIONS.find(c => c.id === 'microsoft-learn')!;
    const install = getCompanionInstall(msLearn, 'generic-mcp');
    expect(install).toBeDefined();
    expect(install?.mcp).toBeDefined();
    expect(install?.mcp?.type).toBe('http');
  });

  it('getCompanionInstall_CliEnv_ReturnsUndefined', () => {
    const axiom = COMPANIONS.find(c => c.id === 'axiom')!;
    const install = getCompanionInstall(axiom, 'cli');
    expect(install).toBeUndefined();
  });
});
