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

      expect(env.testId).toBeTruthy();
      expect(typeof env.testId).toBe('string');
    });

    expect(captured).toBeDefined();
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

    expect(captured).toBeDefined();
    const parent = path.dirname(captured!.homeDir);
    expect(existsSync(parent)).toBe(false);

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

  /**
   * The helper holds a FIFO mutex, so each callback under `Promise.all` sees the process
   * state of its own call. The test checks that the temp directories are unique, and that
   * `HOME`, `EXARCHOS_STATE_DIR` and the working directory match the `env` of the call.
   * The `setImmediate` lets other callers run. Then the test checks `HOME` and the working
   * directory again. Without the mutex, these assertions fail intermittently.
   * The timeout is long because 100 serialized `git init` spawns are slow on Windows.
   */
  it('WithHermeticEnv_ConcurrentCallers_GetNonOverlappingTmpDirsAndIsolatedProcessState', async () => {
    const COUNT = 100;
    const ids: string[] = [];
    const homeDirs: string[] = [];

    await Promise.all(
      Array.from({ length: COUNT }, () =>
        withHermeticEnv(async (env) => {
          expect(process.env.HOME).toBe(env.homeDir);
          expect(process.env.EXARCHOS_STATE_DIR).toBe(env.stateDir);
          expect(process.cwd()).toBe(env.cwdDir);

          ids.push(env.testId);
          homeDirs.push(env.homeDir);
          await new Promise((resolve) => setImmediate(resolve));

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

  /** A standard `git init` puts a `.git` directory inside the target directory. */
  it('WithHermeticEnv_GitInit_TmpGitIsRepository', async () => {
    await withHermeticEnv(async (env) => {
      const gitMeta = path.join(env.gitDir, '.git');
      expect(existsSync(gitMeta)).toBe(true);
    });
  });

  /**
   * The mock makes `rmrfAsync` throw, as a locked file does on Windows. The helper must
   * log a warning and must not throw. The `finally` block removes the temp tree that the
   * failed cleanup left behind.
   */
  it('WithHermeticEnv_CleanupRace_DoesNotFailTest', async () => {
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
      if (tmpRootForCleanup !== undefined) {
        await rmrfAsync(tmpRootForCleanup).catch(() => {});
      }
    }
  });
});
