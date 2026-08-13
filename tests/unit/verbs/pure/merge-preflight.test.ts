/**
 * Tests for merge-preflight pure helpers.
 *
 * T04 scope: detectDrift clean-tree path only.
 * T05 extended coverage to dirty-tree, stale-index, and detached-HEAD cases.
 * T06 adds mergePreflight composer happy-path coverage.
 * T07 adds mergePreflight failure-path coverage — each guard driven to fail
 *     independently to prove `passed = false` and verbatim sub-field
 *     propagation from the underlying guard.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectDrift,
  mergePreflight,
  gatherPreflightDebug,
  type GitExec,
} from '../../../../src/verbs/pure/merge-preflight.js';

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

// ─── mergePreflight (T06) ───────────────────────────────────────────────────

describe('mergePreflight — happy path (T06)', () => {
  /**
   * Build a happy-path gitExec mock: ancestry passes, current branch is
   * `feat/x`, working tree is clean. Repo path is `/tmp/repo` so
   * assertMainWorktree (filesystem-only) treats it as a main worktree
   * (no `.claude/worktrees/` segment).
   */
  function makeHappyGitExec(): GitExec {
    return makeGitExec([
      // validateBranchAncestry: merge-base --is-ancestor target source
      // (preflight asserts target IS an ancestor of source — i.e., source is
      // up-to-date with target, so the merge is conflict-free.)
      {
        args: ['merge-base', '--is-ancestor', 'main', 'feat/x'],
        stdout: '',
        exitCode: 0,
      },
      // getCurrentBranch + detectDrift both call this
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'feat/x\n',
        exitCode: 0,
      },
      // detectDrift: clean working tree
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

    // Ancestry: passed=true, no missing list (validateBranchAncestry
    // returns `{ passed: true, checks: ['ancestry'] }` on success).
    expect(result.ancestry).toBeDefined();
    expect(result.ancestry.passed).toBe(true);

    // Current-branch protection: feat/x is not protected.
    expect(result.currentBranchProtection).toBeDefined();
    expect(result.currentBranchProtection.blocked).toBe(false);

    // Worktree: /tmp/repo has no .claude/worktrees/ segment → main.
    expect(result.worktree).toBeDefined();
    expect(result.worktree.isMain).toBe(true);
    expect(result.worktree.actual).toBe('/tmp/repo');

    // Drift: clean working tree, no uncommitted files, index in sync, on a named branch.
    expect(result.drift).toBeDefined();
    expect(result.drift.clean).toBe(true);
    expect(result.drift.uncommittedFiles).toEqual([]);
    expect(result.drift.indexStale).toBe(false);
    expect(result.drift.detachedHead).toBe(false);
  });
});

// ─── mergePreflight failure paths (T07) ─────────────────────────────────────

