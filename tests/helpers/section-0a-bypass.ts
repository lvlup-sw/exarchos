// A `gitExec` stub that turns off the sibling-worktree probe of the merge
// orchestrator.
//
// Before the injected preflight, `handleMergeOrchestrate` runs real git to
// learn if `targetBranch` is checked out in a sibling worktree. This
// repository keeps its worktrees under `.claude/worktrees/`, so `main` is
// checked out in a sibling directory. A test that merges to `main` then stops
// with `target-checked-out-elsewhere` before it reads its fixtures.
//
// The handler returns that failure and does not throw, so the test shows only
// a false flag or a spy with zero calls. The CI checkout has one worktree, so
// the same test passes there.
//
// Use this stub only in a test that does not drive `gitExec` in another way.
// A test of the rollback ladder needs a stub that answers real commands.

import type { GitExec } from '../../src/verbs/pure/execute-merge.js';

/** A `gitExec` that fails each call. The probe ends on a non-zero exit of `git worktree list`. */
export const BYPASS_SECTION_0A: GitExec = () => ({ exitCode: 1, stdout: '' });
