/**
 * WriterDeps: the injected dependencies of each RuntimeConfigWriter. The fs,
 * home, cwd, and env are injected, so unit tests do not touch the disk.
 * `buildWriterDeps()` gives the real bindings. `makeStubWriterDeps()` gives
 * stubs whose fs methods throw, so a test that uses a method it did not
 * override fails.
 */

import { promises as nodeFs } from 'node:fs';

/** The filesystem methods for writers. They are async, so a test can use an in-memory map. */
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

/** Builds the real WriterDeps from node:fs and the process globals. */
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
