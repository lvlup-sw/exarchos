#!/usr/bin/env node

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest } from './manifest/loader.js';
import type { Manifest, McpServerComponent } from './manifest/types.js';
import { readConfig, writeConfig } from './operations/config.js';
import type { ExarchosConfig, WizardSelections } from './operations/config.js';
import { copyDirectory, smartCopyDirectory } from './operations/copy.js';
import { createSymlink as symlinkCreate, removeSymlink as symlinkRemove } from './operations/symlink.js';
import { readMcpConfig, writeMcpConfig, mergeMcpServers, removeMcpServers, generateMcpEntry } from './operations/mcp.js';
import { generateSettings } from './operations/settings.js';
import { installBundle } from './operations/bundle.js';
import { detectV1Install, migrateV1 } from './operations/migration.js';
import { detectRuntime } from './wizard/prerequisites.js';
import { runWizard, runNonInteractive } from './wizard/wizard.js';
import type { PromptAdapter } from './wizard/prompts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Types
export type Action = 'install' | 'uninstall' | 'help';

export interface ParsedArgs {
  action: Action;
  mode?: 'standard' | 'dev';
  nonInteractive?: boolean;
  configPath?: string;
  skipVersionCheck?: boolean;
}

// Legacy types (kept for backward compatibility with existing tests)
export type SymlinkResult = 'created' | 'skipped' | 'backed_up';
export type RemoveResult = 'removed' | 'skipped';

