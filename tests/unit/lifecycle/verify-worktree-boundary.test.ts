import { describe, it, expect, vi } from 'vitest';
import {
  handleVerifyWorktreeBoundary,
  type VerifyWorktreeBoundaryDeps,
} from '../../../src/lifecycle/verify-worktree-boundary.js';

interface Recorder {
  out: string[];
  err: string[];
}

const WORKTREE = '/repo/.worktrees/agent-x';

/**
 * Builds the deps and a recorder. By default git reports `WORKTREE` as the toplevel of the cwd.
 * `realpath` is the identity, so the test reads no filesystem.
 */
function makeDeps(overrides: Partial<VerifyWorktreeBoundaryDeps> = {}): {
  deps: VerifyWorktreeBoundaryDeps;
  rec: Recorder;
} {
  const rec: Recorder = { out: [], err: [] };
  const deps: VerifyWorktreeBoundaryDeps = {
    gitToplevel: vi.fn(() => WORKTREE),
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

/** Exit code 0 allows the tool call and 2 denies it, per the PreToolUse block contract. */
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

  /** An absolute path into the parent repository is the escape that the guard exists to stop. */
  it('VerifyWorktreeBoundary_AbsoluteMainRepoPath_Denies', () => {
    const { deps, rec } = makeDeps();
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

  /** The worktree of another agent is out of bounds. This protects parallel dispatch. */
  it('VerifyWorktreeBoundary_SiblingWorktreePath_Denies', () => {
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

  /**
   * The JSON is valid but `file_path` has the wrong type. The guard must not throw a TypeError from
   * `path`. It allows the call and writes the reason to stderr.
   */
  it('VerifyWorktreeBoundary_NonStringFilePath_AllowsWithoutThrowing', () => {
    const { deps, rec } = makeDeps();
    let code: number | undefined;
    expect(() => {
      code = handleVerifyWorktreeBoundary(preToolUse({ file_path: 123 } as never), deps);
    }).not.toThrow();
    expect(code).toBe(0);
    expect(rec.err.length).toBeGreaterThan(0);
  });

  /**
   * The guard cannot decide on input that does not parse. It allows the call and writes to stderr,
   * so a format mismatch does not block every agent write.
   */
  it('VerifyWorktreeBoundary_MalformedJson_AllowsWithStderr', () => {
    const { deps, rec } = makeDeps();
    const code = handleVerifyWorktreeBoundary('not json{', deps);
    expect(code).toBe(0);
    expect(rec.err.length).toBeGreaterThan(0);
  });

  /** When no toplevel resolves, the cwd subtree is the boundary. */
  it('VerifyWorktreeBoundary_NoGitToplevel_ConfinesToCwd', () => {
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
