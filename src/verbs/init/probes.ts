/**
 * WriterDeps — the injectable dependency bundle passed to every
 * RuntimeConfigWriter. Mirrors the DoctorProbes pattern: real bindings
 * via `buildWriterDeps()`, in-memory stubs via `makeStubWriterDeps()`
 * for tests.
 *
 * All side effects (fs, home, cwd, env) are injected so unit tests can
 * exercise writers without touching disk. Stubs throw by default on
 * every fs method so accidental dependencies on un-stubbed probes
 * surface as loud failures.
 */

import { promises as nodeFs } from 'node:fs';

/** Narrow filesystem surface for writers. Async throughout so
 * implementations can be in-memory maps for testing. */
export interface WriterFs {
  readFile(p: string): Promise<string>;
  writeFile(p: string, content: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  stat(p: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  rename(oldPath: string, newPath: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  readdir(p: string): Promise<string[]>;
}

/** The dependency bundle passed to every RuntimeConfigWriter. */
export interface WriterDeps {
  readonly fs: WriterFs;
  readonly home: () => string;
  readonly cwd: () => string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const throwing = (field: string): (() => Promise<never>) => {
  return () => Promise.reject(new Error(`probe not overridden: ${field}`));
};

/**
 * Build an in-memory stub WriterDeps where every fs method throws by
 * default. Tests override only the fields they exercise.
 */
export function makeStubWriterDeps(overrides?: Partial<WriterDeps>): WriterDeps {
  const base: WriterDeps = {
    fs: {
      readFile: throwing('fs.readFile'),
      writeFile: throwing('fs.writeFile'),
      mkdir: throwing('fs.mkdir'),
      stat: throwing('fs.stat'),
      rename: throwing('fs.rename'),
      copyFile: throwing('fs.copyFile'),
      readdir: throwing('fs.readdir'),
    },
    home: () => '/stub/home',
    cwd: () => '/stub/cwd',
    env: {},
  };
  return { ...base, ...overrides };
}

/**
 * Build a real WriterDeps bundle from node:fs and process globals.
 * Production callers use this; tests use makeStubWriterDeps.
 */
export function buildWriterDeps(): WriterDeps {
  return {
    fs: {
      readFile: (p) => nodeFs.readFile(p, 'utf8'),
      writeFile: (p, content) => nodeFs.writeFile(p, content, 'utf8'),
      mkdir: (p, opts) => nodeFs.mkdir(p, opts).then(() => undefined),
      stat: (p) => nodeFs.stat(p),
      rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
      copyFile: (src, dest) => nodeFs.copyFile(src, dest),
      readdir: (p) => nodeFs.readdir(p),
    },
    home: () => process.env.HOME ?? process.env.USERPROFILE ?? '',
    cwd: () => process.cwd(),
    env: process.env as Readonly<Record<string, string | undefined>>,
  };
}
