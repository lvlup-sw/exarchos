import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

describe('Project Configuration', () => {
  describe('package.json', () => {
    it('should have bin entry pointing to dist/install.js', () => {
      const pkgPath = join(repoRoot, 'package.json');
      expect(existsSync(pkgPath)).toBe(true);

      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.bin).toBeDefined();
      expect(pkg.bin['exarchos']).toBe('./dist/install.js');
    });

    it('should be type module', () => {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
      expect(pkg.type).toBe('module');
    });

    it('should have required scripts', () => {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
      expect(pkg.scripts.build).toBeDefined();
      expect(pkg.scripts['test:run']).toBeDefined();
    });

    it('should have correct name and version', () => {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('@lvlup-sw/exarchos');
      expect(pkg.version).toBe('1.0.0');
    });
  });

  describe('tsconfig.json', () => {
    it('should exist with correct settings', () => {
      const tsconfigPath = join(repoRoot, 'tsconfig.json');
      expect(existsSync(tsconfigPath)).toBe(true);

      const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
      expect(tsconfig.compilerOptions.target).toBe('ES2022');
      expect(tsconfig.compilerOptions.module).toBe('NodeNext');
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it('should have correct output configuration', () => {
      const tsconfig = JSON.parse(readFileSync(join(repoRoot, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.compilerOptions.outDir).toBe('./dist');
      expect(tsconfig.compilerOptions.rootDir).toBe('./src');
    });

    it('should have NodeNext moduleResolution', () => {
      const tsconfig = JSON.parse(readFileSync(join(repoRoot, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.compilerOptions.moduleResolution).toBe('NodeNext');
    });

    it('should include src directory', () => {
      const tsconfig = JSON.parse(readFileSync(join(repoRoot, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.include).toContain('src/**/*');
    });
  });

  describe('src/install.ts', () => {
    it('should exist with shebang', () => {
      const installPath = join(repoRoot, 'src', 'install.ts');
      expect(existsSync(installPath)).toBe(true);

      const content = readFileSync(installPath, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });
  });
});

describe('buildMcpServer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should throw error for invalid path', async () => {
    const { buildMcpServer } = await import('./install.js');
    const invalidPath = '/nonexistent/path/to/mcp';

    await expect(buildMcpServer(invalidPath)).rejects.toThrow('does not exist');
  });

  it('should run npm install and build in valid directory', async () => {
    const { buildMcpServer } = await import('./install.js');

    // Create a minimal package.json in temp dir
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-mcp',
        scripts: { build: 'echo "built"' }
      })
    );

    // Should not throw
    await expect(buildMcpServer(tempDir)).resolves.not.toThrow();
  });
});

describe('configureMcpServers', () => {
  let tempDir: string;
  let configPath: string;
  let repoRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-config-test-'));
    configPath = join(tempDir, '.claude.json');
    repoRoot = '/test/repo/root';
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create new config when none exists', async () => {
    const { configureMcpServers } = await import('./install.js');

    await configureMcpServers(configPath, repoRoot);

    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers).toBeDefined();
  });

  it('should merge with existing config', async () => {
    const { configureMcpServers } = await import('./install.js');
    writeFileSync(configPath, JSON.stringify({ existingKey: 'value' }));

    await configureMcpServers(configPath, repoRoot);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.existingKey).toBe('value');
    expect(config.mcpServers).toBeDefined();
  });

  it('should add exarchos, graphite, and microsoft-learn servers', async () => {
    const { configureMcpServers } = await import('./install.js');

    await configureMcpServers(configPath, repoRoot);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['exarchos']).toBeDefined();
    expect(config.mcpServers['exarchos'].type).toBe('stdio');
    expect(config.mcpServers['microsoft-learn']).toBeDefined();
    expect(config.mcpServers['microsoft-learn'].type).toBe('http');
  });

  it('should configure exarchos server with correct command and args', async () => {
    const { configureMcpServers } = await import('./install.js');

    await configureMcpServers(configPath, repoRoot);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['exarchos'].command).toBe('node');
    expect(config.mcpServers['exarchos'].args).toContain(
      join(repoRoot, 'plugins/exarchos/servers/exarchos-mcp/dist/index.js')
    );
  });

  it('should add graphite server', async () => {
    const { configureMcpServers } = await import('./install.js');

    await configureMcpServers(configPath, repoRoot);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['graphite']).toBeDefined();
    expect(config.mcpServers['graphite'].type).toBe('stdio');
    expect(config.mcpServers['graphite'].command).toBe('gt');
    expect(config.mcpServers['graphite'].args).toEqual(['mcp']);
  });

  it('should add microsoft-learn server with correct url', async () => {
    const { configureMcpServers } = await import('./install.js');

    await configureMcpServers(configPath, repoRoot);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['microsoft-learn'].url).toBe('https://learn.microsoft.com/api/mcp');
  });

  it('should preserve existing mcpServers when merging', async () => {
    const { configureMcpServers } = await import('./install.js');
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          existingServer: { type: 'stdio', command: 'existing' }
        }
      })
    );

    await configureMcpServers(configPath, repoRoot);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.existingServer).toBeDefined();
    expect(config.mcpServers.existingServer.command).toBe('existing');
    expect(config.mcpServers['exarchos']).toBeDefined();
    expect(config.mcpServers['graphite']).toBeDefined();
    expect(config.mcpServers['microsoft-learn']).toBeDefined();
  });
});

