import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handleVerifyWorktreeBaseline } from './verify-worktree-baseline.js';

// Helper: package.json contents declaring a `test:run` script (required by the
// resolver's npm code path).
const NPM_PACKAGE_JSON = JSON.stringify({ scripts: { 'test:run': 'vitest run' } });

describe('handleVerifyWorktreeBaseline', () => {
  const stateDir = '/tmp/test-state';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('NodeProject_TestsPass_ReturnsPassedTrue', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    vi.mocked(execFileSync).mockReturnValue('Tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string; report: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Node.js');
    expect(data.testCommand).toBe('npm run test:run');
    expect(data.report).toContain('PASS');
  });

  it('DotNetProject_TestsPass_ReturnsPassedTrue', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue(['MyApp.csproj' as unknown as ReturnType<typeof readdirSync>[number]]);
    vi.mocked(execFileSync).mockReturnValue('All tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('.NET');
    expect(data.testCommand).toBe('dotnet test');
  });

  it('RustProject_TestsPass_ReturnsPassedTrue', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/Cargo.toml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(execFileSync).mockReturnValue('test result: ok\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Rust');
    expect(data.testCommand).toBe('cargo test');
  });

  it('UnknownProjectType_ReturnsError', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(execFileSync).mockReturnValue('');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'UNKNOWN_PROJECT_TYPE' });
  });

  it('TestsFail_ReturnsPassedFalse', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    const error = new Error('Process exited with code 1') as Error & {
      status: number;
      stdout: string;
      stderr: string;
    };
    error.status = 1;
    error.stdout = '3 tests failed';
    error.stderr = 'FAIL src/foo.test.ts';
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      // Allow git rev-parse to succeed
      if (String(cmd) === 'git') return '.git\n';
      throw error;
    });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; report: string };
    expect(data.passed).toBe(false);
    expect(data.projectType).toBe('Node.js');
    expect(data.report).toContain('FAIL');
  });

  it('PathDoesNotExist_ReturnsError', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/nonexistent' }, stateDir);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(result.error?.message).toContain('/nonexistent');
  });

  it('NotAGitWorktree_ReturnsError', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p) === '/not-git') return true;
      return false;
    });
    // git rev-parse --git-dir throws for non-git directories
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (String(cmd) === 'git' && Array.isArray(args) && args.includes('--git-dir')) {
        throw new Error('fatal: not a git repository');
      }
      return '';
    });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/not-git' }, stateDir);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'NOT_GIT_WORKTREE' });
  });

  // ── T08 additions: behavior changes from resolver migration ─────────────

  it('detectProjectType_PythonProject_ReturnsPytestNow', async () => {
    // Intentional gap closure: prior to T08 a Python project (pyproject.toml
    // only) returned UNKNOWN_PROJECT_TYPE. The unified resolver now detects
    // it and selects pytest.
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/pyproject.toml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(execFileSync).mockReturnValue('=== 5 passed in 0.42s ===\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    expect(data.projectType).toBe('Python');
    expect(data.testCommand).toBe('pytest');
    // Verify pytest was invoked with no args (cmd='pytest', args=[]).
    const calls = vi.mocked(execFileSync).mock.calls;
    const pytestCall = calls.find((c) => String(c[0]) === 'pytest');
    expect(pytestCall).toBeDefined();
    expect(pytestCall?.[1]).toEqual([]);
  });

  it('detectProjectType_BunProject_ReturnsBunTest', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      if (s === '/worktree/bun.lockb') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    // bun does not require scripts.test, but the resolver still reads package.json.
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return JSON.stringify({});
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    vi.mocked(execFileSync).mockReturnValue('bun test passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.projectType).toBe('Node.js (bun)');
    expect(data.testCommand).toBe('bun test');
    const calls = vi.mocked(execFileSync).mock.calls;
    const bunCall = calls.find((c) => String(c[0]) === 'bun');
    expect(bunCall?.[1]).toEqual(['test']);
  });

  // ── #1199 shepherd fix: honor config-sourced runtimes ──────────────────
  // Regression: prior to this fix `toProjectDetection` rejected any runtime
  // whose `source !== 'detection'`, which meant a `.exarchos.yml`-supplied
  // test command would surface as UNKNOWN_PROJECT_TYPE — breaking the very
  // Basileus-forward configuration path the resolver was added to enable.
  it('ConfigSourcedTestCommand_KnownRunner_HonoredByHandler', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      // No detection markers; the only signal comes from .exarchos.yml.
      if (s === '/worktree/.exarchos.yml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('.exarchos.yml')) {
        return 'test: pytest\n';
      }
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    vi.mocked(execFileSync).mockImplementation((cmd) => {
      if (String(cmd) === 'git') return '.git\n';
      return '=== 1 passed ===\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    // pytest is in the built-in label set, so the projectType is recognized.
    expect(data.projectType).toBe('Python');
    expect(data.testCommand).toBe('pytest');
  });

  it('ConfigSourcedTestCommand_UnknownRunner_GetsConfiguredLabel', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/.exarchos.yml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('.exarchos.yml')) {
        return 'test: make test\n';
      }
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    vi.mocked(execFileSync).mockImplementation((cmd) => {
      if (String(cmd) === 'git') return '.git\n';
      return 'Tests OK\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.passed).toBe(true);
    // `make test` isn't in the built-in label set, so we surface a
    // source-tagged fallback rather than UNKNOWN_PROJECT_TYPE.
    expect(data.projectType).toBe('Configured (.exarchos.yml)');
    expect(data.testCommand).toBe('make test');
  });

  // ── T-08 (#1301): merge-time leak backstop ──────────────────────────────
  // When the main worktree is dirty and a modified path's working-tree blob is
  // byte-identical to the same path already committed on the agent branch tip,
  // classify it as a recoverable `leaked-committed` leak (the #1301 mirroring
  // symptom) rather than as unrelated dirt. Surface a safe `git checkout --`
  // remediation; never auto-discard silently.
  it('VerifyWorktreeBaseline_LeakedEditByteIdenticalToCommittedAgentChange_IsDetected', async () => {
    const AGENT_BRANCH = 'feature/agent-task-123';
    const LEAKED_PATH = 'src/leaked.ts';
    // Identical bytes on both sides — this is the leak signature.
    const SHARED_BLOB = 'export const leaked = true;\n';

    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (String(cmd) === 'git') {
        // git -C /worktree rev-parse --git-dir
        if (a.includes('--git-dir')) return '.git\n' as unknown as Buffer;
        // git -C /worktree status --porcelain → one modified, tracked path
        if (a.includes('status') && a.includes('--porcelain')) {
          return ` M ${LEAKED_PATH}\n` as unknown as Buffer;
        }
        // git -C /worktree hash-object -- <path> → working-tree blob hash
        if (a.includes('hash-object')) {
          // Hash of the working-tree content.
          return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' as unknown as Buffer;
        }
        // git -C /worktree rev-parse <agentBranch>:<path> → committed blob hash
        if (a.includes('rev-parse') && a.some((x) => x.startsWith(AGENT_BRANCH))) {
          // Byte-identical content on the agent tip → same blob hash.
          return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' as unknown as Buffer;
        }
        return '' as unknown as Buffer;
      }
      // baseline test runner
      return 'Tests passed\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline(
      { worktreePath: '/worktree', agentBranch: AGENT_BRANCH },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      leakDetection?: {
        dirty: boolean;
        paths: { path: string; classification: string; remediation?: string }[];
      };
    };
    expect(data.leakDetection).toBeDefined();
    expect(data.leakDetection?.dirty).toBe(true);
    const entry = data.leakDetection?.paths.find((p) => p.path === LEAKED_PATH);
    expect(entry).toBeDefined();
    // Must classify as a recoverable, byte-identical-to-committed leak —
    // NOT a generic dirty/unrelated change, NOT a silent pass.
    expect(entry?.classification).toBe('leaked-committed');
    // Safe remediation must match the documented manual workaround, with the
    // path single-quoted to neutralize shell metacharacters in crafted names.
    expect(entry?.remediation).toContain(`git checkout -- '${LEAKED_PATH}'`);
  });

  it('VerifyWorktreeBaseline_RenamedLeak_ParsesNewPathNotRawArrow', async () => {
    // Porcelain renders a rename as "R  old -> new". The blob on disk lives at
    // `new`; the parser must extract it, not pass the raw "old -> new" string to
    // git hash-object (which is not a real file and silently fails detection).
    const AGENT_BRANCH = 'feature/agent-task-123';
    const OLD_PATH = 'src/old-name.ts';
    const NEW_PATH = 'src/renamed-leak.ts';

    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (String(cmd) === 'git') {
        if (a.includes('--git-dir')) return '.git\n' as unknown as Buffer;
        if (a.includes('status') && a.includes('--porcelain')) {
          return `R  ${OLD_PATH} -> ${NEW_PATH}\n` as unknown as Buffer;
        }
        // Only the NEW path resolves to the byte-identical blob. If the parser
        // leaked the raw "old -> new" string, hash-object would be invoked with
        // a non-file and this branch would never match → no leaked-committed.
        if (a.includes('hash-object') && a.includes(NEW_PATH)) {
          return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' as unknown as Buffer;
        }
        if (a.includes('rev-parse') && a.some((x) => x === `${AGENT_BRANCH}:${NEW_PATH}`)) {
          return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' as unknown as Buffer;
        }
        return '' as unknown as Buffer;
      }
      return 'Tests passed\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline(
      { worktreePath: '/worktree', agentBranch: AGENT_BRANCH },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      leakDetection?: { paths: { path: string; classification: string }[] };
    };
    const paths = data.leakDetection?.paths ?? [];
    // The parsed path is the post-rename name, never the raw arrow string.
    expect(paths.some((p) => p.path.includes(' -> '))).toBe(false);
    const entry = paths.find((p) => p.path === NEW_PATH);
    expect(entry).toBeDefined();
    expect(entry?.classification).toBe('leaked-committed');
  });

  it('VerifyWorktreeBaseline_UnrelatedDirtyTree_IsGenuineBlocker', async () => {
    const AGENT_BRANCH = 'feature/agent-task-123';
    const DIRTY_PATH = 'src/local-wip.ts';

    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return NPM_PACKAGE_JSON;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (String(cmd) === 'git') {
        if (a.includes('--git-dir')) return '.git\n' as unknown as Buffer;
        if (a.includes('status') && a.includes('--porcelain')) {
          return ` M ${DIRTY_PATH}\n` as unknown as Buffer;
        }
        if (a.includes('hash-object')) {
          return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' as unknown as Buffer;
        }
        if (a.includes('rev-parse') && a.some((x) => x.startsWith(AGENT_BRANCH))) {
          // Different blob on the agent tip → genuinely divergent local change.
          return 'cccccccccccccccccccccccccccccccccccccccc\n' as unknown as Buffer;
        }
        return '' as unknown as Buffer;
      }
      return 'Tests passed\n' as unknown as Buffer;
    });

    const result = await handleVerifyWorktreeBaseline(
      { worktreePath: '/worktree', agentBranch: AGENT_BRANCH },
      stateDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      leakDetection?: {
        dirty: boolean;
        paths: { path: string; classification: string }[];
      };
    };
    expect(data.leakDetection?.dirty).toBe(true);
    const entry = data.leakDetection?.paths.find((p) => p.path === DIRTY_PATH);
    expect(entry?.classification).toBe('dirty');
  });

  it('detectProjectType_PnpmProject_ReturnsPnpmTest', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === '/worktree') return true;
      if (s === '/worktree/package.json') return true;
      if (s === '/worktree/pnpm-lock.yaml') return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue([]);
    // pnpm path requires a `test` script in package.json.
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json'))
        return JSON.stringify({ scripts: { test: 'vitest run' } });
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });
    vi.mocked(execFileSync).mockReturnValue('pnpm tests passed\n');

    const result = await handleVerifyWorktreeBaseline({ worktreePath: '/worktree' }, stateDir);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; projectType: string; testCommand: string };
    expect(data.projectType).toBe('Node.js (pnpm)');
    expect(data.testCommand).toBe('pnpm test');
    const calls = vi.mocked(execFileSync).mock.calls;
    const pnpmCall = calls.find((c) => String(c[0]) === 'pnpm');
    expect(pnpmCall?.[1]).toEqual(['test']);
  });
});
