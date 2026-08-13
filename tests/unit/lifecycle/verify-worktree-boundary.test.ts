import { describe, it, expect, vi } from 'vitest';
import {
  handleVerifyWorktreeBoundary,
  type VerifyWorktreeBoundaryDeps,
} from '../../../src/lifecycle/verify-worktree-boundary.js';

// ─── Test utilities ──────────────────────────────────────────────────────────

interface Recorder {
  out: string[];
  err: string[];
}

const WORKTREE = '/repo/.worktrees/agent-x';

function makeDeps(overrides: Partial<VerifyWorktreeBoundaryDeps> = {}): {
  deps: VerifyWorktreeBoundaryDeps;
  rec: Recorder;
} {
  const rec: Recorder = { out: [], err: [] };
  const deps: VerifyWorktreeBoundaryDeps = {
    // Default: cwd is a real linked worktree whose toplevel is the worktree.
    gitToplevel: vi.fn(() => WORKTREE),
    // Identity realpath keeps the unit test free of the filesystem.
    realpath: vi.fn((p: string) => p),
    stdout: vi.fn((s: string) => {
      rec.out.push(s);
    }),
    stderr: vi.fn((s: string) => {
      rec.err.push(s);
    }),
    ...overrides,
  };
  return { deps, rec };
}

function preToolUse(
  toolInput: Record<string, unknown>,
  toolName = 'Edit',
  cwd = WORKTREE,
): string {
  return JSON.stringify({ cwd, tool_name: toolName, tool_input: toolInput });
}

// 0 = allow, 2 = deny (PreToolUse block contract).
describe('handleVerifyWorktreeBoundary', () => {
  it('VerifyWorktreeBoundary_RelativePathInsideWorktree_Allows', () => {
    const { deps } = makeDeps();
    const code = handleVerifyWorktreeBoundary(
      preToolUse({ file_path: 'src/foo.ts' }),
      deps,
    );
    expect(code).toBe(0);
  });

  it('VerifyWorktreeBoundary_AbsolutePathInsideWorktree_Allows', () => {
    const { deps } = makeDeps();
    const code = handleVerifyWorktreeBoundary(
      preToolUse({ file_path: `${WORKTREE}/servers/foo.ts` }),
      deps,
    );
    expect(code).toBe(0);
  });

  it('VerifyWorktreeBoundary_AbsoluteMainRepoPath_Denies', () => {
    const { deps, rec } = makeDeps();
    // The #1301 vector: an absolute path into the parent (main) repo.
    const code = handleVerifyWorktreeBoundary(
      preToolUse({ file_path: '/repo/src/foo.ts' }),
      deps,
    );
    expect(code).toBe(2);
    expect(rec.err.join('\n')).toMatch(/worktree|boundary|outside/i);
  });

  it('VerifyWorktreeBoundary_DotDotEscape_Denies', () => {
    const { deps } = makeDeps();
    const code = handleVerifyWorktreeBoundary(
      preToolUse({ file_path: '../../servers/foo.ts' }),
      deps,
    );
    expect(code).toBe(2);
  });

  it('VerifyWorktreeBoundary_SiblingWorktreePath_Denies', () => {
    // Parallel-dispatch protection: another agent's worktree is out of bounds.
    const { deps } = makeDeps();
    const code = handleVerifyWorktreeBoundary(
      preToolUse({ file_path: '/repo/.worktrees/agent-other/foo.ts' }),
      deps,
    );
    expect(code).toBe(2);
  });

  it('VerifyWorktreeBoundary_NotebookPath_Guarded', () => {
    const { deps } = makeDeps();
    const code = handleVerifyWorktreeBoundary(
      preToolUse({ notebook_path: '/repo/analysis.ipynb' }, 'NotebookEdit'),
      deps,
    );
    expect(code).toBe(2);
  });

  it('VerifyWorktreeBoundary_NoFilePath_Allows', () => {
    const { deps } = makeDeps();
    const code = handleVerifyWorktreeBoundary(preToolUse({ pattern: 'foo' }, 'Grep'), deps);
    expect(code).toBe(0);
  });

  it('VerifyWorktreeBoundary_NonStringFilePath_AllowsWithoutThrowing', () => {
    // Valid JSON, wrong-typed path field — must not throw a TypeError from
    // path.*; treated as a shape mismatch → allow + stderr (fail-open).
    const { deps, rec } = makeDeps();
    let code: number | undefined;
    expect(() => {
      code = handleVerifyWorktreeBoundary(preToolUse({ file_path: 123 } as never), deps);
    }).not.toThrow();
    expect(code).toBe(0);
    expect(rec.err.length).toBeGreaterThan(0);
  });

  it('VerifyWorktreeBoundary_MalformedJson_AllowsWithStderr', () => {
    // Cannot make a boundary decision on unparseable input — allow, but surface
    // it (never silent). A format mismatch must not brick every agent write.
    const { deps, rec } = makeDeps();
    const code = handleVerifyWorktreeBoundary('not json{', deps);
    expect(code).toBe(0);
    expect(rec.err.length).toBeGreaterThan(0);
  });

  it('VerifyWorktreeBoundary_NoGitToplevel_ConfinesToCwd', () => {
    // No resolvable worktree toplevel → confine to cwd subtree as the boundary.
    const insideDeps = makeDeps({ gitToplevel: () => null });
    expect(
      handleVerifyWorktreeBoundary(
        preToolUse({ file_path: 'src/foo.ts' }, 'Write', '/repo/.worktrees/agent-x'),
        insideDeps.deps,
      ),
    ).toBe(0);

    const outsideDeps = makeDeps({ gitToplevel: () => null });
    expect(
      handleVerifyWorktreeBoundary(
        preToolUse({ file_path: '/repo/src/foo.ts' }, 'Write', '/repo/.worktrees/agent-x'),
        outsideDeps.deps,
      ),
    ).toBe(2);
  });
});
