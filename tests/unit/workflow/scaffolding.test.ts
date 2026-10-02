import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const packageJsonPath = resolve(__dirname, '../../../package.json');

describe('Package scaffold', () => {
  describe('package.json', () => {
    /** The version pattern accepts a SemVer pre-release suffix, such as `2.9.0-rc.1`, and rejects build metadata. */
    it('has required fields: name, version, type, main', () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);

      expect(pkg.name).toBe('@lvlup-sw/exarchos');
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
      expect(pkg.type).toBe('module');
      expect(pkg.main).toBe('dist/index.js');
    });

    /** The build script is a pipeline, so the test asserts only that it still runs `tsc`. */
    it('has required scripts: build, test, test:run', () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);

      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts.build).toContain('tsc');
      expect(pkg.scripts.test).toBe('vitest');
      expect(pkg.scripts['test:run']).toBeTruthy();
    });

    /** All three MCP v2 packages must be present. A package with only `core` typechecks but serves nothing. */
    it('has required dependencies', () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);

      expect(pkg.dependencies).toBeDefined();
      expect(pkg.dependencies['@modelcontextprotocol/core']).toBeDefined();
      expect(pkg.dependencies['@modelcontextprotocol/server']).toBeDefined();
      expect(pkg.dependencies['@modelcontextprotocol/client']).toBeDefined();
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

  describe('exports', () => {
    /** The test reads the expected version from the manifest, so a version bump needs no edit here. */
    it('exports SERVER_NAME and SERVER_VERSION matching package.json', async () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);
      const { SERVER_NAME, SERVER_VERSION } = await import('../../../src/index.js');

      expect(SERVER_NAME).toBe('exarchos-mcp');
      expect(SERVER_VERSION).toBe(pkg.version);
    });
  });
});
