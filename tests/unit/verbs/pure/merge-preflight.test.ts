/**
 * Tests for the merge-preflight pure helpers: `detectDrift`, the `mergePreflight`
 * composer, and `gatherPreflightDebug`. Each failure test drives one guard to
 * fail and checks that its sub-result reaches the composed result.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectDrift,
  mergePreflight,
  gatherPreflightDebug,
  type GitExec,
} from '../../../../src/verbs/pure/merge-preflight.js';

/**
 * Build a mock `GitExec` that returns canned results for matching argument
 * lists. An unmatched call throws, so a test fails when the code runs a git
 * command that the test did not stub.
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

/**
 * The happy-path mock: the target branch is an ancestor of the source, the
 * current branch is `feat/x`, and the tree is clean. `/tmp/repo` has no
 * `.claude/worktrees/` segment, so the worktree check sees a main worktree.
 */
describe('mergePreflight — happy path (T06)', () => {
  function makeHappyGitExec(): GitExec {
    return makeGitExec([
      {
        args: ['merge-base', '--is-ancestor', 'main', 'feat/x'],
        stdout: '',
        exitCode: 0,
      },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'feat/x\n',
        exitCode: 0,
      },
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
    ]);
  }

  it('mergePreflight_AllGuardsPassAndCleanTree_ReturnsPassedTrue', async () => {
    const gitExec = makeHappyGitExec();

    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec,
      cwd: '/tmp/repo',
    });

    expect(result.passed).toBe(true);
  });

  it('mergePreflight_PopulatesAllFourSubResults_StructurePreserved', async () => {
    const gitExec = makeHappyGitExec();

    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec,
      cwd: '/tmp/repo',
    });

    expect(result.ancestry).toBeDefined();
    expect(result.ancestry.passed).toBe(true);

    expect(result.currentBranchProtection).toBeDefined();
    expect(result.currentBranchProtection.blocked).toBe(false);

    expect(result.worktree).toBeDefined();
    expect(result.worktree.isMain).toBe(true);
    expect(result.worktree.actual).toBe('/tmp/repo');

    expect(result.drift).toBeDefined();
    expect(result.drift.clean).toBe(true);
    expect(result.drift.uncommittedFiles).toEqual([]);
    expect(result.drift.indexStale).toBe(false);
    expect(result.drift.detachedHead).toBe(false);
  });
});

describe('mergePreflight — failure paths (T07)', () => {
  /**
   * `merge-base --is-ancestor` exits 1, which `validateBranchAncestry` classifies
   * as missing ancestry. The missing list names the target, because the
   * preflight checks that the target is an ancestor of the source.
   */
  it('mergePreflight_AncestryMissing_PassedFalseAndAncestryReasonAncestry', async () => {
    const gitExec = makeGitExec([
      {
        args: ['merge-base', '--is-ancestor', 'main', 'feat/x'],
        stdout: '',
        exitCode: 1,
      },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'feat/x\n',
        exitCode: 0,
      },
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
    ]);

    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec,
      cwd: '/tmp/repo',
    });

    expect(result.passed).toBe(false);
    expect(result.ancestry.passed).toBe(false);
    expect(result.ancestry.reason).toBe('ancestry');
    expect(result.ancestry.missing).toEqual(['main']);
    expect(result.ancestry.blocked).toBe(true);
  });

  it('mergePreflight_OnProtectedBranch_PassedFalseAndProtectionBlocked', async () => {
    const gitExec = makeGitExec([
      {
        args: ['merge-base', '--is-ancestor', 'main', 'feat/x'],
        stdout: '',
        exitCode: 0,
      },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'main\n',
        exitCode: 0,
      },
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
    ]);

    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec,
      cwd: '/tmp/repo',
    });

    expect(result.passed).toBe(false);
    expect(result.currentBranchProtection.blocked).toBe(true);
    expect(result.currentBranchProtection.reason).toBe('current-branch-protected');
    expect(result.currentBranchProtection.currentBranch).toBe('main');
  });

  it('mergePreflight_FromSubagentWorktree_PassedFalseAndWorktreeNotMain', async () => {
    const gitExec = makeGitExec([
      {
        args: ['merge-base', '--is-ancestor', 'main', 'feat/x'],
        stdout: '',
        exitCode: 0,
      },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'feat/x\n',
        exitCode: 0,
      },
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
    ]);

    const subagentCwd = '/repo/.claude/worktrees/agent-abc';
    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec,
      cwd: subagentCwd,
    });

    expect(result.passed).toBe(false);
    expect(result.worktree.isMain).toBe(false);
    expect(result.worktree.actual).toBe(subagentCwd);
  });

  /**
   * When ancestry fails, the hint names `git rebase` with the target branch and
   * links to the delegate runbook section for integration that advances mid-wave.
   * The test checks only the message.
   */
  it('mergePreflight_AncestryFails_MessageIncludesRebaseInstructionAndRunbookLink', async () => {
    const gitExec = makeGitExec([
      {
        args: ['merge-base', '--is-ancestor', 'main', 'feat/x'],
        stdout: '',
        exitCode: 1,
      },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'feat/x\n',
        exitCode: 0,
      },
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
    ]);

    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec,
      cwd: '/tmp/repo',
    });

    expect(result.passed).toBe(false);
    expect(result.ancestry.passed).toBe(false);
    expect(result.ancestry.reason).toBe('ancestry');

    expect(result.ancestry.hint).toBeDefined();
    const hint = result.ancestry.hint!;

    expect(hint).toContain('git rebase');
    expect(hint).toContain('main');

    expect(hint).toContain(
      'content/delivery/skills/delegate/SKILL.md#when-integration-advances-mid-wave',
    );
  });

  it('mergePreflight_DirtyTree_PassedFalseAndDriftFieldPopulated', async () => {
    const gitExec = makeGitExec([
      {
        args: ['merge-base', '--is-ancestor', 'main', 'feat/x'],
        stdout: '',
        exitCode: 0,
      },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'feat/x\n',
        exitCode: 0,
      },
      {
        args: ['status', '--porcelain'],
        stdout: ' M src/foo.ts\n?? src/bar.ts\n',
        exitCode: 0,
      },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
    ]);

    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec,
      cwd: '/tmp/repo',
    });

    expect(result.passed).toBe(false);
    expect(result.drift.clean).toBe(false);
    expect(result.drift.uncommittedFiles.length).toBeGreaterThan(0);
    expect(result.drift.uncommittedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
  });
});