describe('removeMcpConfig', () => {
  let tempDir: string;
  let configPath: string;
  let repoRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-remove-test-'));
    configPath = join(tempDir, '.claude.json');
    repoRoot = '/test/repo/root';
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should remove exarchos, graphite, and microsoft-learn from config', async () => {
    const { removeMcpConfig, configureMcpServers } = await import('./install.js');
    await configureMcpServers(configPath, repoRoot);

    await removeMcpConfig(configPath);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['exarchos']).toBeUndefined();
    expect(config.mcpServers['graphite']).toBeUndefined();
    expect(config.mcpServers['microsoft-learn']).toBeUndefined();
  });

  it('should preserve other config when removing servers', async () => {
    writeFileSync(configPath, JSON.stringify({
      existingKey: 'value',
      mcpServers: { 'exarchos': {}, graphite: {}, other: {} }
    }));
    const { removeMcpConfig } = await import('./install.js');

    await removeMcpConfig(configPath);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.existingKey).toBe('value');
    expect(config.mcpServers.other).toBeDefined();
  });

  it('should not throw when config does not exist', async () => {
    const { removeMcpConfig } = await import('./install.js');
    await expect(removeMcpConfig('/nonexistent/path')).resolves.not.toThrow();
  });
});

describe('parseArgs', () => {
  it('parseArgs_NoArgs_ReturnsInstallAction', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs([]);
    expect(result.action).toBe('install');
  });

  it('parseArgs_Uninstall_ReturnsUninstallAction', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['--uninstall']);
    expect(result.action).toBe('uninstall');
  });

  it('parseArgs_Help_ReturnsHelpAction', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['--help']);
    expect(result.action).toBe('help');
  });

  it('parseArgs_ShortHelp_ReturnsHelpAction', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['-h']);
    expect(result.action).toBe('help');
  });

  it('parseArgs_Dev_ReturnsDevMode', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['--dev']);
    expect(result.action).toBe('install');
    expect(result.mode).toBe('dev');
  });

  it('parseArgs_Yes_ReturnsNonInteractive', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['--yes']);
    expect(result.nonInteractive).toBe(true);
  });

  it('parseArgs_Config_ReturnsConfigPath', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['--config', '/path/to/config.json']);
    expect(result.configPath).toBe('/path/to/config.json');
  });

  it('parseArgs_MultipleFlags_CombinesCorrectly', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['--dev', '--yes', '--config', '/tmp/c.json']);
    expect(result.action).toBe('install');
    expect(result.mode).toBe('dev');
    expect(result.nonInteractive).toBe(true);
    expect(result.configPath).toBe('/tmp/c.json');
  });
});

