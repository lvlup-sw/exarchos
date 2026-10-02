import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { defaultGitExec } from '../../../../src/verbs/vcs/git-exec-default.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/**
 * The merge orchestrator's `defaultGitExec` returns git stderr separately. On a
 * failure, it also appends stderr to `stdout`, because some callers read
 * `stdout` as the failure message.
 */
describe('git-exec-default', () => {
  const repoRoot = process.cwd();

  it('DefaultGitExec_RunsGitArgs_ReturnsStdoutAndExitCode', () => {
    const result = defaultGitExec(repoRoot, ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/git version/i);
    expect(result.stderr).toBe('');
  });

  it('DefaultGitExec_GitFailure_CapturesStderrAndExitCode', () => {
    const result = defaultGitExec(repoRoot, ['this-is-not-a-git-command']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

/**
 * `defaultGitExec` wraps one git run in `withIndexLockRetrySync`. These tests
 * run that default composition, not a seam, against a real repository with a
 * real `.git/index.lock` file. The sync retry blocks the main thread with
 * `Atomics.wait` during each backoff. Thus a worker thread removes the lock,
 * because a main-thread timer cannot run during the backoff.
 */
describe('git-exec-default — DR-1 index.lock retry composition', () => {
  const createdRepos: string[] = [];

  afterEach(() => {
    for (const repo of createdRepos.splice(0)) {
      rmrf(repo);
    }
  });

  async function makeRepo(): Promise<{ repo: string; file: string; lock: string }> {
    const repo = mkdtempSync(join(tmpdir(), 'exarchos-lockrepo-'));
    createdRepos.push(repo);
    const git = async (args: string[]): Promise<void> => {
      await execFileAsync('git', args, { cwd: repo });
    };
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@exarchos.local']);
    await git(['config', 'user.name', 'Exarchos Test']);
    const file = 'staged.txt';
    writeFileSync(join(repo, file), 'contents\n');
    return { repo, file, lock: join(repo, '.git', 'index.lock') };
  }

  function scheduleOffThreadRemoval(lockPath: string, delayMs: number): Worker {
    return new Worker(
      `const { unlinkSync } = require('node:fs');
       const { workerData } = require('node:worker_threads');
       setTimeout(() => {
         try { unlinkSync(workerData.lockPath); } catch { /* already gone */ }
       }, workerData.delayMs);`,
      { eval: true, workerData: { lockPath, delayMs } },
    );
  }

  /**
   * The worker removes the lock during the first backoff, so a retry succeeds,
   * not the first attempt. Git cannot succeed while the lock exists. The
   * staged file proves that the retry did real work.
   */
  it('DefaultGitExecComposition_RealIndexLockFile_RetriesAndSucceeds', async () => {
    const { repo, file, lock } = await makeRepo();
    writeFileSync(lock, '');
    expect(existsSync(lock)).toBe(true);

    const remover = scheduleOffThreadRemoval(lock, 100);
    const result = defaultGitExec(repo, ['add', file]);
    await remover.terminate();

    expect(result.exitCode).toBe(0);
    expect(existsSync(lock)).toBe(false);
    const status = defaultGitExec(repo, ['status', '--porcelain']);
    expect(status.stdout).toMatch(/^A\s+staged\.txt/m);
  }, 20_000);

  /**
   * The lock never clears, so the retries run out. The result must be a
   * non-zero exit with the index.lock message, not a silent success or an
   * empty failure. The file must stay untracked after the lock goes.
   */
  it('DefaultGitExecComposition_PersistentLock_ReturnsContentionResultNotSilentFailure', async () => {
    const { repo, file, lock } = await makeRepo();
    writeFileSync(lock, '');

    const result = defaultGitExec(repo, ['add', file]);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stderr ?? ''}\n${result.stdout}`).toMatch(
      /unable to create '[^']*index\.lock'/i,
    );
    rmSync(lock, { force: true });
    const status = defaultGitExec(repo, ['status', '--porcelain']);
    expect(status.stdout).toMatch(/^\?\?\s+staged\.txt/m);
  }, 20_000);
});
