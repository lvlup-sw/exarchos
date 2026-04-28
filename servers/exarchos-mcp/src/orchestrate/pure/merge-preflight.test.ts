/**
 * Tests for merge-preflight pure helpers.
 *
 * T04 scope: detectDrift clean-tree path only.
 * T05 will extend coverage to dirty-tree, stale-index, and detached-HEAD cases.
 */

import { describe, it, expect } from 'vitest';
import { detectDrift, type GitExec } from './merge-preflight.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a mock GitExec that returns canned `{ stdout, exitCode }` results
 * for matching arg sequences. Unmatched calls throw so tests fail loudly
 * if the implementation reaches for git commands the test didn't stub.
 */
function makeGitExec(
  responses: ReadonlyArray<{
    args: readonly string[];
    stdout: string;
    exitCode?: number;
  }>,
): GitExec {
  return (_repoRoot, args) => {
    const match = responses.find(
      (r) =>
        r.args.length === args.length && r.args.every((a, i) => a === args[i]),
    );
    if (!match) {
      throw new Error(
        `Unexpected gitExec call: git ${args.join(' ')}`,
      );
    }
    return { stdout: match.stdout, exitCode: match.exitCode ?? 0 };
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('detectDrift — clean tree (T04)', () => {
  it('detectDrift_CleanTree_ReturnsCleanTrue', () => {
    const gitExec = makeGitExec([
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'main\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.clean).toBe(true);
  });

  it('detectDrift_NoUncommittedFiles_EmptyList', () => {
    const gitExec = makeGitExec([
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'main\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.uncommittedFiles).toEqual([]);
  });
});

describe('detectDrift — drift extensions (T05)', () => {
  it('detectDrift_UncommittedFiles_ListsThemAndCleanFalse', () => {
    const gitExec = makeGitExec([
      {
        args: ['status', '--porcelain'],
        stdout: ' M src/foo.ts\n?? src/bar.ts\n',
        exitCode: 0,
      },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'main\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.uncommittedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(result.clean).toBe(false);
  });

  it('detectDrift_StaleIndex_IndexStaleTrue', () => {
    const gitExec = makeGitExec([
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 1 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'main\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.indexStale).toBe(true);
    expect(result.clean).toBe(false);
  });

  it('detectDrift_DetachedHead_DetachedHeadTrue', () => {
    const gitExec = makeGitExec([
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'HEAD\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.detachedHead).toBe(true);
    expect(result.clean).toBe(false);
  });
});
