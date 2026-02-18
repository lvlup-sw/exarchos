#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface Settings {
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

interface McpServerEntry {
  type: string;
  url?: string;
  command?: string;
  [key: string]: unknown;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

const PLUGINS_TO_ENABLE: Record<string, boolean> = {
  'github@claude-plugins-official': true,
  'serena@claude-plugins-official': true,
  'context7@claude-plugins-official': true,
};

const MCP_SERVERS_TO_ADD: Record<string, McpServerEntry> = {
  'microsoft-learn': {
    type: 'http',
    url: 'https://learn.microsoft.com/api/mcp',
  },
};

export function installCompanion(
  claudeHome?: string,
  claudeJsonPath?: string,
): { pluginsEnabled: string[]; mcpServersAdded: string[] } {
  const home = claudeHome ?? join(homedir(), '.claude');
  const configPath = claudeJsonPath ?? join(homedir(), '.claude.json');

  const pluginsEnabled = installPlugins(home);
  const mcpServersAdded = installMcpServers(configPath);

  return { pluginsEnabled, mcpServersAdded };
}

function installPlugins(claudeHome: string): string[] {
  mkdirSync(claudeHome, { recursive: true });

  const settingsPath = join(claudeHome, 'settings.json');
  const settings: Settings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, 'utf-8')) as Settings
    : {};

  if (!settings.enabledPlugins) {
    settings.enabledPlugins = {};
  }

  const enabled: string[] = [];

  for (const [plugin, value] of Object.entries(PLUGINS_TO_ENABLE)) {
    if (settings.enabledPlugins[plugin] !== value) {
      settings.enabledPlugins[plugin] = value;
      enabled.push(plugin);
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  return enabled;
}

function installMcpServers(configPath: string): string[] {
  const config: McpConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf-8')) as McpConfig
    : {};

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const added: string[] = [];

  for (const [name, entry] of Object.entries(MCP_SERVERS_TO_ADD)) {
    if (!config.mcpServers[name]) {
      config.mcpServers[name] = entry;
      added.push(name);
    }
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  return added;
}

// CLI entry point
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const result = installCompanion();
  console.log('Exarchos Dev Tools installed:');
  result.pluginsEnabled.forEach(p => console.log(`  Plugin enabled: ${p}`));
  result.mcpServersAdded.forEach(s => console.log(`  MCP server added: ${s}`));
}