describe('mergePreflight — failure paths (T07)', () => {
  it('mergePreflight_AncestryMissing_PassedFalseAndAncestryReasonAncestry', async () => {
    // Drive ancestry to fail: `merge-base --is-ancestor` returns exit 1,
    // which the adapter surfaces as `Error & { status: 1 }`, which
    // validateBranchAncestry classifies as ancestry-missing.
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
    // Verbatim sub-field copy from validateBranchAncestry's failure shape.
    expect(result.ancestry.passed).toBe(false);
    expect(result.ancestry.reason).toBe('ancestry');
    // Missing entry is `main` because the preflight asserts target IS an
    // ancestor of source — when it isn't, the missing list names the target.
    expect(result.ancestry.missing).toEqual(['main']);
    expect(result.ancestry.blocked).toBe(true);
  });

  it('mergePreflight_OnProtectedBranch_PassedFalseAndProtectionBlocked', async () => {
    // Drive current-branch protection to fail: HEAD is on `main`.
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
    // Drive worktree assertion to fail: cwd contains `.claude/worktrees/`.
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

  it('mergePreflight_AncestryFails_MessageIncludesRebaseInstructionAndRunbookLink', async () => {
    // T-15 / DR-6: when ancestry fails (source branch is not a descendant of
    // target), the preflight must surface a remediation hint that
    // (a) instructs the operator to run `git rebase`, and
    // (b) links to the runbook section
    //     `content/delivery/skills/delegate/SKILL.md#when-integration-advances-mid-wave`
    //     so the operator can find the manual rebase + rollback procedure
    //     without consulting external docs.
    //
    // Auto-rebase is explicitly deferred to #1119; this test asserts the
    // human-facing message only.
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

    // Remediation hint MUST be populated on ancestry failures.
    expect(result.ancestry.hint).toBeDefined();
    const hint = result.ancestry.hint!;

    // (a) Manual remediation command must be discoverable verbatim.
    expect(hint).toContain('git rebase');
    // The hint should name the actual target branch so the operator can
    // copy-paste without resolving placeholders.
    expect(hint).toContain('main');

    // (b) Link to the runbook section. The anchor must match the heading
    // added to content/delivery/skills/delegate/SKILL.md (## When integration advances
    // mid-wave → #when-integration-advances-mid-wave).
    expect(hint).toContain(
      'content/delivery/skills/delegate/SKILL.md#when-integration-advances-mid-wave',
    );
  });

  it('mergePreflight_DirtyTree_PassedFalseAndDriftFieldPopulated', async () => {
    // Drive drift to fail: `git status --porcelain` reports dirty files.
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

// ─── gatherPreflightDebug (#1362 phase 1) ───────────────────────────────────
//
// Phase-1 Windows preflight instrumentation. The helper is pure: every git
// invocation goes through the injected `gitExec`. Fail-closed semantics —
// individual git failures must NOT throw; the helper records a partial
// payload so the on-failure debug attachment is best-effort. See plan T2.2.

describe('gatherPreflightDebug (#1362)', () => {
  it('gatherPreflightDebug_AllGitCallsSucceed_PopulatesAllFields', () => {
    // Build a mock that returns canned outputs for every git invocation the
    // helper should make. Field order in the type is the canonical reading
    // order for an operator inspecting the debug block.
    const gitExec = makeGitExec([
      { args: ['--version'], stdout: 'git version 2.45.1\n', exitCode: 0 },
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n', exitCode: 0 },
      {
        args: ['worktree', 'list', '--porcelain'],
        stdout: 'worktree /repo\nHEAD aaaaaaa\nbranch refs/heads/main\n',
        exitCode: 0,
      },
      // refs lookups: source + target. Use `for-each-ref` so we capture both
      // SHA and whether the ref is packed in one go.
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
      // packed-refs check via `cat-file -e <packed-ref>` or by `git
      // packed-refs --print`. We use `packed-refs` lookup via grep-free
      // mechanism: `git rev-parse --symbolic-full-name --verify
      // refs/heads/X` doesn't tell us packed state. The implementation uses
      // `git for-each-ref --format=%(packed)` semantics — but for simplicity
      // the helper just calls `cat-file -e <sha>` per ref. Mock stubs match
      // the implementation's actual call order below.
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
      // merge-base --is-ancestor invocation — the same call that the
      // ancestry guard ran. We re-run it here to capture stderr / exit code
      // verbatim for the debug block.
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

  it('gatherPreflightDebug_GitVersionFails_ReturnsPartialBlock', () => {
    // Drive the very first git call (--version) to fail. The helper must
    // record an empty/default value for that field and continue — never
    // throw. This is the fail-closed contract: an instrumentation helper
    // that throws inside an already-failed preflight would mask the real
    // failure.
    const gitExec: GitExec = (_root, args) => {
      if (args[0] === '--version') {
        return { stdout: '', exitCode: 127 };
      }
      // Stubs for the remaining calls so the test does not throw on
      // unexpected invocations.
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
    // Subsequent fields must still be populated from their successful calls.
    expect(debug!.repoRoot).toBe('/repo');
  });
});

// ─── mergePreflight env-var integration (#1362 phase 1) ─────────────────────

describe('mergePreflight env-gated debug attachment (#1362)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Build a gitExec stub that drives ancestry to fail (exit 1 on
   * `merge-base --is-ancestor`) and stubs every other call mergePreflight
   * + gatherPreflightDebug make. */
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

  /** Same as above but ancestry passes. */
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
    // Failure-only gating: even with the debug env set, a passing ancestry
    // must NOT attach a debug block. DIM-8 sustainability — event-store
    // growth concern.
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
