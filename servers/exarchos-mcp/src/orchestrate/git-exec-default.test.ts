import { describe, it, expect } from 'vitest';
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
    expect(result.stderr.length).toBeGreaterThan(0);
    // ... and also folded into the stdout channel for backwards-compat with
    // callers that read `stdout` as the failure-message channel.
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
