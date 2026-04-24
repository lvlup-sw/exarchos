import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkTddCompliance, type TddComplianceResult } from './tdd-compliance.js';

/**
 * Mock execFileSync for git commands. Each test provides a list
 * of { args, stdout } expectations the mock should resolve.
 */
type GitMock = { args: string[]; stdout: string };

function createGitMock(responses: GitMock[]): (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; encoding?: string }
) => string {
  return (_cmd: string, args: readonly string[]) => {
    for (const resp of responses) {
      // Match if the real args end with the expected args
      const argsStr = args.join(' ');
      const respStr = resp.args.join(' ');
      if (argsStr.includes(respStr)) {
        return resp.stdout;
      }
    }
    return '';
  };
}

describe('checkTddCompliance', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('compliant sequence (test before impl) returns pass', () => {
    // Two commits: first has test file, second has impl file
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\nbbb222\n',
      },
      // First commit: test file
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'test: add widget tests',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'src/widget.test.ts\n',
      },
      // Second commit: impl file
      {
        args: ['log', '-1', '--format=%s', 'bbb222'],
        stdout: 'feat: add widget',
      },
      {
        args: ['log', '-1', '--format=%h', 'bbb222'],
        stdout: 'bbb222',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'bbb222'],
        stdout: 'src/widget.ts\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/compliant',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('pass');
    expect(result.violations).toHaveLength(0);
    expect(result.commitsAnalyzed).toBe(2);
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
  });

  it('non-compliant (impl before test) returns fail', () => {
    // Two commits: first has impl file (no test), second has test file
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\nbbb222\n',
      },
      // First commit: impl file only
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'feat: add api',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'src/api.ts\n',
      },
      // Second commit: test file
      {
        args: ['log', '-1', '--format=%s', 'bbb222'],
        stdout: 'test: add api tests',
      },
      {
        args: ['log', '-1', '--format=%h', 'bbb222'],
        stdout: 'bbb222',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'bbb222'],
        stdout: 'src/api.test.ts\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/violating',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('fail');
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toContain('aaa111');
    expect(result.failCount).toBe(1);
  });

  it('mixed commit (test+impl together) returns pass', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\n',
      },
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'feat: add util with tests',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'src/util.test.ts\nsrc/util.ts\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/mixed',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('pass');
    expect(result.violations).toHaveLength(0);
    expect(result.passCount).toBe(1);
  });

  it('no commits found returns pass with zero commits', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: '',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/empty',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('pass');
    expect(result.commitsAnalyzed).toBe(0);
    expect(result.violations).toHaveLength(0);
  });

  it('single commit with only impl returns fail', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\n',
      },
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'feat: one-shot impl',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'src/thing.ts\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/single',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
  });

  it('single commit with only test returns pass', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\n',
      },
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'test: add thing tests',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'src/thing.test.ts\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/test-only',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(1);
  });

  // RED for debug-delegation-gate Issue A: canonical RED→GREEN where the test
  // and impl files share a directory but have different basenames (e.g. a
  // test harness file `testing.ts` exercised by `immutability.test.ts`).
  // Without the same-directory fallback, the gate false-negatives on the
  // canonical TDD pattern.
  it('same-directory match: test and impl files with different basenames pass', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\nbbb222\n',
      },
      // Commit 1 (RED): test file
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'test(projections): RED — reducer immutability property harness',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'src/projections/immutability.test.ts\n',
      },
      // Commit 2 (GREEN): impl file in SAME directory, different basename
      {
        args: ['log', '-1', '--format=%s', 'bbb222'],
        stdout: 'feat(projections): GREEN — assertReducerImmutable harness',
      },
      {
        args: ['log', '-1', '--format=%h', 'bbb222'],
        stdout: 'bbb222',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'bbb222'],
        stdout: 'src/projections/testing.ts\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/cross-basename',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('pass');
    expect(result.violations).toHaveLength(0);
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
  });

  it('cross-directory match: test and impl in different directories remains a violation', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\nbbb222\n',
      },
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'test: add widget tests',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'src/a/widget.test.ts\n',
      },
      {
        args: ['log', '-1', '--format=%s', 'bbb222'],
        stdout: 'feat: add unrelated impl',
      },
      {
        args: ['log', '-1', '--format=%h', 'bbb222'],
        stdout: 'bbb222',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'bbb222'],
        stdout: 'src/b/other.ts\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/cross-dir',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
  });

  it('non-code commit is skipped', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\n',
      },
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'docs: update readme',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'README.md\ndocs/guide.md\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/docs',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('pass');
    expect(result.commitsAnalyzed).toBe(1);
    // Non-code commits don't count as pass or fail
    expect(result.passCount).toBe(0);
    expect(result.failCount).toBe(0);
  });

  it('defaults baseBranch to main', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H', 'main..feature/test'],
        stdout: '',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/test',
      execGit: gitMock,
    });

    expect(result.status).toBe('pass');
    expect(result.branch).toBe('feature/test');
    expect(result.baseBranch).toBe('main');
  });

  it('report output is structured markdown', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\n',
      },
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'test: widget tests',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'src/widget.test.ts\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/test',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.report).toContain('## TDD Compliance Report');
    expect(result.report).toContain('**Branch:**');
    expect(result.report).toContain('**Result: PASS**');
  });

  it('spec file extension recognized as test', () => {
    const gitMock = createGitMock([
      {
        args: ['log', '--reverse', '--format=%H'],
        stdout: 'aaa111\nbbb222\n',
      },
      {
        args: ['log', '-1', '--format=%s', 'aaa111'],
        stdout: 'test: add spec',
      },
      {
        args: ['log', '-1', '--format=%h', 'aaa111'],
        stdout: 'aaa111',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'aaa111'],
        stdout: 'src/widget.spec.ts\n',
      },
      {
        args: ['log', '-1', '--format=%s', 'bbb222'],
        stdout: 'feat: add widget',
      },
      {
        args: ['log', '-1', '--format=%h', 'bbb222'],
        stdout: 'bbb222',
      },
      {
        args: ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-r', 'bbb222'],
        stdout: 'src/widget.ts\n',
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feature/spec',
      baseBranch: 'main',
      execGit: gitMock,
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(2);
  });
});
