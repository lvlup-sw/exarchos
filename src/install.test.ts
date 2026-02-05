import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
