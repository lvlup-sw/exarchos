// ─── Neutralize the merge orchestrator's sibling-worktree probe ─────────────
//
// Before it reaches the injected preflight, `handleMergeOrchestrate` shells out
// to REAL git to ask whether `targetBranch` is checked out in a sibling
// worktree. That probe is correct in production and fatal to a unit test: this
// repository's own development layout keeps worktrees under
// `.claude/worktrees/`, so `main` genuinely IS checked out in a sibling
// directory, and every test that merges to `main` aborts with
// `target-checked-out-elsewhere` before its own fixtures are ever consulted.
//
// The symptom is easy to misread. The handler returns a well-formed failure
// rather than throwing, so the test reports `expected false to be true` or a spy
// called zero times, and the message that would explain it is inside a result
// nothing prints. It also passes on CI, whose checkout has exactly one worktree
// — which is how a whole class of these ended up recorded as an environment
// artifact rather than as the missing injection it is.
//
// A non-zero exit short-circuits the probe (`merge-orchestrate.ts`, section 0a),
// so a `gitExec` that fails every call makes the test deterministic regardless
// of the host repository's worktree topology.
//
// Use it ONLY where the test does not otherwise drive `gitExec`. A test that
// exercises the executor's rollback ladder needs a stub that answers real
// commands, not this one.

import type { GitExec } from '../../src/verbs/pure/execute-merge.js';

/**
 * A `gitExec` that fails every invocation, neutralizing the section-0a
 * sibling-worktree probe.
 */
export const BYPASS_SECTION_0A: GitExec = () => ({ exitCode: 1, stdout: '', stderr: '' });
