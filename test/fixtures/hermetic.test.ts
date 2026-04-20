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
    // Simulate cleanup race: make the helper's `fs.rm` of the tmp root throw,
    // mirroring locked-file / AV-scanner scenarios on Windows/CI. The helper
    // must swallow the error (console.warn) and must NOT re-throw, so tests
    // that merely happen to run during such a race aren't made flaky.
    //
    // We pre-populate the tmp root with an unremovable artifact: a directory
    // with read-only permissions whose own removal fails under the test's
    // uid. Rather than relying on OS-specific ACL behavior, we instead
    // replace the target tmp path with a path that does not exist and is
    // protected: the simplest deterministic failure mode is to intercept the
    // real `fs.rm` at call time by making the tmp root a mount point — not
    // portable.
    //
    // Portable approach: overwrite `fs.promises.rm` on the `node:fs` module
    // object (whose properties ARE writable) BEFORE the helper resolves its
    // dynamic rm call. But the helper imports from `node:fs/promises`, whose
    // bindings are frozen. So we defeat cleanup a different way: after the
    // helper creates the tmp tree, we swap the tmp root for a path the
    // helper's fs.rm will error on — specifically, we remove the tmp tree
    // ourselves from inside the callback and then replace it with a file
    // whose presence at a directory path would surface ENOTDIR. But `rm`
    // with `{ recursive: true, force: true }` successfully removes files.
    //
    // Final strategy: monkey-patch `fs.promises` (the `node:fs` re-export,
    // NOT `node:fs/promises`'s frozen namespace) AND also intercept the
    // binding the helper uses. Since `node:fs/promises` and `fs.promises`
    // point to the same underlying callable object, swapping `rm` on
    // `fs.promises.rm` does NOT affect the helper's already-bound
    // `import * as fs from 'node:fs/promises'` — those are separate
    // namespace bindings.
    //
    // So we use `vi.doMock` with a factory that defers to the real module
    // for everything except `rm`. Because `vi.doMock` takes effect only for
    // subsequent dynamic imports, we re-import the helper via dynamic import
    // in an isolated module graph.
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        rm: async () => {
          throw new Error('simulated locked file');
        },
        default: {
          ...actual,
          rm: async () => {
            throw new Error('simulated locked file');
          },
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
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      warnSpy.mockRestore();
      // Best-effort manual cleanup of the leaked tmp tree.
      if (tmpRootForCleanup !== undefined) {
        await fs.rm(tmpRootForCleanup, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
});
