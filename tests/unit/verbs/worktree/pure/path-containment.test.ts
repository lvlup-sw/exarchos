import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isPathWithin,
  canonicalizeForContainment,
  defaultRealpath,
  type RealpathResolver,
} from '../../../../../src/verbs/worktree/pure/path-containment.js';
import { rmrf } from '../../../../../tools/test-helpers/temp-dir.js';

/** A resolver with no symlinks. Each path passes through unchanged. */
const identity: RealpathResolver = (p) => p;

/** A Node filesystem error with a POSIX `code`, to simulate a realpath failure. */
function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('isPathWithin', () => {
  /**
   * On macOS, `/var/...` is a symlink to `/private/var/...`. A candidate and a
   * worktree under different forms must match. An injected resolver models the
   * symlink, so the test needs no real filesystem.
   */
  it('PathContainment_MacOSPrivateVarSymlink_Matches', () => {
    const symlinkMap: Record<string, string> = {
      '/var/folders/abc/wt': '/private/var/folders/abc/wt',
      '/var/folders/abc/wt/src/file.ts': '/private/var/folders/abc/wt/src/file.ts',
      '/private/var/folders/abc/wt': '/private/var/folders/abc/wt',
    };
    const symlinkRealpath: RealpathResolver = (p) => symlinkMap[p] ?? p;

    expect(canonicalizeForContainment('/var/folders/abc/wt', symlinkRealpath)).toBe(
      '/private/var/folders/abc/wt',
    );

    expect(
      isPathWithin('/var/folders/abc/wt/src/file.ts', '/var/folders/abc/wt', symlinkRealpath),
    ).toBe(true);

    expect(
      isPathWithin('/var/folders/abc/wt/src/file.ts', '/private/var/folders/abc/wt', symlinkRealpath),
    ).toBe(true);

    expect(
      isPathWithin('/var/folders/abc/wt-sibling/file.ts', '/private/var/folders/abc/wt', symlinkRealpath),
    ).toBe(false);
  });

  /**
   * The test cannot create a real Windows 8.3 short name, so it checks two
   * properties. First, `defaultRealpath` calls `fs.realpathSync.native`, which
   * expands a short name such as `RUNNER~1`. The plain `fs.realpathSync` does
   * not. Second, with an injected expansion, a win32 path with backslashes
   * normalizes to absolute POSIX form, and containment matches across the short
   * and long forms.
   */
  it('PathContainment_Win32ShortName_MatchesViaNativeRealpath', () => {
    const nativeSpy = vi
      .spyOn(fs.realpathSync, 'native')
      .mockImplementation((p) => String(p));
    defaultRealpath('C:/Users/RUNNER~1/wt');
    expect(nativeSpy).toHaveBeenCalledWith('C:/Users/RUNNER~1/wt');
    nativeSpy.mockRestore();

    const expandShort: RealpathResolver = (p) => p.replace('RUNNER~1', 'runneradmin');

    expect(canonicalizeForContainment('C:\\Users\\RUNNER~1\\wt', expandShort)).toBe(
      'C:/Users/runneradmin/wt',
    );

    expect(
      isPathWithin('C:\\Users\\RUNNER~1\\wt\\src\\file.ts', 'C:\\Users\\runneradmin\\wt', expandShort),
    ).toBe(true);
    expect(
      isPathWithin('C:\\Users\\runneradmin\\wt\\src\\file.ts', 'C:\\Users\\RUNNER~1\\wt', expandShort),
    ).toBe(true);

    expect(
      isPathWithin('C:\\Users\\RUNNER~1\\wt-sibling\\file.ts', 'C:\\Users\\runneradmin\\wt', expandShort),
    ).toBe(false);
  });

  /** The string `/a/b` is a prefix of `/a/bc`, but the two paths are siblings. */
  it('rejects a partial-segment sibling (/a/bc is NOT within /a/b)', () => {
    expect(isPathWithin('/a/bc', '/a/b', identity)).toBe(false);
    expect(isPathWithin('/a/b-sibling/x', '/a/b', identity)).toBe(false);
  });

  it('treats the worktree root itself as contained', () => {
    expect(isPathWithin('/a/b', '/a/b', identity)).toBe(true);
  });

  it('accepts a genuinely nested path', () => {
    expect(isPathWithin('/a/b/c/d.ts', '/a/b', identity)).toBe(true);
  });

  it('rejects an outside path that climbs out of the worktree', () => {
    expect(isPathWithin('/a/x/y.ts', '/a/b', identity)).toBe(false);
    expect(isPathWithin('/etc/passwd', '/a/b', identity)).toBe(false);
  });

  /**
   * Uses the default resolver on a real symlink. A candidate through the symlink
   * is within the worktree at the resolved path. If the OS refuses the symlink
   * with `EPERM`, as Windows does without Developer Mode, the test returns early.
   */
  it('defaultRealpath resolves a real symlinked root and matches', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wlm-pathcontain-'));
    try {
      const realRoot = path.join(base, 'real-root');
      const worktree = path.join(realRoot, 'wt');
      fs.mkdirSync(worktree, { recursive: true });
      const candidateFile = path.join(worktree, 'src', 'file.ts');
      fs.mkdirSync(path.dirname(candidateFile), { recursive: true });
      fs.writeFileSync(candidateFile, '// fixture');

      const link = path.join(base, 'link-root');
      try {
        fs.symlinkSync(realRoot, link, 'dir');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
        throw err;
      }

      const candidateViaLink = path.join(link, 'wt', 'src', 'file.ts');
      expect(isPathWithin(candidateViaLink, worktree)).toBe(true);

      expect(defaultRealpath(path.join(link, 'wt'))).toBe(fs.realpathSync.native(worktree));

      const siblingViaLink = path.join(link, 'wt-sibling', 'file.ts');
      expect(isPathWithin(siblingViaLink, worktree)).toBe(false);
    } finally {
      rmrf(base);
    }
  });
});

describe('defaultRealpath error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * On `ENOENT`, the resolver resolves the existing ancestor and appends the
   * missing leaf. The test resolves `realRoot` with `fs.realpathSync.native`, as
   * `defaultRealpath` does. Then a Windows 8.3 short name in the temp root
   * expands the same way on both sides.
   */
  it('DefaultRealpath_EnoentTail_SynthesizesThroughExistingAncestor', () => {
    const realRoot = fs.realpathSync.native(os.tmpdir());
    const missingChild = path.join(realRoot, `wlm-realpath-missing-${process.pid}`, 'leaf');
    expect(defaultRealpath(missingChild)).toBe(missingChild);
  });

  /**
   * An error other than `ENOENT` is a real resolution error, not a path that
   * does not exist yet. A path built past it is not a real path, so the
   * resolver must rethrow.
   */
  it('DefaultRealpath_EloopOrEacces_RethrowsInsteadOfSynthesizing', () => {
    for (const code of ['ELOOP', 'EACCES', 'ENOTDIR'] as const) {
      const spy = vi
        .spyOn(fs.realpathSync, 'native')
        .mockImplementation(() => {
          throw errnoError(code);
        });
      expect(() => defaultRealpath('/some/looping/path')).toThrow(
        new RegExp(code),
      );
      spy.mockRestore();
    }
  });
});
