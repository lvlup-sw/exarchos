/**
 * @fileoverview Tests for the git helpers that compare the working tree with a base branch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitBaseError, diffFromRef, readAtRef, resolveBase, revParse, trackedFiles } from '../../../tools/audit/lib/git-base.mjs';

let repo = '';

/** Run git in the scratch repository. */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-base-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'keep\n');
  fs.writeFileSync(path.join(repo, 'move.txt'), 'a file with enough text to be detected as a rename\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('tag', 'base');
  git('mv', 'move.txt', 'moved.txt');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  git('add', '.');
});

describe('readAtRef', () => {
  it('ReadAtRef_ExistingAndMissingPaths_ReturnsTextOrUndefined', () => {
    const files = readAtRef('base', ['keep.txt', 'new.txt'], repo);

    expect(files.get('keep.txt')).toBe('keep\n');
    expect(files.get('new.txt')).toBeUndefined();
  });

  it('ReadAtRef_NoPaths_ReturnsAnEmptyMap', () => {
    expect(readAtRef('base', [], repo).size).toBe(0);
  });
});

describe('diffFromRef', () => {
  it('DiffFromRef_RenameAndAdd_AreReported', () => {
    const { renamedFrom, added } = diffFromRef('base', repo);

    expect(renamedFrom.get('moved.txt')).toBe('move.txt');
    expect([...added]).toEqual(['new.txt']);
  });
});

describe('resolveBase', () => {
  it('ResolveBase_ExplicitRef_WinsAndMustExist', () => {
    expect(resolveBase({ cwd: repo, env: {}, explicit: 'base' })).toEqual({ ref: 'base', mode: 'explicit' });
    expect(() => resolveBase({ cwd: repo, env: {}, explicit: 'no-such-ref' })).toThrow(GitBaseError);
  });

  it('ResolveBase_PullRequestWithoutBaseRef_FailsClosed', () => {
    expect(() => resolveBase({ cwd: repo, env: { GITHUB_EVENT_NAME: 'pull_request' } })).toThrow(/GITHUB_BASE_REF is not set/);
  });

  it('ResolveBase_PushRun_SkipsWithAReason', () => {
    const resolved = resolveBase({ cwd: repo, env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' } });

    expect(resolved.ref).toBeUndefined();
    expect(resolved.mode).toBe('push');
  });

  it('ResolveBase_LocalWithoutOriginMain_SkipsWithAReason', () => {
    expect(resolveBase({ cwd: repo, env: {} })).toMatchObject({ ref: undefined, mode: 'none' });
  });
});

describe('small helpers', () => {
  it('RevParse_KnownAndUnknownRefs', () => {
    expect(revParse('base', repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(revParse('nope', repo)).toBeUndefined();
  });

  it('TrackedFiles_ListsTheIndex', () => {
    expect(trackedFiles(repo).sort()).toEqual(['keep.txt', 'moved.txt', 'new.txt']);
  });
});
