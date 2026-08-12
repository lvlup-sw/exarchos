import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { handleVerifyWorktreeBoundary } from '../../lifecycle/verify-worktree-boundary.js';

/**
 * #1301 worktree-escape leak-shape regression pin (DR-4, WLM slice-3 task-013).
 *
 * #1301: an implementer agent's `Edit`/`Write` to an ABSOLUTE parent-repo path
 * resolves literally — ignoring the agent's isolated worktree cwd — and writes
 * byte-identically into the orchestrator's MAIN worktree (the "mirroring" leak).
 * The structural root-fix (merged #1568) is the boundary guard
 * `handleVerifyWorktreeBoundary`: it resolves the write target against the
 * agent's worktree root and DENIES (exit 2) anything that escapes it. Because
 * the guard is a runtime-agnostic `exarchos` verb (not a Claude-only harness
 * hook), the guarantee lives in the resolver/dispatch core — INV-4.
 *
 * WHY THIS FILE EXISTS (non-duplication): the existing unit suite
 * (`lifecycle/verify-worktree-boundary.test.ts`) pins the boundary DECISION
 * comprehensively, but by design STUBS both real seams — `gitToplevel` and
 * `realpath` — "so the unit tests never touch git or the filesystem". That
 * leaves the load-bearing property from the guard's own doc comment untested:
 * "a linked worktree reports its OWN toplevel, so the parent main repo is
 * correctly out of bounds". If `defaultGitToplevel` regressed to report the
 * MAIN repo's toplevel (e.g. a dropped `-C <cwd>`, or a git behavior change),
 * #1301 would silently re-open and EVERY stubbed unit test would still pass.
 *
 * This regression closes that gap end-to-end: it provisions a REAL linked git
 * worktree exactly as native isolation does (`git worktree add
 * <repoRoot>/.worktrees/agent-*`) and runs the guard with its DEFAULT deps —
 * the real `defaultGitToplevel` + `defaultRealpath` — asserting the #1301 leak
 * shape is BLOCKED at the boundary and legitimate in-worktree writes are
 * allowed. Only `stderr` is injected (to assert the deny reason); the git/fs
 * seams stay real.
 */

/** Run `git <args>` from `cwd`, returning trimmed stdout (throws on failure). */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Build a PreToolUse hook payload string, as Claude Code feeds on stdin. */
function preToolUse(
  toolInput: Record<string, unknown>,
  cwd: string,
  toolName = 'Edit',
): string {
  return JSON.stringify({ cwd, tool_name: toolName, tool_input: toolInput });
}

// PreToolUse block contract: 0 = allow, 2 = deny.
const ALLOW = 0;
const DENY = 2;

describe('WorktreeBoundaryGuard #1301 leak-shape regression (real linked worktree, real git seams)', () => {
  let repoRoot: string;
  let worktreePath: string; // <repoRoot>/.worktrees/agent-x — the agent's cwd
  let siblingPath: string; // <repoRoot>/.worktrees/agent-other — a parallel agent

  /** Invoke the guard with DEFAULT git/fs seams; only capture stderr. */
  function runGuard(stdin: string): { code: number; err: string } {
    const errLines: string[] = [];
    const code = handleVerifyWorktreeBoundary(stdin, {
      stderr: (s) => errLines.push(s),
    });
    return { code, err: errLines.join('\n') };
  }

  beforeEach(async () => {
    // realpathSync defeats the /tmp → /private/tmp (macOS) symlink so the
    // containment math is done in canonical space on both sides.
    repoRoot = realpathSync(await mkdtemp(path.join(tmpdir(), 'boundary-1301-')));
    git(repoRoot, ['init', '-q', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);
    // Seed a committed file so the MAIN worktree has a real counterpart for the
    // absolute-path leak to (attempt to) land in.
    await writeFile(path.join(repoRoot, 'src.txt'), 'baseline\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-q', '-m', 'baseline']);

    // Provision two linked worktrees under .worktrees/, exactly as native
    // isolation does. Each is a distinct git worktree with its OWN toplevel.
    worktreePath = path.join(repoRoot, '.worktrees', 'agent-x');
    siblingPath = path.join(repoRoot, '.worktrees', 'agent-other');
    git(repoRoot, ['worktree', 'add', '-q', worktreePath, '-b', 'agent-x']);
    git(repoRoot, ['worktree', 'add', '-q', siblingPath, '-b', 'agent-other']);
  });

  afterEach(async () => {
    await rmrfAsync(repoRoot);
  });

  // ── The #1301 leak shape: an absolute parent-repo write is BLOCKED ──────────

  it('WorktreeBoundary_AbsoluteMainRepoPath_DeniedThroughRealGitToplevel', () => {
    // The exact #1301 vector: an implementer writes an ABSOLUTE path into the
    // main (parent) worktree instead of a worktree-relative one. The real
    // `defaultGitToplevel` must resolve the agent cwd to the LINKED worktree's
    // own toplevel, leaving the parent repo out of bounds → deny.
    const { code, err } = runGuard(
      preToolUse({ file_path: path.join(repoRoot, 'src.txt') }, worktreePath),
    );
    expect(code).toBe(DENY);
    // Deny reason names the leak and cites #1301 (surfaced to the agent).
    expect(err).toMatch(/outside the isolated worktree/i);
    expect(err).toContain('#1301');
  });

  it('WorktreeBoundary_DotDotEscapeToMainRepo_Denied', () => {
    // A relative `..`-escape that climbs out of .worktrees/agent-x back to the
    // main repo root resolves to the SAME leaked file — also blocked.
    const { code } = runGuard(
      preToolUse({ file_path: '../../src.txt' }, worktreePath),
    );
    expect(code).toBe(DENY);
  });

  it('WorktreeBoundary_SiblingWorktreePath_Denied', () => {
    // Parallel-dispatch protection: a write into a PARALLEL agent's worktree
    // must not leak across the isolation boundary either.
    const { code } = runGuard(
      preToolUse(
        { file_path: path.join(siblingPath, 'src.txt') },
        worktreePath,
      ),
    );
    expect(code).toBe(DENY);
  });

  it('WorktreeBoundary_NotebookEditIntoMainRepo_Denied', () => {
    // The leak vector is identical for the notebook write tool.
    const { code } = runGuard(
      preToolUse(
        { notebook_path: path.join(repoRoot, 'analysis.ipynb') },
        worktreePath,
        'NotebookEdit',
      ),
    );
    expect(code).toBe(DENY);
  });

  // ── The other side of the boundary: legitimate in-worktree writes ALLOW ─────

  it('WorktreeBoundary_RelativePathInsideWorktree_Allowed', () => {
    const { code } = runGuard(
      preToolUse({ file_path: 'src.txt' }, worktreePath),
    );
    expect(code).toBe(ALLOW);
  });

  it('WorktreeBoundary_AbsolutePathInsideWorktree_Allowed', () => {
    const { code } = runGuard(
      preToolUse(
        { file_path: path.join(worktreePath, 'src.txt') },
        worktreePath,
      ),
    );
    expect(code).toBe(ALLOW);
  });

  it('WorktreeBoundary_NewNestedFileInsideWorktree_Allowed', () => {
    // A brand-new (not-yet-existing) nested path must still be allowed — this
    // exercises defaultRealpath's ENOENT-tail branch against a real filesystem,
    // where an identity-stub realpath would not.
    const { code } = runGuard(
      preToolUse(
        { file_path: path.join(worktreePath, 'sub', 'brand-new.ts') },
        worktreePath,
      ),
    );
    expect(code).toBe(ALLOW);
  });
});
