import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const packageJsonPath = resolve(__dirname, '..', '..', '..', 'package.json');

describe('Package scaffold', () => {
  describe('package.json', () => {
    it('has required fields: name, version, type, main', () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);

      expect(pkg.name).toBe('@lvlup-sw/exarchos-mcp');
      expect(pkg.version).toBe('1.0.0');
      expect(pkg.type).toBe('module');
      expect(pkg.main).toBe('dist/index.js');
    });

    it('has required scripts: build, test, test:run', () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);

      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts.build).toBe('tsc');
      expect(pkg.scripts.test).toBe('vitest');
      expect(pkg.scripts['test:run']).toBe('vitest run');
    });

    it('has required dependencies', () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);

      expect(pkg.dependencies).toBeDefined();
      expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
      expect(pkg.dependencies['zod']).toBeDefined();
    });

    it('has required devDependencies', () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);

      expect(pkg.devDependencies).toBeDefined();
      expect(pkg.devDependencies['typescript']).toBeDefined();
      expect(pkg.devDependencies['vitest']).toBeDefined();
      expect(pkg.devDependencies['@vitest/coverage-v8']).toBeDefined();
    });

    it('requires Node.js >= 20', () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);

      expect(pkg.engines).toBeDefined();
      expect(pkg.engines.node).toBe('>=20.0.0');
    });
  });

  describe('plugin.json', () => {
    const pluginJsonPath = resolve(__dirname, '..', '..', '..', '..', '..', '.claude-plugin', 'plugin.json');

    it('has required fields: name, description, version', () => {
      const raw = readFileSync(pluginJsonPath, 'utf-8');
      const plugin = JSON.parse(raw);

      expect(plugin.name).toBe('exarchos');
      expect(plugin.description).toBeDefined();
      expect(typeof plugin.description).toBe('string');
      expect(plugin.version).toBe('1.0.0');
    });

    it('references MCP servers configuration', () => {
      const raw = readFileSync(pluginJsonPath, 'utf-8');
      const plugin = JSON.parse(raw);

      expect(plugin.mcpServers).toBe('../mcp-servers.json');
    });
  });

  describe('mcp-servers.json', () => {
    const mcpServersJsonPath = resolve(__dirname, '..', '..', '..', '..', '..', 'mcp-servers.json');

    it('has exarchos server configuration', () => {
      const raw = readFileSync(mcpServersJsonPath, 'utf-8');
      const config = JSON.parse(raw);

      expect(config['exarchos']).toBeDefined();
      expect(config['exarchos'].type).toBe('stdio');
      expect(config['exarchos'].command).toBe('node');
    });

    it('has correct server entry point path', () => {
      const raw = readFileSync(mcpServersJsonPath, 'utf-8');
      const config = JSON.parse(raw);

      const args = config['exarchos'].args;
      expect(args).toBeInstanceOf(Array);
      expect(args).toHaveLength(1);
      expect(args[0]).toContain('servers/exarchos-mcp/dist/index.js');
    });

    it('has WORKFLOW_STATE_DIR environment variable', () => {
      const raw = readFileSync(mcpServersJsonPath, 'utf-8');
      const config = JSON.parse(raw);

      expect(config['exarchos'].env).toBeDefined();
      expect(config['exarchos'].env.WORKFLOW_STATE_DIR).toBeDefined();
    });
  });

  describe('exports', () => {
    it('exports SERVER_NAME and SERVER_VERSION', async () => {
      const { SERVER_NAME, SERVER_VERSION } = await import('../../index.js');

      expect(SERVER_NAME).toBe('exarchos-mcp');
      expect(SERVER_VERSION).toBe('1.0.0');
    });
  });
});
