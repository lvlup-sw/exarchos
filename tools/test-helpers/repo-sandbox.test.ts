// Tests for the repo sandbox: copies are exact, writes stay in the sandbox,
// paths cannot escape it, a git sandbox starts clean, and removal runs the
// temp-dir leak check.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/storage/__shims__/bun-sqlite-node.js';
import { LIVE_CHECKOUT_ROOT, makeRepoSandbox } from './repo-sandbox.js';
import { LeakedHandleError, rmrf } from './temp-dir.js';

describe('repo-sandbox', () => {
  /** A copied file and directory match the live bytes, and the root is under the OS temp directory. */
  it('MakeRepoSandbox_CopiesLivePathsExactly_UnderTheTempDirectory', async () => {
    const sandbox = await makeRepoSandbox({ prefix: 'self-test', copy: ['package.json', 'tools/test-helpers'] });
    try {
      expect(sandbox.root.startsWith(realpathSync.native(os.tmpdir()))).toBe(true);
      expect(readFileSync(sandbox.path('package.json'))).toEqual(readFileSync(path.join(LIVE_CHECKOUT_ROOT, 'package.json')));
      expect(existsSync(sandbox.path('tools/test-helpers/repo-sandbox.ts'))).toBe(true);
    } finally {
      sandbox.remove();
    }
    expect(existsSync(sandbox.root)).toBe(false);
  });

  /** Writing to the copy leaves the live file as it was. */
  it('MakeRepoSandbox_WriteToCopy_LeavesTheLiveFileUnchanged', async () => {
    const live = readFileSync(path.join(LIVE_CHECKOUT_ROOT, 'package.json'));
    const sandbox = await makeRepoSandbox({ prefix: 'self-test', copy: ['package.json'], files: { 'src/probe.ts': 'x\n' } });
    try {
      sandbox.write('package.json', 'changed\n');

      expect(readFileSync(sandbox.path('package.json'), 'utf8')).toBe('changed\n');
      expect(readFileSync(sandbox.path('src/probe.ts'), 'utf8')).toBe('x\n');
      expect(readFileSync(path.join(LIVE_CHECKOUT_ROOT, 'package.json'))).toEqual(live);
      expect(existsSync(path.join(LIVE_CHECKOUT_ROOT, 'src', 'probe.ts'))).toBe(false);
    } finally {
      sandbox.remove();
    }
  });

  /** A path that is absolute or climbs out of the root is refused. */
  it('MakeRepoSandbox_EscapingPath_Throws', async () => {
    await expect(makeRepoSandbox({ prefix: 'self-test', copy: ['../outside'] })).rejects.toThrow(/outside the sandbox/);
    const sandbox = await makeRepoSandbox({ prefix: 'self-test' });
    try {
      expect(() => sandbox.write('../escape.txt', 'x')).toThrow(/outside the sandbox/);
      expect(() => sandbox.path(path.join(LIVE_CHECKOUT_ROOT, 'package.json'))).toThrow(/repo-relative/);
      expect(() => sandbox.path('')).toThrow(/repo-relative/);
    } finally {
      sandbox.remove();
    }
  });

  /** A git sandbox has one commit that holds every file and a clean working tree. */
  it('MakeRepoSandbox_Git_CommitsEveryFileAndStartsClean', async () => {
    const sandbox = await makeRepoSandbox({ prefix: 'self-test', files: { 'a/one.txt': '1\n', 'two.txt': '2\n' }, git: true });
    try {
      expect((await sandbox.git('ls-files')).trim().split('\n')).toEqual(['a/one.txt', 'two.txt']);
      expect(await sandbox.git('status', '--porcelain')).toBe('');
      const topLevel = (await sandbox.git('rev-parse', '--show-toplevel')).trim();
      expect(realpathSync.native(path.resolve(topLevel))).toBe(sandbox.root);
    } finally {
      sandbox.remove();
    }
  });

  /**
   * Removal goes through `rmrf` (#2027). A SQLite handle under the sandbox that
   * its close cannot release fails the removal, names the file, and the tree stays.
   */
  it('MakeRepoSandbox_RemoveWithAHeldHandle_FailsNamingTheFile', async () => {
    const sandbox = await makeRepoSandbox({ prefix: 'self-test' });
    const file = sandbox.path('held.db');
    const db = new Database(file);
    db.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1), (2);');
    const rows = db.prepare('SELECT v FROM t').iterate();
    rows.next();
    try {
      let thrown: unknown;
      try {
        sandbox.remove();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LeakedHandleError);
      expect(String(thrown)).toContain(file);
      expect(existsSync(file)).toBe(true);
    } finally {
      rows.return?.();
      db.close();
      rmrf(sandbox.root);
    }
  });
});
