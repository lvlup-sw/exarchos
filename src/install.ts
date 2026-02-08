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

export async function configureMcpServers(
  configPath: string,
  repoRoot: string
): Promise<void> {
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

  // Add workflow-state MCP server (always required for workflow orchestration)
  const workflowStateDir = process.env.WORKFLOW_STATE_DIR;
  config.mcpServers['workflow-state'] = {
    type: 'stdio',
    command: 'node',
    args: [join(repoRoot, 'plugins/workflow-state/servers/workflow-state-mcp/dist/index.js')],
    ...(workflowStateDir ? { env: { WORKFLOW_STATE_DIR: workflowStateDir } } : {})
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
  let backedUp = false;

  // Check if target exists
  if (existsSync(target)) {
    const stats = lstatSync(target);

    // Skip if already a symlink
    if (stats.isSymbolicLink()) {
      console.log(`  [skip] ${target} (symlink exists)`);
      return 'skipped';
    }

    // Backup existing directory/file
    let backupPath = `${target}.backup`;
    if (existsSync(backupPath)) {
      backupPath = `${backupPath}.${Date.now()}`;
    }
    console.log(`  [backup] ${target} -> ${backupPath}`);
    renameSync(target, backupPath);
    backedUp = true;
  }

  // Create symlink
  symlinkSync(source, target);
  console.log(`  [link] ${target}`);
  return backedUp ? 'backed_up' : 'created';
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
  await buildMcpServer(join(repoRoot, 'plugins/workflow-state/servers/workflow-state-mcp'));

  // Configure MCP servers
  console.log('');
  console.log('Configuring MCP servers...');
  await configureMcpServers(join(homedir(), '.claude.json'), repoRoot);

  console.log('');
  console.log('Installation complete!');
}

// Main uninstall orchestrator
export async function uninstall(): Promise<void> {
  const claudeHome = getClaudeHome();

  console.log('lvlup-claude Uninstall');
  console.log('======================');
  console.log(`Claude home: ${claudeHome}`);
  console.log('');

  // Remove symlinks
  console.log('Removing symlinks...');
  const dirs = ['skills', 'commands', 'rules', 'scripts'];
  for (const dir of dirs) {
    await removeSymlink(join(claudeHome, dir));
  }
  await removeSymlink(join(claudeHome, 'settings.json'));

  // Remove MCP config
  console.log('');
  console.log('Removing MCP configuration...');
  await removeMcpConfig(join(homedir(), '.claude.json'));

  console.log('');
  console.log('Uninstall complete!');
}

// CLI help
export function printHelp(): void {
  console.log(`
lvlup-claude - Claude Code configuration installer

Usage:
  npx github:lvlup-sw/lvlup-claude [options]

Options:
  --help, -h      Show this help message
  --uninstall     Remove installed configuration

Examples:
  npx github:lvlup-sw/lvlup-claude              Install configuration
  npx github:lvlup-sw/lvlup-claude --uninstall  Remove configuration
`);
}

// CLI entry point
export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.action) {
    case 'help':
      printHelp();
      break;
    case 'uninstall':
      await uninstall();
      break;
    case 'install':
    default:
      await install();
      break;
  }
}

// Run main only when executed directly
if (process.argv[1] === __filename) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
