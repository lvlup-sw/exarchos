import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
