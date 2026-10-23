/**
 * Tests for `isMainModule`, the main-module check of the build and guard scripts.
 * Each case builds real files in a temporary directory, because the check reads real paths.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isMainModule } from '../../../src/utils/main-module.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let root: string;

beforeEach(() => {
  root = makeTempDir('main-module-');
});

afterEach(async () => {
  await rmrfAsync(root);
});

/** Writes an empty script at `dir/name` and returns its path. */
function script(dir: string, name = 'entry.mjs'): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '');
  return file;
}

describe('isMainModule', () => {
  /** The module URL and `argv[1]` name the same file. */
  it('IsMainModule_SameFile_ReturnsTrue', () => {
    const file = script(root);
    expect(isMainModule(pathToFileURL(file).href, file)).toBe(true);
  });

  /** A raw `file://` string of this path does not match its URL, which encodes the space. */
  it('IsMainModule_PathWithSpace_ReturnsTrue', () => {
    const file = script(join(root, 'dir with space'));
    expect(isMainModule(pathToFileURL(file).href, file)).toBe(true);
  });

  /** Node gives the module the real path, and `argv[1]` keeps the path through the link. */
  it('IsMainModule_ThroughSymlink_ReturnsTrue', () => {
    const realDir = join(root, 'real');
    const file = script(realDir);
    const linkDir = join(root, 'link');
    symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    expect(isMainModule(pathToFileURL(file).href, join(linkDir, 'entry.mjs'))).toBe(true);
  });

  /** A different script is not the main module. */
  it('IsMainModule_OtherFile_ReturnsFalse', () => {
    const file = script(root);
    const other = script(root, 'other.mjs');
    expect(isMainModule(pathToFileURL(file).href, other)).toBe(false);
  });

  /** A path that does not resolve gives false, not an exception. */
  it('IsMainModule_UnresolvablePath_ReturnsFalse', () => {
    const file = script(root);
    expect(isMainModule(pathToFileURL(file).href, join(root, 'missing.mjs'))).toBe(false);
  });

  /** With no `argv[1]`, as under a REPL, nothing is the main module. */
  it('IsMainModule_NoArgv_ReturnsFalse', () => {
    const file = script(root);
    expect(isMainModule(pathToFileURL(file).href, undefined)).toBe(false);
  });
});
