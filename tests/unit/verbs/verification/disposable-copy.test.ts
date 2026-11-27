/**
 * The disposable copy of the exact head of a real linked worktree, built from blobs that the constrained Git reader reads.
 *
 * @oracle-sources: ../../../../src/verbs/verification/disposable-copy.ts, real Git objects and the live checkout bytes
 */
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConstrainedGitReads, processObservationalGitPath } from '../../../../src/utils/git-tree.js';
import { withDisposableCopy, type DisposableCopySource } from '../../../../src/verbs/verification/disposable-copy.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from '../../../helpers/scoped-repository.js';

/** The budget of a case that builds a repository. */
const CASE_TIMEOUT_MS = 30_000;

let repo: ScopedRepository;
let worktree: string;

beforeEach(async () => {
  repo = await scopedRepository({ integrationBranch: 'integration', files: { '.gitignore': 'node_modules\n', 'src/value.txt': 'committed\n' } });
  worktree = await repo.worktreeFor('root', { 'tool.sh': '#!/bin/sh\nexit 0\n' });
});

afterEach(async () => {
  await rmrfAsync(repo.root);
});

/** The source of the copy: the observed head and the constrained reads of the worktree. */
async function sourceOf(): Promise<DisposableCopySource> {
  const gitPath = processObservationalGitPath();
  if (gitPath === undefined) throw new Error('No Git on PATH');
  const gitDir = (await execFileAsync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'])).trim();
  const head = (await execFileAsync('git', ['-C', worktree, 'rev-parse', 'HEAD'])).trim();
  const repository = await realpath((await execFileAsync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  return { checkout: worktree, gitDir, repository, head, reads: await createConstrainedGitReads(gitPath) };
}

/** The porcelain status of the worktree. */
async function status(): Promise<string> {
  return execFileAsync('git', ['-C', worktree, 'status', '--porcelain', '--ignored']);
}

describe('withDisposableCopy', () => {
  /** The copy holds the committed bytes of the head, not an uncommitted edit. */
  it('DisposableCopy_HoldsTheCommittedHead', async () => {
    const source = await sourceOf();
    await writeFile(join(worktree, 'src', 'value.txt'), 'uncommitted\n');
    const seen = await withDisposableCopy(source, async (copy) => ({
      copy,
      value: await readFile(join(copy, 'src', 'value.txt'), 'utf8'),
      tool: await readFile(join(copy, 'tool.sh'), 'utf8'),
    }));

    expect(seen).toMatchObject({ value: 'committed\n', tool: '#!/bin/sh\nexit 0\n' });
    expect(existsSync(seen.copy)).toBe(false);
  }, CASE_TIMEOUT_MS);

  /** A Git read in the copy sees the exact head. A Git write in the copy changes only its private directory, never the live refs or objects. */
  it('DisposableCopy_APrivateGitDirectory_ReadsTheHeadAndKeepsEachWritePrivate', async () => {
    const source = await sourceOf();
    const refsBefore = await execFileAsync('git', ['-C', worktree, 'for-each-ref']);
    const written = await withDisposableCopy(source, async (copy) => {
      const head = (await execFileAsync('git', ['-C', copy, 'rev-parse', 'HEAD'])).trim();
      const base = (await execFileAsync('git', ['-C', copy, 'cat-file', '-t', repo.baseCommit])).trim();
      await execFileAsync('git', ['-C', copy, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'private']);
      return { head, base, commit: (await execFileAsync('git', ['-C', copy, 'rev-parse', 'HEAD'])).trim() };
    });

    expect(written.head).toBe(source.head);
    expect(written.base).toBe('commit');
    expect(written.commit).not.toBe(source.head);
    await expect(execFileAsync('git', ['-C', worktree, 'cat-file', '-e', written.commit])).rejects.toThrow();
    expect(await execFileAsync('git', ['-C', worktree, 'for-each-ref'])).toBe(refsBefore);
    expect((await execFileAsync('git', ['-C', worktree, 'rev-parse', 'HEAD'])).trim()).toBe(source.head);
  }, CASE_TIMEOUT_MS);

  /** A write in the copy never reaches the live checkout, its bytes or its Git state. The copy links node_modules of the checkout. */
  it('DisposableCopy_AWriteInTheCopy_LeavesTheLiveCheckoutUnchanged', async () => {
    await mkdir(join(worktree, 'node_modules', '.bin'), { recursive: true });
    const source = await sourceOf();
    const before = await status();
    const value = await stat(join(worktree, 'src', 'value.txt'));
    const linked = await withDisposableCopy(source, async (copy) => {
      await writeFile(join(copy, 'src', 'value.txt'), 'generated\n');
      await writeFile(join(copy, 'generated.txt'), 'generated\n');
      return { link: (await lstat(join(copy, 'node_modules'))).isSymbolicLink(), target: await readlink(join(copy, 'node_modules')) };
    });

    expect(linked).toEqual({ link: true, target: await realpath(join(worktree, 'node_modules')) });
    expect(await readFile(join(worktree, 'src', 'value.txt'), 'utf8')).toBe('committed\n');
    expect((await stat(join(worktree, 'src', 'value.txt'))).mtimeMs).toBe(value.mtimeMs);
    expect(existsSync(join(worktree, 'generated.txt'))).toBe(false);
    expect(existsSync(join(worktree, 'node_modules', '.bin'))).toBe(true);
    expect(await status()).toBe(before);
  }, CASE_TIMEOUT_MS);

  /** A body that throws still deletes the copy. */
  it('DisposableCopy_ABodyThatThrows_StillDeletesTheCopy', async () => {
    let seen = '';
    await expect(withDisposableCopy(await sourceOf(), async (copy) => {
      seen = copy;
      throw new Error('body failed');
    })).rejects.toThrow('body failed');
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
  }, CASE_TIMEOUT_MS);

  /**
   * A body that throws, then a delete that fails, gives the body error first. The delete failure does not hide it.
   * A directory with no write bit blocks the delete. The root user ignores that bit, so the case does not run as root.
   */
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('DisposableCopy_ABodyErrorThenAFailedDelete_KeepsTheBodyErrorFirst', async () => {
    let locked = '';
    const failure = await withDisposableCopy(await sourceOf(), async (copy) => {
      locked = join(copy, 'locked');
      await mkdir(locked);
      await writeFile(join(locked, 'file.txt'), 'held\n');
      await chmod(locked, 0o555);
      throw new Error('body failed');
    }).catch((error: unknown) => error);
    try {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).message).toBe('body failed');
      expect(((failure as AggregateError).errors[0] as Error).message).toBe('body failed');
      expect((failure as AggregateError).errors).toHaveLength(2);
    } finally {
      await chmod(locked, 0o755);
      await rmrfAsync(join(locked, '..'));
    }
  }, CASE_TIMEOUT_MS);

  /** A head tree with a symbolic link refuses before any copy, because a link can leave the copy. */
  it('DisposableCopy_AHeadWithALink_Refuses', async () => {
    await execFileAsync('ln', ['-s', '/etc/hostname', join(worktree, 'outside-link')]);
    await execFileAsync('git', ['-C', worktree, 'add', 'outside-link']);
    await execFileAsync('git', ['-C', worktree, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'link']);
    await expect(withDisposableCopy(await sourceOf(), async () => 'ran')).rejects.toThrow('does not support');
  }, CASE_TIMEOUT_MS);
});
