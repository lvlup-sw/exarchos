import { describe, it, expect } from 'vitest';
import { checkTddCompliance } from './tdd-compliance.js';

/**
 * Behavioral parity tests for tdd-compliance.ts against the original
 * scripts/check-tdd-compliance.sh bash script.
 *
 * Bash script behavior:
 *   - exit 0 → all commits compliant (test-first or test-with-impl)
 *   - exit 1 → violations found (implementation without prior test)
 */

/**
 * Build an execGit mock that simulates git log and git diff-tree output.
 *
 * commitData: array of { hash, shortHash, message, files } in chronological order.
 */
function makeExecGit(
  commitData: {
    hash: string;
    shortHash: string;
    message: string;
    files: string[];
  }[]
): (cmd: string, args: readonly string[], opts?: { cwd?: string; encoding?: string }) => string {
  return (_cmd: string, args: readonly string[]): string => {
    const argsStr = args.join(' ');

    // git log --reverse --format=%H base..branch
    if (argsStr.includes('--reverse') && argsStr.includes('--format=%H')) {
      return commitData.map((c) => c.hash).join('\n') + '\n';
    }

    // git log -1 --format=%s <sha>
    if (argsStr.includes('--format=%s')) {
      const sha = args[args.length - 1];
      const commit = commitData.find((c) => c.hash === sha);
      return commit ? commit.message + '\n' : '\n';
    }

    // git log -1 --format=%h <sha>
    if (argsStr.includes('--format=%h')) {
      const sha = args[args.length - 1];
      const commit = commitData.find((c) => c.hash === sha);
      return commit ? commit.shortHash + '\n' : '\n';
    }

    // git diff-tree --no-commit-id --name-only --diff-filter=ACMRT -r <sha>
    if (argsStr.includes('diff-tree')) {
      const sha = args[args.length - 1];
      const commit = commitData.find((c) => c.hash === sha);
      return commit ? commit.files.join('\n') + '\n' : '\n';
    }

    return '';
  };
}

describe('behavioral parity with check-tdd-compliance.sh', () => {
  it('compliant — test-only commit followed by impl commit passes with 2/2 compliant', () => {
    const execGit = makeExecGit([
      {
        hash: 'aaa111aaa111aaa111aaa111aaa111aaa111aaa1',
        shortHash: 'aaa111a',
        message: 'test: add unit tests for add function',
        files: ['src/add.test.ts'],
      },
      {
        hash: 'bbb222bbb222bbb222bbb222bbb222bbb222bbb2',
        shortHash: 'bbb222b',
        message: 'feat: implement add function',
        files: ['src/add.ts'],
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feat/add',
      baseBranch: 'main',
      execGit,
    });

    expect(result.status).toBe('pass');
    expect(result.commitsAnalyzed).toBe(2);
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.report).toContain('**Result: PASS** (2/2 commits compliant)');

    // Verify per-commit analysis details
    expect(result.results[0]).toContain('PASS');
    expect(result.results[0]).toContain('test-only');
    expect(result.results[1]).toContain('PASS');
    expect(result.results[1]).toContain('test in prior commit');
  });

  it('non-compliant — impl commit without prior test fails with 1/1 violations', () => {
    const execGit = makeExecGit([
      {
        hash: 'ccc333ccc333ccc333ccc333ccc333ccc333ccc3',
        shortHash: 'ccc333c',
        message: 'feat: implement sub function',
        files: ['src/sub.ts'],
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feat/sub',
      baseBranch: 'main',
      execGit,
    });

    expect(result.status).toBe('fail');
    expect(result.commitsAnalyzed).toBe(1);
    expect(result.passCount).toBe(0);
    expect(result.failCount).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('ccc333c');
    expect(result.report).toContain('**Result: FAIL** (1/1 commits have violations)');

    // Verify per-commit analysis
    expect(result.results[0]).toContain('FAIL');
    expect(result.results[0]).toContain('implementation without test');
  });

  it('mixed commit with test and impl together passes as compliant', () => {
    const execGit = makeExecGit([
      {
        hash: 'ddd444ddd444ddd444ddd444ddd444ddd444ddd4',
        shortHash: 'ddd444d',
        message: 'feat: add multiply with tests',
        files: ['src/multiply.ts', 'src/multiply.test.ts'],
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'feat/multiply',
      baseBranch: 'main',
      execGit,
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.results[0]).toContain('test+impl');
  });

  it('non-code-only commit is skipped and does not affect pass/fail tally', () => {
    const execGit = makeExecGit([
      {
        hash: 'eee555eee555eee555eee555eee555eee555eee5',
        shortHash: 'eee555e',
        message: 'docs: update README',
        files: ['README.md'],
      },
    ]);

    const result = checkTddCompliance({
      repoRoot: '/fake/repo',
      branch: 'docs/readme',
      baseBranch: 'main',
      execGit,
    });

    expect(result.status).toBe('pass');
    expect(result.commitsAnalyzed).toBe(1);
    expect(result.passCount).toBe(0);
    expect(result.failCount).toBe(0);
    expect(result.results[0]).toContain('SKIP');
    expect(result.report).toContain('**Result: PASS**');
  });
});
