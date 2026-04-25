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
      // SemVer 2.0.0 shape, including pre-release suffixes like `2.9.0-rc.1`.
      // Build metadata (`+...`) intentionally rejected — we don't ship it.
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
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

  describe('exports', () => {
    it('exports SERVER_NAME and SERVER_VERSION matching package.json', async () => {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);
      const { SERVER_NAME, SERVER_VERSION } = await import('../../index.js');

      expect(SERVER_NAME).toBe('exarchos-mcp');
      // Asserts the SERVER_VERSION export tracks the manifest. Hardcoding the
      // literal here was a de-facto eighth lockstep sink that drifted on past
      // bumps; reading the manifest at test time eliminates that drift.
      expect(SERVER_VERSION).toBe(pkg.version);
    });
  });
});
