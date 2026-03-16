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
  it('getCompanions_All_ReturnsSevenCompanions', () => {
    const all = getCompanions();
    expect(all).toHaveLength(7);
    const ids = all.map(c => c.id);
    expect(ids).toContain('axiom');
    expect(ids).toContain('impeccable');
    expect(ids).toContain('serena');
    expect(ids).toContain('context7');
    expect(ids).toContain('exa');
    expect(ids).toContain('playwright');
    expect(ids).toContain('microsoft-learn');
  });

  it('getDefaultCompanions_DefaultsOnly_ReturnsSix', () => {
    const defaults = getDefaultCompanions();
    expect(defaults).toHaveLength(6);
    const ids = defaults.map(c => c.id);
    expect(ids).not.toContain('microsoft-learn');
  });

  it('filterCompanions_ExcludeById_RemovesSpecified', () => {
    const all = getCompanions();
    const filtered = filterCompanions(all, ['axiom']);
    expect(filtered.map(c => c.id)).not.toContain('axiom');
    expect(filtered).toHaveLength(6);
  });

  it('filterCompanions_IncludeNonDefault_AddsWhenSelected', () => {
    const defaults = getDefaultCompanions();
    expect(defaults.map(c => c.id)).not.toContain('microsoft-learn');
    const all = getCompanions();
    const msLearn = all.find(c => c.id === 'microsoft-learn')!;
    const result = [...defaults, msLearn];
    expect(result).toHaveLength(7);
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

  it('getCompanionInstall_Exa_ClaudeCode_ReturnsHttpMcp', () => {
    const exa = COMPANIONS.find(c => c.id === 'exa')!;
    const install = getCompanionInstall(exa, 'claude-code');
    expect(install?.mcp).toBeDefined();
    expect(install?.mcp?.type).toBe('http');
    expect(install?.mcp?.url).toBe('https://mcp.exa.ai/mcp');
  });

  it('getCompanionInstall_Exa_Cursor_ReturnsHttpMcp', () => {
    const exa = COMPANIONS.find(c => c.id === 'exa')!;
    const install = getCompanionInstall(exa, 'cursor');
    expect(install?.mcp).toBeDefined();
    expect(install?.mcp?.type).toBe('http');
    expect(install?.mcp?.url).toBe('https://mcp.exa.ai/mcp');
  });

  it('getCompanionInstall_Playwright_ClaudeCode_CommandsOnly', () => {
    const pw = COMPANIONS.find(c => c.id === 'playwright')!;
    const install = getCompanionInstall(pw, 'claude-code');
    expect(install?.plugin).toBeUndefined();
    expect(install?.mcp).toBeUndefined();
    expect(install?.commands).toContain('npx @playwright/cli install');
    expect(install?.commands).toContain('npx @playwright/cli install --skills');
  });

  it('getCompanionInstall_Playwright_Cursor_CommandsOnly', () => {
    const pw = COMPANIONS.find(c => c.id === 'playwright')!;
    const install = getCompanionInstall(pw, 'cursor');
    expect(install?.plugin).toBeUndefined();
    expect(install?.mcp).toBeUndefined();
    expect(install?.commands).toContain('npx @playwright/cli install');
    expect(install?.commands).toContain('npx @playwright/cli install --skills');
  });

  it('getCompanionInstall_Playwright_GenericMcp_Undefined', () => {
    const pw = COMPANIONS.find(c => c.id === 'playwright')!;
    const install = getCompanionInstall(pw, 'generic-mcp');
    expect(install).toBeUndefined();
  });
});
