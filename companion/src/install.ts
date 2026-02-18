#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

interface Settings {
  enabledPlugins?: Record<string, boolean>;
}

interface McpServerEntry {
  type: string;
  url?: string;
  command?: string;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
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

function parseJsonFile<T extends object>(filePath: string, label: string): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    process.stderr.write(
      `Warning: could not parse ${label} at ${filePath} — treating as fresh install.\n`,
    );
    return {} as T;
  }
}

function installPlugins(claudeHome: string): string[] {
  mkdirSync(claudeHome, { recursive: true });

  const settingsPath = join(claudeHome, 'settings.json');
  const settings: Settings = existsSync(settingsPath)
    ? parseJsonFile<Settings>(settingsPath, 'settings.json')
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
    ? parseJsonFile<McpConfig>(configPath, '.claude.json')
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
const isMainModule = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const mainFile = realpathSync(process.argv[1]);
    return thisFile === mainFile;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const result = installCompanion();
  console.log('Exarchos Dev Tools installed:');
  result.pluginsEnabled.forEach(p => console.log(`  Plugin enabled: ${p}`));
  result.mcpServersAdded.forEach(s => console.log(`  MCP server added: ${s}`));
}