describe('Path Utilities', () => {
  describe('getClaudeHome', () => {
    it('should return ~/.claude path', async () => {
      const { homedir } = await import('node:os');
      const { getClaudeHome } = await import('./install.js');
      const result = getClaudeHome();
      const expected = join(homedir(), '.claude');
      expect(result).toBe(expected);
    });
  });

  describe('getRepoRoot', () => {
    it('should return repository root path', async () => {
      const { getRepoRoot } = await import('./install.js');
      const result = getRepoRoot();
      // Should be parent of src directory (where install.ts lives)
      expect(result).toMatch(/lvlup-claude|exarchos$/);
      expect(result).not.toContain('.worktrees');
    });
  });
});

describe('createSymlink', () => {
  let tempDir: string;
  let sourceDir: string;
  let targetPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'symlink-test-'));
    sourceDir = join(tempDir, 'source');
    targetPath = join(tempDir, 'target');
    mkdirSync(sourceDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create symlink when target does not exist', async () => {
    const { createSymlink } = await import('./install.js');
    const result = await createSymlink(sourceDir, targetPath);

    expect(result).toBe('created');
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
  });

  it('should skip when target is already a symlink', async () => {
    const { createSymlink } = await import('./install.js');
    symlinkSync(sourceDir, targetPath);

    const result = await createSymlink(sourceDir, targetPath);
    expect(result).toBe('skipped');
  });

  it('should backup existing directory and create symlink', async () => {
    const { createSymlink } = await import('./install.js');
    mkdirSync(targetPath);
    writeFileSync(join(targetPath, 'file.txt'), 'content');

    const result = await createSymlink(sourceDir, targetPath);

    expect(result).toBe('backed_up');
    expect(existsSync(`${targetPath}.backup`)).toBe(true);
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
  });
});

describe('removeSymlink', () => {
  let tempDir: string;
  let sourceDir: string;
  let targetPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'symlink-remove-test-'));
    sourceDir = join(tempDir, 'source');
    targetPath = join(tempDir, 'target');
    mkdirSync(sourceDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should remove symlink', async () => {
    const { removeSymlink } = await import('./install.js');
    symlinkSync(sourceDir, targetPath);

    const result = await removeSymlink(targetPath);

    expect(result).toBe('removed');
    expect(existsSync(targetPath)).toBe(false);
  });

  it('should skip when target is not a symlink', async () => {
    const { removeSymlink } = await import('./install.js');
    mkdirSync(targetPath);

    const result = await removeSymlink(targetPath);

    expect(result).toBe('skipped');
    expect(existsSync(targetPath)).toBe(true);
  });

  it('should skip when target does not exist', async () => {
    const { removeSymlink } = await import('./install.js');

    const result = await removeSymlink(targetPath);

    expect(result).toBe('skipped');
  });
});

