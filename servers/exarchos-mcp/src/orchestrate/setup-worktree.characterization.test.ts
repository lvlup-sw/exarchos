// ─── Characterization Tests for setup-worktree.ts ──────────────────────────
//
// Per Michael Feathers' characterization-test technique. These tests document
// the CURRENT behavior of `runNpmInstall` and `runBaselineTests` against HEAD.
// They are part of refactor #1199 (test-runtime-resolver consolidation),
// task T03 — Wave 1 RED-only characterization. No production code is being
// changed by this commit beyond a single-keyword `export` on the two helpers
// to make them directly testable.
//
// ─── DESTRUCTIVE-FAILURE-MODE NOTICE ────────────────────────────────────────
//
// Test case 3 (`runNpmInstall_PnpmLockfilePresent_RunsNpmInstallAnyway`)
// asserts the CURRENT, DESTRUCTIVE behavior: `runNpmInstall` does not detect
// foreign lockfiles (pnpm-lock.yaml, yarn.lock) and unconditionally invokes
// `npm install`, which silently rewrites the dependency graph of a pnpm/yarn
// worktree. This test is intentionally locking in the broken-as-of-HEAD
// behavior so that task T09 of the refactor has an unambiguous "before"
// assertion to flip. After T09 lands, this test's assertion will be inverted
// (or the test deleted) to verify that npm install is NOT invoked when a
// foreign lockfile is present.
//
// DO NOT "FIX" the production code in response to test 3. The fix is T09's
// job; this characterization test is the safety net for that change.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock node:child_process so we can intercept `execFileSync` invocations
// without spawning real `npm`. `node:fs` is intentionally NOT mocked — the
// tests use real temp directories so `existsSync(package.json)` reflects
// realistic on-disk state.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { runNpmInstall, runBaselineTests } from './setup-worktree.js';

// Track every temp dir we create so we can clean them up between tests.
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'setup-worktree-char-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
});

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

// ─── runNpmInstall ──────────────────────────────────────────────────────────

describe('runNpmInstall (characterization)', () => {
  it('runNpmInstall_NoPackageJson_SkipsWithReason', () => {
    const worktree = makeTempDir(); // empty dir — no package.json

    const result = runNpmInstall(worktree);

    expect(result).toEqual({
      name: 'npm install',
      status: 'skip',
      detail: 'no package.json in worktree',
    });
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('runNpmInstall_NpmProject_RunsNpmInstall', () => {
    const worktree = makeTempDir();
    writeFileSync(
      join(worktree, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0' }),
    );
    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(''));

    const result = runNpmInstall(worktree);

    expect(result.status).toBe('pass');
    expect(result.name).toBe('npm install completed');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(execFileSync).mock.calls[0];
    expect(call[0]).toBe('npm');
    expect(call[1]).toEqual(['install', '--silent']);
    const opts = call[2] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBe(worktree);
  });

  // ─── DESTRUCTIVE-CASE-DOCUMENTATION ───────────────────────────────────────
  //
  // Documents the DESTRUCTIVE failure mode that T09 fixes. As of HEAD,
  // `runNpmInstall` does not check for foreign lockfiles (pnpm-lock.yaml,
  // yarn.lock); it unconditionally invokes `npm install --silent`, which
  // rewrites a pnpm/yarn worktree's dependency graph and corrupts state.
  //
  // After T09, this test's assertion flips: with pnpm-lock.yaml present,
  // `runNpmInstall` MUST NOT call npm install (it should pivot to pnpm
  // install or skip with an explanatory detail). When you flip the
  // assertion, also remove this comment and the suite-level notice above.
  // ──────────────────────────────────────────────────────────────────────────
  it('runNpmInstall_PnpmLockfilePresent_RunsNpmInstallAnyway', () => {
    const worktree = makeTempDir();
    writeFileSync(
      join(worktree, 'package.json'),
      JSON.stringify({ name: 'pnpm-fixture', version: '0.0.0' }),
    );
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(''));

    const result = runNpmInstall(worktree);

    // Current (destructive) behavior: npm install IS invoked despite the
    // foreign lockfile. This assertion will flip in T09.
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(execFileSync).mock.calls[0];
    expect(call[0]).toBe('npm');
    expect(call[1]).toEqual(['install', '--silent']);
    expect(result.status).toBe('pass');
  });
});

// ─── runBaselineTests ───────────────────────────────────────────────────────

describe('runBaselineTests (characterization)', () => {
  it('runBaselineTests_NoPackageJson_SkipsWithReason', () => {
    const worktree = makeTempDir(); // empty dir — no package.json

    const result = runBaselineTests(worktree, false);

    expect(result.status).toBe('skip');
    expect(result.name).toBe('Baseline tests pass');
    expect(result.detail).toMatch(/package\.json/);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('runBaselineTests_NpmProject_RunsNpmRunTestRun', () => {
    const worktree = makeTempDir();
    writeFileSync(
      join(worktree, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.0.0',
        scripts: { 'test:run': 'echo ok' },
      }),
    );
    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(''));

    const result = runBaselineTests(worktree, false);

    expect(result.status).toBe('pass');
    expect(result.name).toBe('Baseline tests pass');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(execFileSync).mock.calls[0];
    expect(call[0]).toBe('npm');
    expect(call[1]).toEqual(['run', 'test:run']);
    const opts = call[2] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBe(worktree);
  });

  it('runBaselineTests_SkipTestsFlag_Skips', () => {
    const worktree = makeTempDir();
    // Even with a fully populated package.json, --skip-tests should short-circuit.
    writeFileSync(
      join(worktree, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.0.0',
        scripts: { 'test:run': 'echo ok' },
      }),
    );

    const result = runBaselineTests(worktree, true);

    expect(result.status).toBe('skip');
    expect(result.name).toBe('Baseline tests pass');
    expect(result.detail).toMatch(/skip-tests/);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });
});
