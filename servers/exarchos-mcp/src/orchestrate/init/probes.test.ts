import { describe, it, expect } from 'vitest';
import { makeStubWriterDeps, buildWriterDeps } from './probes.js';
import type { WriterDeps, WriterFs } from './probes.js';

describe('makeStubWriterDeps', () => {
  it('MakeStubWriterDeps_NoOverrides_ReturnsAllFieldsPopulated', () => {
    const deps = makeStubWriterDeps();

    expect(typeof deps.fs.readFile).toBe('function');
    expect(typeof deps.fs.writeFile).toBe('function');
    expect(typeof deps.fs.mkdir).toBe('function');
    expect(typeof deps.fs.stat).toBe('function');
    expect(typeof deps.fs.rename).toBe('function');
    expect(typeof deps.fs.copyFile).toBe('function');
    expect(typeof deps.fs.readdir).toBe('function');
    expect(typeof deps.home).toBe('function');
    expect(typeof deps.cwd).toBe('function');
    expect(deps.env).toBeDefined();
  });

  it('MakeStubWriterDeps_DefaultFs_ThrowsOnReadFile', async () => {
    const deps = makeStubWriterDeps();
    await expect(deps.fs.readFile('/any')).rejects.toThrow(/not overridden/);
  });

  it('MakeStubWriterDeps_DefaultFs_ThrowsOnWriteFile', async () => {
    const deps = makeStubWriterDeps();
    await expect(deps.fs.writeFile('/any', 'data')).rejects.toThrow(/not overridden/);
  });

  it('MakeStubWriterDeps_DefaultFs_ThrowsOnMkdir', async () => {
    const deps = makeStubWriterDeps();
    await expect(deps.fs.mkdir('/any')).rejects.toThrow(/not overridden/);
  });

  it('MakeStubWriterDeps_DefaultFs_ThrowsOnStat', async () => {
    const deps = makeStubWriterDeps();
    await expect(deps.fs.stat('/any')).rejects.toThrow(/not overridden/);
  });

  it('MakeStubWriterDeps_DefaultFs_ThrowsOnRename', async () => {
    const deps = makeStubWriterDeps();
    await expect(deps.fs.rename('/a', '/b')).rejects.toThrow(/not overridden/);
  });

  it('MakeStubWriterDeps_DefaultFs_ThrowsOnCopyFile', async () => {
    const deps = makeStubWriterDeps();
    await expect(deps.fs.copyFile('/a', '/b')).rejects.toThrow(/not overridden/);
  });

  it('MakeStubWriterDeps_DefaultFs_ThrowsOnReaddir', async () => {
    const deps = makeStubWriterDeps();
    await expect(deps.fs.readdir('/any')).rejects.toThrow(/not overridden/);
  });

  it('MakeStubWriterDeps_WithFsOverride_UsesOverriddenFs', async () => {
    const customFs: WriterFs = {
      readFile: async () => 'custom-content',
      writeFile: async () => {},
      mkdir: async () => {},
      stat: async () => ({ isDirectory: () => true, isFile: () => false }),
      rename: async () => {},
      copyFile: async () => {},
      readdir: async () => ['a', 'b'],
    };
    const deps = makeStubWriterDeps({ fs: customFs });

    const content = await deps.fs.readFile('/any');
    expect(content).toBe('custom-content');

    const entries = await deps.fs.readdir('/dir');
    expect(entries).toEqual(['a', 'b']);
  });

  it('MakeStubWriterDeps_WithHomeOverride_UsesOverriddenHome', () => {
    const deps = makeStubWriterDeps({ home: () => '/custom/home' });
    expect(deps.home()).toBe('/custom/home');
  });

  it('MakeStubWriterDeps_WithCwdOverride_UsesOverriddenCwd', () => {
    const deps = makeStubWriterDeps({ cwd: () => '/custom/cwd' });
    expect(deps.cwd()).toBe('/custom/cwd');
  });

  it('MakeStubWriterDeps_WithEnvOverride_UsesOverriddenEnv', () => {
    const deps = makeStubWriterDeps({ env: { FOO: 'bar' } });
    expect(deps.env.FOO).toBe('bar');
  });

  it('MakeStubWriterDeps_DefaultHome_ReturnsNonEmptyString', () => {
    const deps = makeStubWriterDeps();
    expect(deps.home()).toBe('/stub/home');
  });

  it('MakeStubWriterDeps_DefaultCwd_ReturnsNonEmptyString', () => {
    const deps = makeStubWriterDeps();
    expect(deps.cwd()).toBe('/stub/cwd');
  });
});

describe('buildWriterDeps', () => {
  it('BuildWriterDeps_ReturnsRealFsBindings', () => {
    const deps = buildWriterDeps();

    expect(typeof deps.fs.readFile).toBe('function');
    expect(typeof deps.fs.writeFile).toBe('function');
    expect(typeof deps.fs.mkdir).toBe('function');
    expect(typeof deps.fs.stat).toBe('function');
    expect(typeof deps.fs.rename).toBe('function');
    expect(typeof deps.fs.copyFile).toBe('function');
    expect(typeof deps.fs.readdir).toBe('function');
  });

  it('BuildWriterDeps_HomeReturnsString', () => {
    const deps = buildWriterDeps();
    expect(typeof deps.home()).toBe('string');
    expect(deps.home().length).toBeGreaterThan(0);
  });

  it('BuildWriterDeps_CwdReturnsString', () => {
    const deps = buildWriterDeps();
    expect(typeof deps.cwd()).toBe('string');
    expect(deps.cwd().length).toBeGreaterThan(0);
  });

  it('BuildWriterDeps_EnvIsRecord', () => {
    const deps = buildWriterDeps();
    expect(typeof deps.env).toBe('object');
  });
});
