import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { withHermeticEnv, type HermeticEnv } from './hermetic.js';
import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

describe('withHermeticEnv', () => {
  it('WithHermeticEnv_Success_ProvidesFreshHomeAndStateAndCwd', async () => {
    let captured: HermeticEnv | undefined;

    await withHermeticEnv(async (env) => {
      captured = env;

      // All four dirs exist, are under os.tmpdir(), and are distinct.
      expect(existsSync(env.homeDir)).toBe(true);
      expect(existsSync(env.stateDir)).toBe(true);
      expect(existsSync(env.cwdDir)).toBe(true);
      expect(existsSync(env.gitDir)).toBe(true);

      const tmpRoot = os.tmpdir();
      expect(env.homeDir.startsWith(tmpRoot)).toBe(true);
      expect(env.stateDir.startsWith(tmpRoot)).toBe(true);
      expect(env.cwdDir.startsWith(tmpRoot)).toBe(true);
      expect(env.gitDir.startsWith(tmpRoot)).toBe(true);

      const dirSet = new Set([env.homeDir, env.stateDir, env.cwdDir, env.gitDir]);
      expect(dirSet.size).toBe(4);

      // testId is set.
      expect(env.testId).toBeTruthy();
      expect(typeof env.testId).toBe('string');
    });

    // After callback, tmp tree is removed.
    expect(captured).toBeDefined();
    // The parent tmp dir containing all four should be gone.
    const parent = path.dirname(captured!.homeDir);
    expect(existsSync(parent)).toBe(false);
  });

  it('WithHermeticEnv_CallbackThrows_StillCleansUp', async () => {
    let captured: HermeticEnv | undefined;

    const originalHome = process.env.HOME;
    const originalState = process.env.EXARCHOS_STATE_DIR;
    const originalCwd = process.cwd();

    await expect(
      withHermeticEnv(async (env) => {
        captured = env;
        throw new Error('callback failure');
      }),
    ).rejects.toThrow('callback failure');

    // tmp tree is gone.
    expect(captured).toBeDefined();
    const parent = path.dirname(captured!.homeDir);
    expect(existsSync(parent)).toBe(false);

    // env + cwd restored.
    expect(process.env.HOME).toBe(originalHome);
    expect(process.env.EXARCHOS_STATE_DIR).toBe(originalState);
    expect(process.cwd()).toBe(originalCwd);
  });

  it('WithHermeticEnv_CallbackSucceeds_RestoresOriginalHomeAndCwd', async () => {
    const originalHome = process.env.HOME;
    const originalState = process.env.EXARCHOS_STATE_DIR;
    const originalCwd = process.cwd();

    await withHermeticEnv(async (env) => {
      expect(process.env.HOME).toBe(env.homeDir);
      expect(process.env.EXARCHOS_STATE_DIR).toBe(env.stateDir);
      expect(process.cwd()).toBe(env.cwdDir);
    });

    expect(process.env.HOME).toBe(originalHome);
    expect(process.env.EXARCHOS_STATE_DIR).toBe(originalState);
    expect(process.cwd()).toBe(originalCwd);
  });

  it('WithHermeticEnv_ConcurrentCallers_GetNonOverlappingTmpDirsAndIsolatedProcessState', async () => {
    // 100 iterations, each spawning a real `git init` + touching the
    // filesystem, fully serialized by the module-level mutex — Windows
    // process-spawn + NTFS/AV-scanned churn is several times slower than
    // Linux for this shape, so the vitest default 5000ms timeout is too
    // tight there even though the logic itself is not slow.
    // The helper holds a module-level FIFO mutex around its env-mutation /
    // callback / cleanup region, so even when scheduled with Promise.all
    // each callback observes a process state that matches the env it was
    // handed. This test exercises both:
    //   (a) tmp dirs are unique across calls, and
    //   (b) within each callback, process.env.HOME / EXARCHOS_STATE_DIR /
    //       cwd are consistent with that call's env (no interleaving leak).
    const COUNT = 100;
    const ids: string[] = [];
    const homeDirs: string[] = [];

    await Promise.all(
      Array.from({ length: COUNT }, () =>
        withHermeticEnv(async (env) => {
          // Isolation assertions — would fail if the mutex ever regressed.
          expect(process.env.HOME).toBe(env.homeDir);
          expect(process.env.EXARCHOS_STATE_DIR).toBe(env.stateDir);
          expect(process.cwd()).toBe(env.cwdDir);

          ids.push(env.testId);
          homeDirs.push(env.homeDir);
          // Small delay to force scheduler interleaving — under the mutex
          // this still serializes; without the mutex the env asserts above
          // would flake under concurrent callers.
          await new Promise((resolve) => setImmediate(resolve));

          // Re-assert after the await: env must still be ours.
          expect(process.env.HOME).toBe(env.homeDir);
          expect(process.cwd()).toBe(env.cwdDir);
        }),
      ),
    );

    expect(ids.length).toBe(COUNT);
    expect(new Set(ids).size).toBe(COUNT);
    expect(new Set(homeDirs).size).toBe(COUNT);
  }, 20_000 * WIN32_SPAWN_HEADROOM);

  it('WithHermeticEnv_EnvVarsSet_HomeAndStateDirMatchTmp', async () => {
    await withHermeticEnv(async (env) => {
      expect(process.env.HOME).toBe(env.homeDir);
      expect(process.env.EXARCHOS_STATE_DIR).toBe(env.stateDir);
      expect(env.homeDir.startsWith(os.tmpdir())).toBe(true);
      expect(env.stateDir.startsWith(os.tmpdir())).toBe(true);
    });
  });

  it('WithHermeticEnv_GitInit_TmpGitIsRepository', async () => {
    await withHermeticEnv(async (env) => {
      // `git init` creates a `.git` directory (or `git init --bare` creates HEAD/config at root).
      // Standard `git init` puts .git/ inside the target dir.
      const gitMeta = path.join(env.gitDir, '.git');
      expect(existsSync(gitMeta)).toBe(true);
    });
  });

  it('WithHermeticEnv_CleanupRace_DoesNotFailTest', async () => {
    // Simulate cleanup race: make the helper's `fs.rm` of the tmp root throw,
    // mirroring locked-file / AV-scanner scenarios on Windows/CI. The helper
    // must swallow the error (console.warn) and must NOT re-throw, so tests
    // that merely happen to run during such a race aren't made flaky.
    vi.resetModules();
    vi.doMock('../../tools/test-helpers/temp-dir.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../tools/test-helpers/temp-dir.js')>();
      return {
        ...actual,
        rmrfAsync: async () => {
          throw new Error('simulated locked file');
        },
      };
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let tmpRootForCleanup: string | undefined;
    try {
      const mod = await import('./hermetic.js');
      // Should not throw despite cleanup failure.
      await expect(
        mod.withHermeticEnv(async (env) => {
          tmpRootForCleanup = path.dirname(env.homeDir);
          expect(env.homeDir).toBeTruthy();
        }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../tools/test-helpers/temp-dir.js');
      vi.resetModules();
      warnSpy.mockRestore();
      // Best-effort manual cleanup of the leaked tmp tree.
      if (tmpRootForCleanup !== undefined) {
        await rmrfAsync(tmpRootForCleanup).catch(() => {});
      }
    }
  });
});
