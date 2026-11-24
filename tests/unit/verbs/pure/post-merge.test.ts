import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPostMerge } from '../../../../src/verbs/pure/post-merge.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/** The result of the injected command runner. */
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

/** `nodeRepo` is a node project, so the toolchain resolver resolves `npm run test:run` for it. */
describe('checkPostMerge', () => {
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

  /** The check runs only the test suite, so a green suite is a pass with one check. */
  it('clean merge (test suite passes) returns pass', async () => {
    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(0);
  });

  it('test regression after merge returns fail', async () => {
    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 1, stdout: '', stderr: 'FAIL: some test broke' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
    expect(result.report).toContain('FAIL');
    expect(result.findings).toEqual([
      'FINDING [D4] [HIGH] criterion="test-suite" evidence="npm run test:run failed (merge-sha: abc1234)"',
    ]);
  });

  /** The check has no CI leg: the only command it runs is the resolved test command, and the report names no CI check. */
  it('reads no CI status and runs only the test command', async () => {
    const runs: string[] = [];

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: (cmd, args) => {
        runs.push([cmd, ...args].join(' '));
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });

    expect(runs).toEqual(['npm run test:run']);
    expect(result.results).toEqual(['- **PASS**: Test suite (npm run test:run passed)']);
    expect(result.report).not.toContain('CI');
  });

  it('report output is structured markdown', async () => {
    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: nodeRepo,
      runCommand: testRunner,
    });

    expect(result.report).toContain('## Post-Merge Regression Report');
    expect(result.report).toContain('**PR:**');
    expect(result.report).toContain('**Merge SHA:**');
    expect(result.report).toContain('**Result: PASS**');
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
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(result.status).toBe('fail');
    expect(result.findings).toEqual([
      'FINDING [D4] [HIGH] criterion="test-suite" evidence="no test command resolved (merge-sha: abc1234)"',
    ]);
    expect(result.results[0]).toMatch(/^- \*\*FAIL\*\*: Test suite -- no test command resolved: No project markers detected/);
  });
});
