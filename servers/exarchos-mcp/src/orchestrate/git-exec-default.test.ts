import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { defaultGitExec } from './git-exec-default.js';

// #1311 — scoped coverage for the shared merge-orchestrator git executor.
// The canonical (120s, stderr-capturing) `defaultGitExec` extracted from the
// two byte-equivalent copies in merge-orchestrate.ts and execute-merge.ts.
// The 30s gate-utils variant is intentionally separate (different workload).
describe('git-exec-default', () => {
  const repoRoot = process.cwd();

  it('DefaultGitExec_RunsGitArgs_ReturnsStdoutAndExitCode', () => {
    const result = defaultGitExec(repoRoot, ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/git version/i);
    // success path captures empty stderr separately (richer #1401 body)
    expect(result.stderr).toBe('');
  });

  it('DefaultGitExec_GitFailure_CapturesStderrAndExitCode', () => {
    const result = defaultGitExec(repoRoot, ['this-is-not-a-git-command']);
    expect(result.exitCode).not.toBe(0);
    // stderr is captured separately (the behavior #1401 added) ...
    expect(result.stderr!.length).toBeGreaterThan(0);
    // ... and also folded into the stdout channel for backwards-compat with
    // callers that read `stdout` as the failure-message channel.
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

// ─── DR-1: index.lock retry is wired into the DEFAULT composition ────────────
//
// `defaultGitExec` is `runGitOnce` wrapped in `withIndexLockRetrySync`. These
// tests exercise the DEFAULT production composition (NOT a DI seam) against a
// REAL on-disk git repo with a REAL `.git/index.lock` file, proving the retry
// is actually wired into what production runs — not just present in the kernel.
//
// NOTE: the sync retry blocks the MAIN thread (`Atomics.wait`) during each
// backoff, so a main-thread `setTimeout` would never fire to clear the lock
// mid-retry. The lock is therefore cleared from a WORKER thread, whose timer
// runs independently of the main thread's blocking sleep.
describe('git-exec-default — DR-1 index.lock retry composition', () => {
  const createdRepos: string[] = [];

  afterEach(() => {
    for (const repo of createdRepos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // A real, initialized git repo with one unstaged file and the path to its
  // (not-yet-created) index.lock.
  function makeRepo(): { repo: string; file: string; lock: string } {
    const repo = mkdtempSync(join(tmpdir(), 'exarchos-lockrepo-'));
    createdRepos.push(repo);
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@exarchos.local']);
    git(['config', 'user.name', 'Exarchos Test']);
    const file = 'staged.txt';
    writeFileSync(join(repo, file), 'contents\n');
    return { repo, file, lock: join(repo, '.git', 'index.lock') };
  }

  // Remove `lockPath` off the main thread after `delayMs`. A worker thread is
  // REQUIRED: the sync backoff blocks the main thread, so only an independent
  // thread's timer can clear the lock while a retry is pending.
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

  it('DefaultGitExecComposition_RealIndexLockFile_RetriesAndSucceeds', async () => {
    const { repo, file, lock } = makeRepo();
    // A REAL on-disk lock: `git add` fails until it is removed.
    writeFileSync(lock, '');
    expect(existsSync(lock)).toBe(true);

    // Clear the lock off-thread partway through the first backoff, so a RETRY
    // (not the initial attempt) is the one that succeeds.
    const remover = scheduleOffThreadRemoval(lock, 100);
    const startedAt = Date.now();
    const result = defaultGitExec(repo, ['add', file]);
    const elapsedMs = Date.now() - startedAt;
    await remover.terminate();

    // The DEFAULT composition retried and eventually succeeded.
    expect(result.exitCode).toBe(0);
    expect(existsSync(lock)).toBe(false);
    // Success is ONLY reachable via a retry: git cannot succeed while the lock
    // exists, so a real backoff sleep must have elapsed between attempts.
    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    // The file was actually staged — the retried op did real work, not a no-op.
    const status = defaultGitExec(repo, ['status', '--porcelain']);
    expect(status.stdout).toMatch(/^A\s+staged\.txt/m);
  }, 20_000);

  it('DefaultGitExecComposition_PersistentLock_ReturnsContentionResultNotSilentFailure', () => {
    const { repo, file, lock } = makeRepo();
    // The lock never clears → the retry budget is exhausted.
    writeFileSync(lock, '');

    const result = defaultGitExec(repo, ['add', file]);

    // A STRUCTURED contention result: non-zero exit + the index.lock signature.
    // NOT a silent success (exitCode 0) and NOT an opaque/empty failure.
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stderr ?? ''}\n${result.stdout}`).toMatch(
      /unable to create '[^']*index\.lock'/i,
    );
    // The op was a genuine no-op reported honestly: with the lock still present
    // nothing was staged. Remove the lock and confirm the file is still untracked.
    rmSync(lock, { force: true });
    const status = defaultGitExec(repo, ['status', '--porcelain']);
    expect(status.stdout).toMatch(/^\?\?\s+staged\.txt/m);
  }, 20_000);
});
