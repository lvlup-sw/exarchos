import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { withHermeticEnv, type HermeticEnv } from './hermetic.js';

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

  it('WithHermeticEnv_ConcurrentCallers_GetNonOverlappingTmpDirs', async () => {
    const COUNT = 100;
    const ids: string[] = [];
    const homeDirs: string[] = [];

    await Promise.all(
      Array.from({ length: COUNT }, () =>
        withHermeticEnv(async (env) => {
          ids.push(env.testId);
          homeDirs.push(env.homeDir);
          // Small delay to force interleaving.
          await new Promise((resolve) => setImmediate(resolve));
        }),
      ),
    );

    expect(ids.length).toBe(COUNT);
    expect(new Set(ids).size).toBe(COUNT);
    expect(new Set(homeDirs).size).toBe(COUNT);
  });

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
    // Simulate fs.rm throwing during cleanup. The helper must swallow the error
    // (console.warn) and must NOT re-throw so tests aren't flaky.
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async () => {
      throw new Error('simulated locked file');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Should not throw despite cleanup failure.
      await expect(
        withHermeticEnv(async (env) => {
          expect(env.homeDir).toBeTruthy();
        }),
      ).resolves.toBeUndefined();

      // Warning was logged.
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