/**
 * `gatherPreflightDebug` sends every git call through the injected `gitExec`. A
 * failed git call does not throw. The helper records a partial payload, so the
 * debug attachment is best effort.
 */
describe('gatherPreflightDebug (#1362)', () => {
  /** The helper runs `merge-base --is-ancestor` again to record its exit code and output. */
  it('gatherPreflightDebug_AllGitCallsSucceed_PopulatesAllFields', () => {
    const gitExec = makeGitExec([
      { args: ['--version'], stdout: 'git version 2.45.1\n', exitCode: 0 },
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n', exitCode: 0 },
      {
        args: ['worktree', 'list', '--porcelain'],
        stdout: 'worktree /repo\nHEAD aaaaaaa\nbranch refs/heads/main\n',
        exitCode: 0,
      },
      {
        args: [
          'for-each-ref',
          '--format=%(objectname) %(if)%(refname)%(then)%(refname)%(end)',
          'refs/heads/feat/x',
        ],
        stdout: 'aaaaaaa refs/heads/feat/x\n',
        exitCode: 0,
      },
      {
        args: [
          'for-each-ref',
          '--format=%(objectname) %(if)%(refname)%(then)%(refname)%(end)',
          'refs/heads/main',
        ],
        stdout: 'bbbbbbb refs/heads/main\n',
        exitCode: 0,
      },
      {
        args: ['cat-file', '-e', 'aaaaaaa'],
        stdout: '',
        exitCode: 0,
      },
      {
        args: ['cat-file', '-e', 'bbbbbbb'],
        stdout: '',
        exitCode: 0,
      },
      {
        args: ['merge-base', '--is-ancestor', 'main', 'feat/x'],
        stdout: '',
        exitCode: 1,
      },
    ]);

    const debug = gatherPreflightDebug(gitExec, '/repo', 'feat/x', 'main');

    expect(debug.gitVersion).toBe('git version 2.45.1');
    expect(debug.repoRoot).toBe('/repo');
    expect(debug.worktreeList).toContain('worktree /repo');
    expect(debug.refsHeadsSource.sha).toBe('aaaaaaa');
    expect(debug.refsHeadsTarget.sha).toBe('bbbbbbb');
    expect(debug.refsHeadsSource.packed).toBe(false);
    expect(debug.refsHeadsTarget.packed).toBe(false);
    expect(debug.mergeBaseCommand).toEqual([
      'git',
      'merge-base',
      '--is-ancestor',
      'main',
      'feat/x',
    ]);
    expect(debug.mergeBaseExitCode).toBe(1);
    expect(typeof debug.mergeBaseStdout).toBe('string');
    expect(typeof debug.mergeBaseStderr).toBe('string');
  });

  /**
   * A failed first call (`--version`) leaves that field empty, and the helper
   * continues. A throw inside a failed preflight hides the real failure.
   */
  it('gatherPreflightDebug_GitVersionFails_ReturnsPartialBlock', () => {
    const gitExec: GitExec = (_root, args) => {
      if (args[0] === '--version') {
        return { stdout: '', exitCode: 127 };
      }
      if (args[0] === 'rev-parse') return { stdout: '/repo\n', exitCode: 0 };
      if (args[0] === 'worktree') return { stdout: '', exitCode: 0 };
      if (args[0] === 'for-each-ref') return { stdout: 'sha refs/heads/x\n', exitCode: 0 };
      if (args[0] === 'cat-file') return { stdout: '', exitCode: 0 };
      if (args[0] === 'merge-base') return { stdout: '', exitCode: 0 };
      return { stdout: '', exitCode: 1 };
    };

    let debug: ReturnType<typeof gatherPreflightDebug>;
    expect(() => {
      debug = gatherPreflightDebug(gitExec, '/repo', 'feat/x', 'main');
    }).not.toThrow();

    expect(debug!.gitVersion).toBe('');
    expect(debug!.repoRoot).toBe('/repo');
  });
});

