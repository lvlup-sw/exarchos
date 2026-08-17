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

/** Identity resolver: no symlinks, paths pass through unchanged. */
const identity: RealpathResolver = (p) => p;

/** A Node fs error carrying a POSIX `code`, for simulating realpath failures. */
function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('isPathWithin', () => {
  it('PathContainment_MacOSPrivateVarSymlink_Matches', () => {
    // macOS's per-user temp/worktree root `/var/...` is a symlink to
    // `/private/var/...`. A candidate reported under one form and a worktree
    // recorded under the other must canonicalize to the same root and match.
    // Model the symlink with an injected resolver (no real FS, deterministic on
    // every platform incl. the Linux-only CI).
    const symlinkMap: Record<string, string> = {
      '/var/folders/abc/wt': '/private/var/folders/abc/wt',
      '/var/folders/abc/wt/src/file.ts': '/private/var/folders/abc/wt/src/file.ts',
      '/private/var/folders/abc/wt': '/private/var/folders/abc/wt',
    };
    const symlinkRealpath: RealpathResolver = (p) => symlinkMap[p] ?? p;

    // The canonicalizer collapses the `/var` symlink to its `/private/var` form.
    expect(canonicalizeForContainment('/var/folders/abc/wt', symlinkRealpath)).toBe(
      '/private/var/folders/abc/wt',
    );

    // Candidate under the symlinked `/var` form, worktree under the `/var` form.
    expect(
      isPathWithin('/var/folders/abc/wt/src/file.ts', '/var/folders/abc/wt', symlinkRealpath),
    ).toBe(true);

    // Candidate under the symlinked form, worktree recorded under the canonical
    // `/private/var` form — both-sides resolution still matches.
    expect(
      isPathWithin('/var/folders/abc/wt/src/file.ts', '/private/var/folders/abc/wt', symlinkRealpath),
    ).toBe(true);

    // A sibling under the symlinked root is NOT contained.
    expect(
      isPathWithin('/var/folders/abc/wt-sibling/file.ts', '/private/var/folders/abc/wt', symlinkRealpath),
    ).toBe(false);
  });

  it('PathContainment_Win32ShortName_MatchesViaNativeRealpath', () => {
    // Shape-based Windows coverage: CI is Linux-only, so we cannot mint a real
    // 8.3 SHORT name. Instead validate the two properties that make win32
    // containment correct, without a real Windows host.
    //
    // (a) The default containment resolver routes through `fs.realpathSync.native`
    //     — the ONLY API that expands Windows 8.3 short names (`RUNNER~1` →
    //     `runneradmin`). The plain JS `fs.realpathSync` leaves them un-expanded.
    const nativeSpy = vi
      .spyOn(fs.realpathSync, 'native')
      .mockImplementation((p) => String(p));
    defaultRealpath('C:/Users/RUNNER~1/wt');
    expect(nativeSpy).toHaveBeenCalledWith('C:/Users/RUNNER~1/wt');
    nativeSpy.mockRestore();

    // (b) Model the 8.3 → long-form expansion the OS's native realpath performs
    //     and prove the canonicalizer + containment collapse the short/long
    //     divide. `\`-separated win32 inputs are normalized to absolute POSIX
    //     even when the test runs on Linux (a win32 `path.resolve` would prepend
    //     the Linux cwd and never match the injected resolver).
    const expandShort: RealpathResolver = (p) => p.replace('RUNNER~1', 'runneradmin');

    // The canonicalizer expands the 8.3 short name to its long form.
    expect(canonicalizeForContainment('C:\\Users\\RUNNER~1\\wt', expandShort)).toBe(
      'C:/Users/runneradmin/wt',
    );

    // A candidate addressed via the 8.3 short name is within the worktree
    // recorded under the long form (and vice-versa is covered by both-sides
    // canonicalization).
    expect(
      isPathWithin('C:\\Users\\RUNNER~1\\wt\\src\\file.ts', 'C:\\Users\\runneradmin\\wt', expandShort),
    ).toBe(true);
    expect(
      isPathWithin('C:\\Users\\runneradmin\\wt\\src\\file.ts', 'C:\\Users\\RUNNER~1\\wt', expandShort),
    ).toBe(true);

    // A sibling under the 8.3-short root is NOT contained (no startsWith
    // false-positive across the short/long divide).
    expect(
      isPathWithin('C:\\Users\\RUNNER~1\\wt-sibling\\file.ts', 'C:\\Users\\runneradmin\\wt', expandShort),
    ).toBe(false);
  });

  it('rejects a partial-segment sibling (/a/bc is NOT within /a/b)', () => {
    // The classic startsWith false-positive: '/a/b' is a string prefix of
    // '/a/bc' but they are siblings, not parent/child.
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

  it('defaultRealpath resolves a real symlinked root and matches', () => {
    // Exercise the *default* resolver against a real symlink: a candidate
    // addressed through the symlink must be judged within the worktree addressed
    // through the canonical (resolved) directory. Cross-platform — symlink
    // creation is capability-guarded (Windows without Developer Mode throws
    // EPERM) rather than platform-skipped, so the assertion runs wherever the OS
    // supports symlinks and no-ops elsewhere.
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
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return; // no symlink privilege
        throw err;
      }

      // Candidate addressed via the symlink; worktree via the real path.
      const candidateViaLink = path.join(link, 'wt', 'src', 'file.ts');
      expect(isPathWithin(candidateViaLink, worktree)).toBe(true);

      // Sanity: defaultRealpath actually collapses the symlink.
      expect(defaultRealpath(path.join(link, 'wt'))).toBe(fs.realpathSync.native(worktree));

      // A sibling of the worktree, addressed via the symlink, is NOT within.
      const siblingViaLink = path.join(link, 'wt-sibling', 'file.ts');
      expect(isPathWithin(siblingViaLink, worktree)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('defaultRealpath error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DefaultRealpath_EnoentTail_SynthesizesThroughExistingAncestor', () => {
    // ENOENT (the tail does not exist yet) is the ONE tolerated failure: resolve
    // the existing ancestor and re-append the missing leaf, so a brand-new path
    // still canonicalizes instead of throwing.
    //
    // Canonicalize the ancestor with `.native` — the SAME resolver `defaultRealpath`
    // uses (path-containment.ts) — so `realRoot` is a fixed point of the function
    // under test. The plain `fs.realpathSync` leaves Windows 8.3 short names
    // un-expanded (CI temp root is `C:\Users\RUNNER~1\...`), but `defaultRealpath`
    // expands them to long form (`runneradmin`); using it here keeps the assertion
    // focused on missing-tail synthesis instead of failing on ancestor expansion.
    const realRoot = fs.realpathSync.native(os.tmpdir());
    const missingChild = path.join(realRoot, `wlm-realpath-missing-${process.pid}`, 'leaf');
    // The tail does not exist → defaultRealpath synthesizes it onto the resolved
    // ancestor rather than throwing.
    expect(defaultRealpath(missingChild)).toBe(missingChild);
  });

  it('DefaultRealpath_EloopOrEacces_RethrowsInsteadOfSynthesizing', () => {
    // A non-ENOENT failure (ELOOP symlink cycle, EACCES permission denied, …) is
    // a GENUINE resolution error, not a "not yet created" path. Synthesizing past
    // it would fabricate a canonical path no real lookup produces (e.g. resolving
    // *through* a symlink loop), so the resolver must fail closed and rethrow.
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
