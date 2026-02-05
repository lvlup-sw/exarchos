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
      expect(pkg.bin['lvlup-claude']).toBe('./dist/install.js');
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
      expect(pkg.name).toBe('@lvlup-sw/lvlup-claude');
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

  it('should add jules and workflow-state servers', async () => {
    const { configureMcpServers } = await import('./install.js');

    await configureMcpServers(configPath, repoRoot);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.jules).toBeDefined();
    expect(config.mcpServers.jules.type).toBe('stdio');
    expect(config.mcpServers['workflow-state']).toBeDefined();
    expect(config.mcpServers['workflow-state'].type).toBe('stdio');
  });

  it('should configure jules server with correct command and args', async () => {
    const { configureMcpServers } = await import('./install.js');

    await configureMcpServers(configPath, repoRoot);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.jules.command).toBe('node');
    expect(config.mcpServers.jules.args).toContain(
      join(repoRoot, 'plugins/jules/servers/jules-mcp/dist/index.js')
    );
  });

  it('should configure workflow-state server with correct command and args', async () => {
    const { configureMcpServers } = await import('./install.js');

    await configureMcpServers(configPath, repoRoot);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['workflow-state'].command).toBe('node');
    expect(config.mcpServers['workflow-state'].args).toContain(
      join(repoRoot, 'plugins/workflow-state/servers/workflow-state-mcp/dist/index.js')
    );
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
    expect(config.mcpServers.jules).toBeDefined();
    expect(config.mcpServers['workflow-state']).toBeDefined();
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

  it('should remove jules and workflow-state from config', async () => {
    const { removeMcpConfig, configureMcpServers } = await import('./install.js');
    await configureMcpServers(configPath, repoRoot);

    await removeMcpConfig(configPath);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.jules).toBeUndefined();
    expect(config.mcpServers['workflow-state']).toBeUndefined();
  });

  it('should preserve other config when removing servers', async () => {
    writeFileSync(configPath, JSON.stringify({
      existingKey: 'value',
      mcpServers: { jules: {}, 'workflow-state': {}, other: {} }
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
  it('should return install action when no args', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs([]);
    expect(result.action).toBe('install');
  });

  it('should return uninstall action when --uninstall flag', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['--uninstall']);
    expect(result.action).toBe('uninstall');
  });

  it('should return help action when --help flag', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['--help']);
    expect(result.action).toBe('help');
  });

  it('should return help action when -h flag', async () => {
    const { parseArgs } = await import('./install.js');
    const result = parseArgs(['-h']);
    expect(result.action).toBe('help');
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
      expect(result).toMatch(/lvlup-claude$/);
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

describe('install', () => {
  it('should be exported as a function', async () => {
    const mod = await import('./install.js');
    expect(typeof mod.install).toBe('function');
  });
});