interface McpServerConfig {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

// ─── Legacy functions (kept for backward compatibility) ─────────────────────

export async function buildMcpServer(serverPath: string): Promise<void> {
  if (!fs.existsSync(serverPath)) {
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
  let config: ClaudeConfig = {};
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(content);
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  delete config.mcpServers['workflow-state'];

  const workflowStateDir = process.env.WORKFLOW_STATE_DIR;
  config.mcpServers['exarchos'] = {
    type: 'stdio',
    command: 'node',
    args: [join(repoRoot, 'plugins/exarchos/servers/exarchos-mcp/dist/index.js')],
    ...(workflowStateDir ? { env: { WORKFLOW_STATE_DIR: workflowStateDir } } : {})
  };

  config.mcpServers['graphite'] = {
    type: 'stdio',
    command: 'gt',
    args: ['mcp']
  };

  config.mcpServers['microsoft-learn'] = {
    type: 'http',
    url: 'https://learn.microsoft.com/api/mcp'
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  [done] Configured MCP servers in ${configPath}`);
}

export async function removeMcpConfig(configPath: string): Promise<void> {
  if (!fs.existsSync(configPath)) {
    console.log(`  [skip] ${configPath} (not found)`);
    return;
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const config: ClaudeConfig = JSON.parse(content);

  if (config.mcpServers) {
    delete config.mcpServers['workflow-state'];
    delete config.mcpServers['graphite'];
    delete config.mcpServers['exarchos'];
    delete config.mcpServers['microsoft-learn'];
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  [done] Removed MCP servers from ${configPath}`);
}

// ─── CLI argument parsing ───────────────────────────────────────────────────

export function parseArgs(args: string[]): ParsedArgs {
  if (args.includes('--help') || args.includes('-h')) {
    return { action: 'help' };
  }
  if (args.includes('--uninstall')) {
    return { action: 'uninstall' };
  }

  const result: ParsedArgs = { action: 'install' };

  if (args.includes('--dev')) {
    result.mode = 'dev';
  }

  if (args.includes('--yes')) {
    result.nonInteractive = true;
  }

  if (args.includes('--skip-version-check')) {
    result.skipVersionCheck = true;
  }

  const configIdx = args.indexOf('--config');
  if (configIdx !== -1 && configIdx + 1 < args.length) {
    result.configPath = args[configIdx + 1];
  }

  return result;
}

// ─── Path utilities ─────────────────────────────────────────────────────────

export function getClaudeHome(): string {
  return join(homedir(), '.claude');
}

export function getRepoRoot(): string {
  let root = dirname(__dirname);

  if (root.includes('.worktrees')) {
    const worktreeMatch = root.match(/^(.+)\/\.worktrees\//);
    if (worktreeMatch) {
      root = worktreeMatch[1];
    }
  }

  return root;
}

// ─── Legacy symlink utilities (kept for backward compatibility) ──────────────

const legacyCreateSymlink = async (source: string, target: string): Promise<SymlinkResult> => {
  let backedUp = false;
  let stats: fs.Stats | undefined;
  try {
    stats = fs.lstatSync(target);
  } catch {
    // Nothing exists
  }

  if (stats) {
    if (stats.isSymbolicLink()) {
      const existingTarget = fs.readlinkSync(target);
      if (existingTarget === source) {
        console.log(`  [skip] ${target} (symlink exists)`);
        return 'skipped';
      }
      console.log(`  [relink] ${target} (was -> ${existingTarget})`);
      fs.unlinkSync(target);
    } else {
      let backupPath = `${target}.backup`;
      if (fs.existsSync(backupPath)) {
        backupPath = `${backupPath}.${Date.now()}`;
      }
      console.log(`  [backup] ${target} -> ${backupPath}`);
      fs.renameSync(target, backupPath);
      backedUp = true;
    }
  }

  fs.symlinkSync(source, target);
  console.log(`  [link] ${target}`);
  return backedUp ? 'backed_up' : 'created';
};

const legacyRemoveSymlink = async (target: string): Promise<RemoveResult> => {
  if (!fs.existsSync(target)) {
    console.log(`  [skip] ${target} (not found)`);
    return 'skipped';
  }

  const stats = fs.lstatSync(target);
  if (!stats.isSymbolicLink()) {
    console.log(`  [skip] ${target} (not a symlink)`);
    return 'skipped';
  }

  fs.unlinkSync(target);
  console.log(`  [removed] ${target}`);
  return 'removed';
};

export { legacyCreateSymlink as createSymlink, legacyRemoveSymlink as removeSymlink };

// ─── Hook resolution ─────────────────────────────────────────────────────────

/**
 * Read hooks.json and resolve the {{CLI_PATH}} placeholder.
 *
 * @param hooksPath - Absolute path to hooks.json.
 * @param cliPath - Absolute path to the CLI binary.
 * @returns The hooks object with resolved paths, ready for settings.json.
 */
export function resolveHooks(
  hooksPath: string,
  cliPath: string,
): Record<string, unknown[]> {
  const raw = fs.readFileSync(hooksPath, 'utf-8');
  const resolved = raw.replace(/\{\{CLI_PATH\}\}/g, cliPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(resolved);
  } catch {
    throw new Error(`Failed to parse hooks file: ${hooksPath}`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('hooks' in parsed) ||
    typeof (parsed as Record<string, unknown>).hooks !== 'object'
  ) {
    throw new Error(`Invalid hooks file: missing 'hooks' key in ${hooksPath}`);
  }

  return (parsed as { hooks: Record<string, unknown[]> }).hooks;
}

/**
 * Resolve hooks from hooks.json for the given install mode.
 * Returns undefined if hooks.json doesn't exist or no bundled server has cliBundlePath.
 */
function resolveHooksForMode(
  repoRoot: string,
  manifest: Manifest,
  cliPath: string,
): Record<string, unknown[]> | undefined {
  const hooksPath = join(repoRoot, 'hooks.json');
  if (!fs.existsSync(hooksPath)) return undefined;

  const server = manifest.components.mcpServers.find(
    (s) => s.type === 'bundled' && s.cliBundlePath,
  );
  if (!server?.cliBundlePath) return undefined;

  return resolveHooks(hooksPath, cliPath);
}

// ─── Install dependencies interface ────────────────────────────────────────

export interface InstallDeps {
  claudeHome: string;
  repoRoot: string;
  manifestPath: string;
  claudeConfigPath: string;
  prompts: PromptAdapter;
  args: ParsedArgs;
}

export interface UninstallDeps {
  claudeHome: string;
  claudeConfigPath: string;
}

// ─── Install sub-functions ────────────────────────────────────────────────

/**
 * Get the list of rule files to install based on selected rule sets.
 */
function getSelectedRuleFiles(
  manifest: Manifest,
  selectedRuleSets: readonly string[],
): string[] {
  const files: string[] = [];
  for (const ruleSet of manifest.components.ruleSets) {
    if (selectedRuleSets.includes(ruleSet.id)) {
      files.push(...ruleSet.files);
    }
  }
  return files;
}

/**
 * Standard mode installation: copy files to ~/.claude/.
 */
async function installStandard(
  manifest: Manifest,
  selections: WizardSelections,
  claudeHome: string,
  repoRoot: string,
  claudeConfigPath: string,
  existingConfig: ExarchosConfig | null,
): Promise<void> {
  const existingHashes = existingConfig?.hashes ?? {};
  const allHashes: Record<string, string> = {};

  // 1. Copy core components (directories and files)
  for (const core of manifest.components.core) {
    const source = join(repoRoot, core.source);
    const target = join(claudeHome, core.target);
    if (core.type === 'file') {
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    } else {
      const result = smartCopyDirectory(source, target, existingHashes);
      Object.assign(allHashes, result.hashes);
    }
  }

  // 2. Copy selected rule files
  const selectedRuleFiles = getSelectedRuleFiles(manifest, selections.ruleSets);
  const rulesSource = join(repoRoot, 'rules');
  const rulesTarget = join(claudeHome, 'rules');
  fs.mkdirSync(rulesTarget, { recursive: true });

  // Copy only selected rule files
  for (const fileName of selectedRuleFiles) {
    const srcPath = join(rulesSource, fileName);
    const tgtPath = join(rulesTarget, fileName);
    if (fs.existsSync(srcPath)) {
      const content = fs.readFileSync(srcPath);
      fs.mkdirSync(dirname(tgtPath), { recursive: true });
      fs.writeFileSync(tgtPath, content);
    }
  }

  // 3. Install MCP bundles
  const bundledServers = manifest.components.mcpServers.filter(
    (s) => s.type === 'bundled' && s.bundlePath,
  );
  for (const server of bundledServers) {
    const bundlePath = join(repoRoot, server.bundlePath!);
    if (!fs.existsSync(bundlePath)) {
      throw new Error(
        `MCP server bundle not found: ${bundlePath}\n` +
        `Run 'npm run build' to generate the bundle before installing.`,
      );
    }
    installBundle(bundlePath, claudeHome);
  }

  // 3a. Install CLI bundles
  for (const server of bundledServers) {
    if (server.cliBundlePath) {
      const cliBundlePath = join(repoRoot, server.cliBundlePath);
      if (!fs.existsSync(cliBundlePath)) {
        throw new Error(
          `CLI bundle not found: ${cliBundlePath}\n` +
          `Run 'npm run build' to generate the bundle before installing.`,
        );
      }
      installBundle(cliBundlePath, claudeHome);
    }
  }

  // 3b. Resolve hooks
  const exarchosServer = manifest.components.mcpServers.find(
    (s) => s.type === 'bundled' && s.cliBundlePath,
  );
  const resolvedHooks = exarchosServer?.cliBundlePath
    ? resolveHooksForMode(repoRoot, manifest, join(claudeHome, 'mcp-servers', basename(exarchosServer.cliBundlePath)))
    : undefined;

  // 4. Generate and write settings.json
  const settings = generateSettings(selections, resolvedHooks);
  const settingsPath = join(claudeHome, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // 5. Merge MCP config
  let runtime: string;
  try {
    runtime = detectRuntime();
  } catch {
    runtime = 'node';
  }
  const selectedServers = manifest.components.mcpServers.filter(
    (s) => selections.mcpServers.includes(s.id),
  );
  const mcpConfig = readMcpConfig(claudeConfigPath);
  const mergedConfig = mergeMcpServers(mcpConfig, selectedServers, runtime, claudeHome);
  writeMcpConfig(claudeConfigPath, mergedConfig);

  // 6. Write exarchos config
  const config: ExarchosConfig = {
    version: manifest.version,
    installedAt: new Date().toISOString(),
    mode: 'standard',
    selections,
    hashes: allHashes,
  };
  writeConfig(join(claudeHome, 'exarchos.json'), config);
}

/**
 * Dev mode installation: create symlinks to repo.
 */
async function installDev(
  manifest: Manifest,
  selections: WizardSelections,
  claudeHome: string,
  repoRoot: string,
  claudeConfigPath: string,
): Promise<void> {
  // 1. Create symlinks for core directories
  for (const core of manifest.components.core) {
    const source = join(repoRoot, core.source);
    const target = join(claudeHome, core.target);
    symlinkCreate(source, target);
  }

  // 2. Symlink rules directory
  const rulesSource = join(repoRoot, 'rules');
  const rulesTarget = join(claudeHome, 'rules');
  symlinkCreate(rulesSource, rulesTarget);

  // 2a. Resolve hooks for dev mode
  const resolvedHooks = resolveHooksForMode(
    repoRoot,
    manifest,
    join(repoRoot, 'plugins/exarchos/servers/exarchos-mcp/dist/cli.js'),
  );

  // 3. Generate and write settings.json
  const settings = generateSettings(selections, resolvedHooks);
  const settingsPath = join(claudeHome, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // 4. Configure MCP servers pointing to repo
  let runtime: string;
  try {
    runtime = detectRuntime();
  } catch {
    runtime = 'node';
  }

  // For dev mode, create custom entries that point to the repo
  const mcpConfig = readMcpConfig(claudeConfigPath);
  const mcpServers = { ...mcpConfig.mcpServers ?? {} };

  // Override bundled servers to point to repo
  for (const server of manifest.components.mcpServers) {
    if (selections.mcpServers.includes(server.id)) {
      if (server.type === 'bundled') {
        const entryPoint = server.devEntryPoint ?? server.bundlePath;
        if (!entryPoint) {
          throw new Error(`Bundled MCP server '${server.id}' has no devEntryPoint or bundlePath`);
        }
        mcpServers[server.id] = {
          type: 'stdio',
          command: runtime,
          args: ['run', join(repoRoot, entryPoint)],
          env: {
            WORKFLOW_STATE_DIR: join(claudeHome, 'workflow-state'),
          },
        };
      } else {
        mcpServers[server.id] = generateMcpEntry(server, runtime, claudeHome);
      }
    }
  }

  writeMcpConfig(claudeConfigPath, { ...mcpConfig, mcpServers });

  // 5. Write exarchos config
  const config: ExarchosConfig = {
    version: manifest.version,
    installedAt: new Date().toISOString(),
    mode: 'dev',
    repoPath: repoRoot,
    selections,
    hashes: {},
  };
  writeConfig(join(claudeHome, 'exarchos.json'), config);
}

// ─── New Install Orchestrator ───────────────────────────────────────────────

export async function install(deps: InstallDeps): Promise<void> {
  const { claudeHome, repoRoot, manifestPath, claudeConfigPath, prompts, args } = deps;

  // Ensure ~/.claude exists
  fs.mkdirSync(claudeHome, { recursive: true });

  // 1. Load manifest
  const manifest = loadManifest(manifestPath);

  // 2. Detect v1 installation and migrate if needed
  const v1Detection = detectV1Install(claudeHome);
  if (v1Detection.isV1) {
    migrateV1(claudeHome);
  }

  // 3. Read existing config
  const existingConfig = readConfig(join(claudeHome, 'exarchos.json'));

  // 4. Get wizard selections
  let mode: 'standard' | 'dev';
  let selections: WizardSelections;

  if (args.nonInteractive) {
    const wizardResult = runNonInteractive(manifest, {
      useDefaults: true,
      existingConfig: existingConfig ?? undefined,
    });
    mode = args.mode ?? wizardResult.mode;
    selections = wizardResult.selections;
  } else {
    const wizardResult = await runWizard(
      manifest,
      prompts,
      existingConfig ?? undefined,
    );
    mode = wizardResult.mode;
    selections = wizardResult.selections;
  }

  // 5. Execute installation based on mode
  if (mode === 'dev') {
    await installDev(manifest, selections, claudeHome, repoRoot, claudeConfigPath);
  } else {
    await installStandard(manifest, selections, claudeHome, repoRoot, claudeConfigPath, existingConfig);
  }
}

// ─── New Uninstall Orchestrator ─────────────────────────────────────────────

export async function uninstall(deps: UninstallDeps): Promise<void> {
  const { claudeHome, claudeConfigPath } = deps;

  // 1. Read exarchos config (graceful if missing)
  const config = readConfig(join(claudeHome, 'exarchos.json'));
  if (!config) {
    console.log('No Exarchos configuration found. Nothing to uninstall.');
    return;
  }

  // 2. Remove content based on mode
  const contentDirs = ['commands', 'skills', 'scripts', 'rules'];

  if (config.mode === 'dev') {
    // Dev mode: remove symlinks
    for (const dir of contentDirs) {
      symlinkRemove(join(claudeHome, dir));
    }
  } else {
    // Standard mode: remove copied directories
    for (const dir of contentDirs) {
      const dirPath = join(claudeHome, dir);
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    }
  }

  // 3. Remove settings.json
  const settingsPath = join(claudeHome, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    fs.unlinkSync(settingsPath);
  }

  // 4. Remove MCP server bundle
  const mcpServersDir = join(claudeHome, 'mcp-servers');
  if (fs.existsSync(mcpServersDir)) {
    // Remove known bundle files
    const bundleFiles = fs.readdirSync(mcpServersDir);
    for (const file of bundleFiles) {
      if (file.endsWith('-mcp.js') || file.endsWith('-cli.js')) {
        fs.unlinkSync(join(mcpServersDir, file));
      }
    }
  }

  // 5. Remove MCP entries from ~/.claude.json
  if (fs.existsSync(claudeConfigPath)) {
    const mcpConfig = readMcpConfig(claudeConfigPath);
    const serverIds = config.selections.mcpServers;
    const cleanedConfig = removeMcpServers(mcpConfig, serverIds);
    writeMcpConfig(claudeConfigPath, cleanedConfig);
  }

  // 6. Remove exarchos.json
  const configPath = join(claudeHome, 'exarchos.json');
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

// ─── CLI help ───────────────────────────────────────────────────────────────

export function printHelp(): void {
  console.log(`
Exarchos - SDLC workflow automation for Claude Code

Usage:
  npx github:lvlup-sw/exarchos [options]

Options:
  --help, -h            Show this help message
  --uninstall           Remove installed configuration
  --dev                 Install in dev mode (symlinks)
  --yes                 Non-interactive mode (use defaults)
  --config <path>       Use a config file for selections
  --skip-version-check  Skip remote version check at startup

Examples:
  npx github:lvlup-sw/exarchos              Install configuration
  npx github:lvlup-sw/exarchos --dev        Install with symlinks
  npx github:lvlup-sw/exarchos --yes        Install with defaults
  npx github:lvlup-sw/exarchos --uninstall  Remove configuration
`);
}

// ─── CLI entry point ────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.action) {
    case 'help':
      printHelp();
      break;
    case 'uninstall': {
      const claudeHome = getClaudeHome();
      const claudeConfigPath = join(homedir(), '.claude.json');
      await uninstall({ claudeHome, claudeConfigPath });
      break;
    }
    case 'install':
    default: {
      const { createPromptAdapter } = await import('./wizard/prompts.js');
      const claudeHome = getClaudeHome();
      const repoRoot = getRepoRoot();

      // Version check against GitHub main (non-blocking)
      if (!args.skipVersionCheck) {
        const { checkVersion, formatVersionWarning } = await import('./operations/version-check.js');
        const pkgPath = join(repoRoot, 'package.json');
        const pkg: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const localVersion =
          typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof (pkg as Record<string, unknown>).version === 'string'
            ? (pkg as Record<string, string>).version
            : '0.0.0';
        const versionResult = await checkVersion(localVersion);
        if (versionResult.status === 'outdated') {
          console.log('');
          console.log(formatVersionWarning(versionResult));
          console.log('');
        }
      }

      await install({
        claudeHome,
        repoRoot,
        manifestPath: join(repoRoot, 'manifest.json'),
        claudeConfigPath: join(homedir(), '.claude.json'),
        prompts: createPromptAdapter(),
        args,
      });
      break;
    }
  }
}

// Run main only when executed directly
// Resolve symlinks for comparison — npx creates bin stub symlinks
const resolvedArgv = fs.realpathSync(process.argv[1]);
const resolvedFilename = fs.realpathSync(__filename);
if (resolvedArgv === resolvedFilename) {
  main().catch((error: Error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
