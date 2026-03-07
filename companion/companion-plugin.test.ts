import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const companionRoot = join(process.cwd(), 'companion');

describe('Companion Plugin Structure', () => {
  it('companionPlugin_manifest_valid', () => {
    const pluginPath = join(companionRoot, '.claude-plugin', 'plugin.json');
    expect(existsSync(pluginPath)).toBe(true);
    const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
    expect(plugin.name).toBe('exarchos-dev-tools');
    expect(plugin.version).toBe('2.0.0');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });

  it('companionMcp_microsoftLearn_registered', () => {
    const mcpPath = join(companionRoot, '.mcp.json');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(mcp.mcpServers['microsoft-learn']).toBeDefined();
    expect(mcp.mcpServers['microsoft-learn'].type).toBe('http');
  });

  it('companionSettings_plugins_enabled', () => {
    const settingsPath = join(companionRoot, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.enabledPlugins['serena@claude-plugins-official']).toBe(true);
    expect(settings.enabledPlugins['context7@claude-plugins-official']).toBe(true);
  });
});
