#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface McpServerConfig {
  type: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

export async function buildMcpServer(serverPath: string): Promise<void> {
  if (!existsSync(serverPath)) {
    throw new Error(`MCP server path does not exist: ${serverPath}`);
  }

  console.log(`  Building MCP server at ${serverPath}...`);

  execSync('npm install --silent', {
    cwd: serverPath,
    stdio: 'inherit'
  });

  execSync('npm run build --silent', {
    cwd: serverPath,
    stdio: 'inherit'
  });

  console.log(`  [done] Built ${serverPath}`);
}

export async function configureMcpServers(configPath: string, repoRoot: string): Promise<void> {
  // Read existing config or create empty object
  let config: ClaudeConfig = {};
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8');
    config = JSON.parse(content);
  }

  // Ensure mcpServers object exists
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Add jules MCP server
  config.mcpServers.jules = {
    type: 'stdio',
    command: 'node',
    args: [join(repoRoot, 'plugins/jules/servers/jules-mcp/dist/index.js')],
    env: {
      JULES_API_KEY: '${JULES_API_KEY}'
    }
  };

  // Add workflow-state MCP server
  config.mcpServers['workflow-state'] = {
    type: 'stdio',
    command: 'node',
    args: [join(repoRoot, 'plugins/workflow-state/servers/workflow-state-mcp/dist/index.js')],
    env: {
      WORKFLOW_STATE_DIR: '${WORKFLOW_STATE_DIR}'
    }
  };

  // Write config
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  [done] Configured MCP servers in ${configPath}`);
}

export async function removeMcpConfig(configPath: string): Promise<void> {
  if (!existsSync(configPath)) {
    console.log(`  [skip] ${configPath} (not found)`);
    return;
  }

  const content = readFileSync(configPath, 'utf-8');
  const config: ClaudeConfig = JSON.parse(content);

  if (config.mcpServers) {
    delete config.mcpServers.jules;
    delete config.mcpServers['workflow-state'];
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  [done] Removed MCP servers from ${configPath}`);
}

// Installer implementation - to be completed in subsequent tasks
console.log('lvlup-claude installer');
