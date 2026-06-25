import { describe, it, expect } from 'vitest';
import { resolveExecutable } from './process.js';

describe('resolveExecutable (#1623)', () => {
  it('ResolveExecutable_BareNpmOnWin32_AppendsCmd', () => {
    expect(resolveExecutable('npm', 'win32')).toBe('npm.cmd');
    expect(resolveExecutable('npx', 'win32')).toBe('npx.cmd');
    expect(resolveExecutable('pnpm', 'win32')).toBe('pnpm.cmd');
    expect(resolveExecutable('yarn', 'win32')).toBe('yarn.cmd');
  });

  it('ResolveExecutable_BareNpmOnPosix_Unchanged', () => {
    expect(resolveExecutable('npm', 'linux')).toBe('npm');
    expect(resolveExecutable('npx', 'darwin')).toBe('npx');
  });

  it('ResolveExecutable_NativeBinaryOnWin32_Unchanged', () => {
    // git/cargo are real .exe shims — never remapped, even on Windows.
    expect(resolveExecutable('git', 'win32')).toBe('git');
    expect(resolveExecutable('cargo', 'win32')).toBe('cargo');
  });

  it('ResolveExecutable_PathOrExtension_Unchanged', () => {
    // Explicit paths and already-extensioned names are taken as-is, so a
    // caller that already resolved the shim isn't double-suffixed.
    expect(resolveExecutable('npm.cmd', 'win32')).toBe('npm.cmd');
    expect(resolveExecutable('./node_modules/.bin/vitest', 'win32')).toBe(
      './node_modules/.bin/vitest',
    );
    expect(resolveExecutable('C:\\tools\\npm', 'win32')).toBe('C:\\tools\\npm');
  });
});
