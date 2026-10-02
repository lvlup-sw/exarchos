import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPostMerge } from '../../../../src/verbs/pure/post-merge.js';
import type { VcsProvider, CiStatus, CiCheck } from '../../../../src/vcs/provider.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

// ─── Mock VcsProvider Helper ────────────────────────────────────────────────

function createMockProvider(overrides: {
  checkCi?: CiStatus;
  checkCiError?: Error;
} = {}): VcsProvider {
  const defaultCi: CiStatus = { status: 'pass', checks: [] };

  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: overrides.checkCiError
      ? vi.fn().mockRejectedValue(overrides.checkCiError)
      : vi.fn<(prId: string) => Promise<CiStatus>>().mockResolvedValue(overrides.checkCi ?? defaultCi),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  };
}

/**
 * Type for the command runner dependency injection (for test suite only).
 */
type CommandResult = { exitCode: number; stdout: string; stderr: string };

function createCommandRunner(results: Record<string, CommandResult>): (
  cmd: string,
  args: readonly string[]
) => CommandResult {
  return (cmd: string, args: readonly string[]) => {
    const key = [cmd, ...args].join(' ');
    for (const [registeredKey, result] of Object.entries(results)) {
      if (key.includes(registeredKey)) {
        return result;
      }
    }
    return { exitCode: 1, stdout: '', stderr: 'command not found' };
  };
}

const fixtureDirs: string[] = [];

/** A real temporary repository holding `files`, removed after the suite. */
function fixtureRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'post-merge-'));
  fixtureDirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe('checkPostMerge', () => {
  /** A node project: the toolchain resolver resolves `npm run test:run`. */
  let nodeRepo: string;

  beforeAll(() => {
    nodeRepo = fixtureRepo({ 'package.json': JSON.stringify({ scripts: { 'test:run': 'vitest run' } }) });
  });

  afterAll(() => {
    for (const dir of fixtureDirs.splice(0)) rmrf(dir);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ─── VcsProvider integration ──────────────────────────────────────────

  it('clean merge (all checks pass via provider) returns pass', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'pass',
        checks: [
          { name: 'build', status: 'pass' },
          { name: 'test', status: 'pass' },
          { name: 'lint', status: 'skipped' },
        ],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(provider.checkCi).toHaveBeenCalledWith('https://github.com/org/repo/pull/42');
  });

  it('CI failure after merge via provider returns fail', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'fail',
        checks: [
          { name: 'build', status: 'pass' },
          { name: 'test', status: 'fail' },
          { name: 'lint', status: 'pass' },
        ],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
    expect(result.report).toContain('test');
  });

  it('test regression after merge returns fail', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'pass',
        checks: [
          { name: 'build', status: 'pass' },
          { name: 'test', status: 'pass' },
        ],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 1, stdout: '', stderr: 'FAIL: some test broke' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
    expect(result.report).toContain('FAIL');
  });

  it('both CI and tests fail returns fail with two findings', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'fail',
        checks: [
          { name: 'build', status: 'fail' },
          { name: 'test', status: 'fail' },
        ],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 1, stdout: '', stderr: 'FAIL: regression' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(2);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
  });

  it('provider error reports failure', async () => {
    const provider = createMockProvider({
      checkCiError: new Error('command not found: gh'),
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
  });

  it('report output is structured markdown', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'pass',
        checks: [{ name: 'build', status: 'pass' }],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
      provider,
    });

    expect(result.report).toContain('## Post-Merge Regression Report');
    expect(result.report).toContain('**PR:**');
    expect(result.report).toContain('**Merge SHA:**');
    expect(result.report).toContain('**Result: PASS**');
  });

  it('pending CI checks are treated as non-passing', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'pending',
        checks: [{ name: 'build', status: 'pending' }],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'ok', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
  });

  it('empty checks from provider returns pass for CI', async () => {
    const provider = createMockProvider({
      checkCi: { status: 'pass', checks: [] },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'ok', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(2);
  });

  /** A Go module resolves `go test ./...` from the toolchain registry, and that command runs. */
  it('runs the resolved test command for a Go module', async () => {
    const goRepo = fixtureRepo({ 'go.mod': 'module example.com/fixture\n' });
    const runs: Array<{ cmd: string; args: readonly string[] }> = [];

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: goRepo,
      runCommand: (cmd, args) => {
        runs.push({ cmd, args });
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      provider: createMockProvider(),
    });

    expect(runs).toEqual([{ cmd: 'go', args: ['test', './...'] }]);
    expect(result.status).toBe('pass');
    expect(result.results).toContain('- **PASS**: Test suite (go test ./... passed)');
  });

  /** No project markers and no configuration: the test check fails closed and runs nothing. */
  it('fails the test suite check when no test command resolves', async () => {
    const emptyRepo = fixtureRepo({});
    const runCommand = vi.fn();

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: emptyRepo,
      runCommand,
      provider: createMockProvider(),
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(result.status).toBe('fail');
    expect(result.findings).toEqual([
      'FINDING [D4] [HIGH] criterion="test-suite" evidence="no test command resolved (merge-sha: abc1234)"',
    ]);
    expect(result.results[1]).toMatch(/^- \*\*FAIL\*\*: Test suite -- no test command resolved: No project markers detected/);
  });
});
