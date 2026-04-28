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
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.clean).toBe(true);
  });

  it('detectDrift_NoUncommittedFiles_EmptyList', () => {
    const gitExec = makeGitExec([
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.uncommittedFiles).toEqual([]);
  });
});
