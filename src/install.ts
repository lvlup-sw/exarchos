#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Types
export type Action = 'install' | 'uninstall' | 'help';

export interface ParsedArgs {
  action: Action;
}

export type SymlinkResult = 'created' | 'skipped' | 'backed_up';
export type RemoveResult = 'removed' | 'skipped';

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

// CLI argument parsing
export function parseArgs(args: string[]): ParsedArgs {
  if (args.includes('--help') || args.includes('-h')) {
    return { action: 'help' };
  }
  if (args.includes('--uninstall')) {
    return { action: 'uninstall' };
  }
  return { action: 'install' };
}

// Path utilities
export function getClaudeHome(): string {
  return join(homedir(), '.claude');
}

export function getRepoRoot(): string {
  // When running from dist/install.js or src/install.ts, go up one level
  // If we're in a worktree, resolve to the actual repo root
  let root = dirname(__dirname);

  // If running from a worktree, resolve to the main repo
  if (root.includes('.worktrees')) {
    // Extract the base path before .worktrees
    const worktreeMatch = root.match(/^(.+)\/\.worktrees\//);
    if (worktreeMatch) {
      root = worktreeMatch[1];
    }
  }

  return root;
}

// Symlink utilities
export async function createSymlink(source: string, target: string): Promise<SymlinkResult> {
  // Check if target exists
  if (existsSync(target)) {
    const stats = lstatSync(target);

    // Skip if already a symlink
    if (stats.isSymbolicLink()) {
      console.log(`  [skip] ${target} (symlink exists)`);
      return 'skipped';
    }

    // Backup existing directory/file
    const backupPath = `${target}.backup`;
    console.log(`  [backup] ${target} -> ${backupPath}`);
    renameSync(target, backupPath);
  }

  // Create symlink
  symlinkSync(source, target);
  console.log(`  [link] ${target}`);
  return existsSync(`${target}.backup`) ? 'backed_up' : 'created';
}

export async function removeSymlink(target: string): Promise<RemoveResult> {
  // Check if target exists
  if (!existsSync(target)) {
    console.log(`  [skip] ${target} (not found)`);
    return 'skipped';
  }

  const stats = lstatSync(target);

  // Only remove if it's a symlink
  if (!stats.isSymbolicLink()) {
    console.log(`  [skip] ${target} (not a symlink)`);
    return 'skipped';
  }

  unlinkSync(target);
  console.log(`  [removed] ${target}`);
  return 'removed';
}

// Main install orchestrator
export async function install(): Promise<void> {
  const claudeHome = getClaudeHome();
  const repoRoot = getRepoRoot();

  console.log('lvlup-claude Installation');
  console.log('=========================');
  console.log(`Repo: ${repoRoot}`);
  console.log(`Claude home: ${claudeHome}`);
  console.log('');

  // Ensure ~/.claude exists
  if (!existsSync(claudeHome)) {
    mkdirSync(claudeHome, { recursive: true });
  }

  // Create symlinks
  console.log('Creating symlinks...');
  const dirs = ['skills', 'commands', 'rules', 'scripts'];
  for (const dir of dirs) {
    await createSymlink(join(repoRoot, dir), join(claudeHome, dir));
  }
  await createSymlink(join(repoRoot, 'settings.json'), join(claudeHome, 'settings.json'));

  // Build MCP servers
  console.log('');
  console.log('Building MCP servers...');
  await buildMcpServer(join(repoRoot, 'plugins/jules/servers/jules-mcp'));
  await buildMcpServer(join(repoRoot, 'plugins/workflow-state/servers/workflow-state-mcp'));

  // Configure MCP servers
  console.log('');
  console.log('Configuring MCP servers...');
  await configureMcpServers(join(homedir(), '.claude.json'), repoRoot);

  console.log('');
  console.log('Installation complete!');
}

// Installer implementation - to be completed in subsequent tasks
console.log('lvlup-claude installer');