/**
 * With `EXARCHOS_PREFLIGHT_DEBUG` set, `mergePreflight` attaches a debug block
 * only when ancestry fails. The exec stubs answer every call that
 * `mergePreflight` and `gatherPreflightDebug` make.
 */
describe('mergePreflight env-gated debug attachment (#1362)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeAncestryFailingExec(): GitExec {
    return (_root, args) => {
      const a = args.join(' ');
      if (a === 'merge-base --is-ancestor main feat/x') {
        return { stdout: '', exitCode: 1 };
      }
      if (a === 'rev-parse --abbrev-ref HEAD') {
        return { stdout: 'feat/x\n', exitCode: 0 };
      }
      if (a === 'status --porcelain') return { stdout: '', exitCode: 0 };
      if (a === 'diff --cached --quiet') return { stdout: '', exitCode: 0 };
      if (a === '--version') return { stdout: 'git version 2.45.1\n', exitCode: 0 };
      if (a === 'rev-parse --show-toplevel') return { stdout: '/repo\n', exitCode: 0 };
      if (a === 'worktree list --porcelain') return { stdout: '', exitCode: 0 };
      if (args[0] === 'for-each-ref') {
        return { stdout: 'sha refs/heads/x\n', exitCode: 0 };
      }
      if (args[0] === 'cat-file') return { stdout: '', exitCode: 0 };
      throw new Error(`Unexpected gitExec call: git ${a}`);
    };
  }

  function makeAncestryPassingExec(): GitExec {
    return (_root, args) => {
      const a = args.join(' ');
      if (a === 'merge-base --is-ancestor main feat/x') {
        return { stdout: '', exitCode: 0 };
      }
      if (a === 'rev-parse --abbrev-ref HEAD') {
        return { stdout: 'feat/x\n', exitCode: 0 };
      }
      if (a === 'status --porcelain') return { stdout: '', exitCode: 0 };
      if (a === 'diff --cached --quiet') return { stdout: '', exitCode: 0 };
      if (a === '--version') return { stdout: 'git version 2.45.1\n', exitCode: 0 };
      if (a === 'rev-parse --show-toplevel') return { stdout: '/repo\n', exitCode: 0 };
      if (a === 'worktree list --porcelain') return { stdout: '', exitCode: 0 };
      if (args[0] === 'for-each-ref') {
        return { stdout: 'sha refs/heads/x\n', exitCode: 0 };
      }
      if (args[0] === 'cat-file') return { stdout: '', exitCode: 0 };
      throw new Error(`Unexpected gitExec call: git ${a}`);
    };
  }

  it('MergePreflight_EnvUnsetAndAncestryFail_NoDebugField', async () => {
    vi.stubEnv('EXARCHOS_PREFLIGHT_DEBUG', '');
    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec: makeAncestryFailingExec(),
      cwd: '/tmp/repo',
    });

    expect(result.ancestry.passed).toBe(false);
    expect((result as Record<string, unknown>).debug).toBeUndefined();
  });

  it('MergePreflight_EnvSetAndAncestryPass_NoDebugField', async () => {
    vi.stubEnv('EXARCHOS_PREFLIGHT_DEBUG', '1');
    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec: makeAncestryPassingExec(),
      cwd: '/tmp/repo',
    });

    expect(result.ancestry.passed).toBe(true);
    expect((result as Record<string, unknown>).debug).toBeUndefined();
  });

  it('MergePreflight_EnvSetAndAncestryFail_AttachesDebugBlock', async () => {
    vi.stubEnv('EXARCHOS_PREFLIGHT_DEBUG', '1');
    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec: makeAncestryFailingExec(),
      cwd: '/tmp/repo',
    });

    expect(result.ancestry.passed).toBe(false);
    const debug = (result as { debug?: Record<string, unknown> }).debug;
    expect(debug).toBeDefined();
    expect(debug!.gitVersion).toBe('git version 2.45.1');
    expect(debug!.repoRoot).toBe('/repo');
    expect(debug!.mergeBaseExitCode).toBe(1);
  });
});