describe('Install Orchestrator (E3)', () => {
  let tempDir: string;
  let claudeHome: string;
  let fakeRepoRoot: string;
  let manifestPath: string;
  let claudeConfigPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'install-orch-test-'));
    claudeHome = join(tempDir, '.claude');
    fakeRepoRoot = join(tempDir, 'repo');
    manifestPath = join(fakeRepoRoot, 'manifest.json');
    claudeConfigPath = join(tempDir, '.claude.json');
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(fakeRepoRoot, { recursive: true });

    // Create fake repo content directories
    mkdirSync(join(fakeRepoRoot, 'commands'), { recursive: true });
    writeFileSync(join(fakeRepoRoot, 'commands', 'ideate.md'), '# Ideate');
    mkdirSync(join(fakeRepoRoot, 'skills'), { recursive: true });
    writeFileSync(join(fakeRepoRoot, 'skills', 'brainstorming.md'), '# Brainstorming');
    mkdirSync(join(fakeRepoRoot, 'scripts'), { recursive: true });
    writeFileSync(join(fakeRepoRoot, 'scripts', 'run.sh'), '#!/bin/bash');
    mkdirSync(join(fakeRepoRoot, 'rules'), { recursive: true });
    writeFileSync(join(fakeRepoRoot, 'rules', 'coding-standards-typescript.md'), '# TS Rules');
    writeFileSync(join(fakeRepoRoot, 'rules', 'tdd-typescript.md'), '# TDD');
    writeFileSync(join(fakeRepoRoot, 'rules', 'orchestrator-constraints.md'), '# Orch');

    // Create fake bundle file
    mkdirSync(join(fakeRepoRoot, 'dist'), { recursive: true });
    writeFileSync(join(fakeRepoRoot, 'dist', 'exarchos-mcp.js'), 'console.log("mcp")');

    // Create manifest
    const manifest = {
      version: '2.0.0',
      components: {
        core: [
          { id: 'commands', source: 'commands', target: 'commands', type: 'directory' },
          { id: 'skills', source: 'skills', target: 'skills', type: 'directory' },
          { id: 'scripts', source: 'scripts', target: 'scripts', type: 'directory' },
        ],
        mcpServers: [
          {
            id: 'exarchos', name: 'Exarchos',
            description: 'Workflow orchestration',
            required: true, type: 'bundled', bundlePath: 'dist/exarchos-mcp.js',
          },
          {
            id: 'graphite', name: 'Graphite',
            description: 'Stacked PRs',
            required: true, type: 'external',
            command: 'gt', args: ['mcp'], prerequisite: 'gt',
          },
        ],
        plugins: [
          { id: 'github@claude-plugins-official', name: 'GitHub', description: 'PRs', required: false, default: true },
        ],
        ruleSets: [
          { id: 'typescript', name: 'TypeScript', description: 'TS rules', files: ['coding-standards-typescript.md', 'tdd-typescript.md'], default: true },
          { id: 'workflow', name: 'Workflow', description: 'Workflow rules', files: ['orchestrator-constraints.md'], default: true },
        ],
      },
      defaults: { model: 'claude-opus-4-6', mode: 'standard' },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('install_StandardMode_CopiesAllCoreComponents', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    // Mock wizard responses: mode, servers, plugins, ruleSets, model, confirm
    const prompts = new MockPromptAdapter([
      'standard',           // mode
      [],                   // optional servers (none)
      ['github@claude-plugins-official'], // plugins
      ['typescript', 'workflow'],         // ruleSets
      'claude-opus-4-6',   // model
      true,                // confirm
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    // All core directories should be copied
    expect(existsSync(join(claudeHome, 'commands', 'ideate.md'))).toBe(true);
    expect(existsSync(join(claudeHome, 'skills', 'brainstorming.md'))).toBe(true);
    expect(existsSync(join(claudeHome, 'scripts', 'run.sh'))).toBe(true);
  });

  it('install_StandardMode_CopiesSelectedRuleSets', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    const prompts = new MockPromptAdapter([
      'standard', [], ['github@claude-plugins-official'],
      ['typescript'], // only typescript selected
      'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    // TypeScript rules should be copied
    expect(existsSync(join(claudeHome, 'rules', 'coding-standards-typescript.md'))).toBe(true);
    expect(existsSync(join(claudeHome, 'rules', 'tdd-typescript.md'))).toBe(true);
    // Workflow rules should NOT be copied (not selected)
    expect(existsSync(join(claudeHome, 'rules', 'orchestrator-constraints.md'))).toBe(false);
  });

  it('install_StandardMode_InstallsMcpBundle', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    const prompts = new MockPromptAdapter([
      'standard', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    // Bundle should be installed
    expect(existsSync(join(claudeHome, 'mcp-servers', 'exarchos-mcp.js'))).toBe(true);
  });

  it('install_StandardMode_GeneratesSettings', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    const prompts = new MockPromptAdapter([
      'standard', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    const settingsPath = join(claudeHome, 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.permissions).toBeDefined();
    expect(settings.model).toBe('claude-opus-4-6');
    expect(settings.enabledPlugins['github@claude-plugins-official']).toBe(true);
  });

  it('install_StandardMode_MergesMcpConfig', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    // Pre-existing config with user server
    writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { 'user-server': { type: 'stdio', command: 'myserver' } },
    }));

    const prompts = new MockPromptAdapter([
      'standard', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    const config = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
    expect(config.mcpServers['exarchos']).toBeDefined();
    expect(config.mcpServers['graphite']).toBeDefined();
    // User server preserved
    expect(config.mcpServers['user-server']).toBeDefined();
  });

  it('install_StandardMode_WritesExarchosConfig', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    const prompts = new MockPromptAdapter([
      'standard', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    const configPath = join(claudeHome, 'exarchos.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mode).toBe('standard');
    expect(config.version).toBe('2.0.0');
    expect(config.selections).toBeDefined();
  });

  it('install_DevMode_CreatesSymlinks', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    const prompts = new MockPromptAdapter([
      'dev', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    // Core dirs should be symlinks, not copies
    expect(lstatSync(join(claudeHome, 'commands')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(claudeHome, 'skills')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(claudeHome, 'scripts')).isSymbolicLink()).toBe(true);
  });

  it('install_DevMode_PointsMcpToRepo', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    const prompts = new MockPromptAdapter([
      'dev', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    const config = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
    // In dev mode, exarchos MCP should point to repo's dist path
    const exarchosEntry = config.mcpServers['exarchos'];
    expect(exarchosEntry).toBeDefined();
    const argsJoined = exarchosEntry.args.join(' ');
    expect(argsJoined).toContain(fakeRepoRoot);
  });

  it('install_DevMode_RecordsRepoPath', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    const prompts = new MockPromptAdapter([
      'dev', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    const exarchosConfig = JSON.parse(readFileSync(join(claudeHome, 'exarchos.json'), 'utf-8'));
    expect(exarchosConfig.mode).toBe('dev');
    expect(exarchosConfig.repoPath).toBe(fakeRepoRoot);
  });

  it('install_ReInstall_SkipsUnchangedFiles', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    // First install
    const prompts1 = new MockPromptAdapter([
      'standard', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts: prompts1,
      args: { action: 'install' },
    });

    // Second install (reinstall) — should work without errors
    const prompts2 = new MockPromptAdapter([
      'standard', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts: prompts2,
      args: { action: 'install' },
    });

    // Files should still exist
    expect(existsSync(join(claudeHome, 'commands', 'ideate.md'))).toBe(true);
    expect(existsSync(join(claudeHome, 'exarchos.json'))).toBe(true);
  });

  it('install_V1Migration_MigratesFirst', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    // Create v1 symlinks
    symlinkSync(join(fakeRepoRoot, 'skills'), join(claudeHome, 'skills'));
    symlinkSync(join(fakeRepoRoot, 'commands'), join(claudeHome, 'commands'));

    const prompts = new MockPromptAdapter([
      'standard', [], ['github@claude-plugins-official'],
      ['typescript'], 'claude-opus-4-6', true,
    ]);

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install' },
    });

    // After install, should have real copies, not symlinks
    expect(existsSync(join(claudeHome, 'commands', 'ideate.md'))).toBe(true);
    expect(existsSync(join(claudeHome, 'skills', 'brainstorming.md'))).toBe(true);
    // In standard mode the dirs should NOT be symlinks
    expect(lstatSync(join(claudeHome, 'commands')).isSymbolicLink()).toBe(false);
  });

  it('install_NonInteractive_UsesDefaults', async () => {
    const { install } = await import('./install.js');
    const { MockPromptAdapter } = await import('./wizard/prompts.js');

    const prompts = new MockPromptAdapter([]); // No responses needed

    await install({
      claudeHome,
      repoRoot: fakeRepoRoot,
      manifestPath,
      claudeConfigPath,
      prompts,
      args: { action: 'install', nonInteractive: true },
    });

    // Should still install with defaults
    expect(existsSync(join(claudeHome, 'commands', 'ideate.md'))).toBe(true);
    expect(existsSync(join(claudeHome, 'exarchos.json'))).toBe(true);
  });
});

describe('Uninstall Orchestrator (E4)', () => {
  let tempDir: string;
  let claudeHome: string;
  let fakeRepoRoot: string;
  let claudeConfigPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'uninstall-test-'));
    claudeHome = join(tempDir, '.claude');
    fakeRepoRoot = join(tempDir, 'repo');
    claudeConfigPath = join(tempDir, '.claude.json');
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(fakeRepoRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uninstall_WithConfig_RemovesCopiedContent', async () => {
    const { uninstall } = await import('./install.js');

    // Setup installed state
    mkdirSync(join(claudeHome, 'commands'), { recursive: true });
    writeFileSync(join(claudeHome, 'commands', 'ideate.md'), '# Ideate');
    mkdirSync(join(claudeHome, 'skills'), { recursive: true });
    writeFileSync(join(claudeHome, 'skills', 'test.md'), '# Test');

    const config = {
      version: '2.0.0',
      installedAt: new Date().toISOString(),
      mode: 'standard' as const,
      selections: {
        mcpServers: ['exarchos', 'graphite'],
        plugins: ['github@claude-plugins-official'],
        ruleSets: ['typescript'],
        model: 'claude-opus-4-6',
      },
      hashes: {},
    };
    writeFileSync(join(claudeHome, 'exarchos.json'), JSON.stringify(config));

    await uninstall({ claudeHome, claudeConfigPath });

    expect(existsSync(join(claudeHome, 'commands'))).toBe(false);
    expect(existsSync(join(claudeHome, 'skills'))).toBe(false);
  });

  it('uninstall_WithConfig_RemovesMcpBundle', async () => {
    const { uninstall } = await import('./install.js');

    mkdirSync(join(claudeHome, 'mcp-servers'), { recursive: true });
    writeFileSync(join(claudeHome, 'mcp-servers', 'exarchos-mcp.js'), 'mcp code');

    const config = {
      version: '2.0.0',
      installedAt: new Date().toISOString(),
      mode: 'standard' as const,
      selections: {
        mcpServers: ['exarchos', 'graphite'],
        plugins: [],
        ruleSets: [],
        model: 'claude-opus-4-6',
      },
      hashes: {},
    };
    writeFileSync(join(claudeHome, 'exarchos.json'), JSON.stringify(config));

    await uninstall({ claudeHome, claudeConfigPath });

    expect(existsSync(join(claudeHome, 'mcp-servers', 'exarchos-mcp.js'))).toBe(false);
  });

  it('uninstall_WithConfig_CleansMcpConfig', async () => {
    const { uninstall } = await import('./install.js');

    writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: {
        exarchos: { type: 'stdio', command: 'bun' },
        graphite: { type: 'stdio', command: 'gt' },
        'user-server': { type: 'stdio', command: 'myserver' },
      },
    }));

    const config = {
      version: '2.0.0',
      installedAt: new Date().toISOString(),
      mode: 'standard' as const,
      selections: {
        mcpServers: ['exarchos', 'graphite'],
        plugins: [],
        ruleSets: [],
        model: 'claude-opus-4-6',
      },
      hashes: {},
    };
    writeFileSync(join(claudeHome, 'exarchos.json'), JSON.stringify(config));

    await uninstall({ claudeHome, claudeConfigPath });

    const mcpConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
    expect(mcpConfig.mcpServers['exarchos']).toBeUndefined();
    expect(mcpConfig.mcpServers['graphite']).toBeUndefined();
    // User server preserved
    expect(mcpConfig.mcpServers['user-server']).toBeDefined();
  });

  it('uninstall_WithConfig_RemovesExarchosConfig', async () => {
    const { uninstall } = await import('./install.js');

    const config = {
      version: '2.0.0',
      installedAt: new Date().toISOString(),
      mode: 'standard' as const,
      selections: {
        mcpServers: ['exarchos'],
        plugins: [],
        ruleSets: [],
        model: 'claude-opus-4-6',
      },
      hashes: {},
    };
    writeFileSync(join(claudeHome, 'exarchos.json'), JSON.stringify(config));

    await uninstall({ claudeHome, claudeConfigPath });

    expect(existsSync(join(claudeHome, 'exarchos.json'))).toBe(false);
  });

  it('uninstall_PreservesUserFiles_InClaudeDir', async () => {
    const { uninstall } = await import('./install.js');

    // Create user files
    mkdirSync(join(claudeHome, 'projects'), { recursive: true });
    writeFileSync(join(claudeHome, 'projects', 'my-project.json'), '{}');
    writeFileSync(join(claudeHome, 'my-notes.txt'), 'notes');

    const config = {
      version: '2.0.0',
      installedAt: new Date().toISOString(),
      mode: 'standard' as const,
      selections: {
        mcpServers: [],
        plugins: [],
        ruleSets: [],
        model: 'claude-opus-4-6',
      },
      hashes: {},
    };
    writeFileSync(join(claudeHome, 'exarchos.json'), JSON.stringify(config));

    await uninstall({ claudeHome, claudeConfigPath });

    // User files preserved
    expect(existsSync(join(claudeHome, 'projects', 'my-project.json'))).toBe(true);
    expect(existsSync(join(claudeHome, 'my-notes.txt'))).toBe(true);
  });

  it('uninstall_NoConfig_GracefulError', async () => {
    const { uninstall } = await import('./install.js');

    // No exarchos.json exists
    await expect(
      uninstall({ claudeHome, claudeConfigPath }),
    ).resolves.not.toThrow();
  });

  it('uninstall_DevMode_RemovesSymlinks', async () => {
    const { uninstall } = await import('./install.js');

    // Create dev-mode symlinks
    mkdirSync(join(fakeRepoRoot, 'commands'), { recursive: true });
    mkdirSync(join(fakeRepoRoot, 'skills'), { recursive: true });
    mkdirSync(join(fakeRepoRoot, 'scripts'), { recursive: true });
    symlinkSync(join(fakeRepoRoot, 'commands'), join(claudeHome, 'commands'));
    symlinkSync(join(fakeRepoRoot, 'skills'), join(claudeHome, 'skills'));
    symlinkSync(join(fakeRepoRoot, 'scripts'), join(claudeHome, 'scripts'));

    const config = {
      version: '2.0.0',
      installedAt: new Date().toISOString(),
      mode: 'dev' as const,
      repoPath: fakeRepoRoot,
      selections: {
        mcpServers: ['exarchos'],
        plugins: [],
        ruleSets: [],
        model: 'claude-opus-4-6',
      },
      hashes: {},
    };
    writeFileSync(join(claudeHome, 'exarchos.json'), JSON.stringify(config));

    await uninstall({ claudeHome, claudeConfigPath });

    expect(existsSync(join(claudeHome, 'commands'))).toBe(false);
    expect(existsSync(join(claudeHome, 'skills'))).toBe(false);
    expect(existsSync(join(claudeHome, 'scripts'))).toBe(false);
  });
});

describe('main', () => {
  it('should be exported as a function', async () => {
    const mod = await import('./install.js');
    expect(typeof mod.main).toBe('function');
  });
});

describe('printHelp', () => {
  it('should be exported as a function', async () => {
    const mod = await import('./install.js');
    expect(typeof mod.printHelp).toBe('function');
  });
});
