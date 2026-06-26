import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPathWithin, defaultRealpath, type RealpathResolver } from './path-containment.js';

/** Identity resolver: no symlinks, paths pass through unchanged. */
const identity: RealpathResolver = (p) => p;

/** A Node fs error carrying a POSIX `code`, for simulating realpath failures. */
function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('isPathWithin', () => {
  it('PathContainment_SymlinkedRoot_ResolvesRealpathAndMatches', () => {
    // Model macOS's /var -> /private/var symlink: the worktree is recorded
    // under one form and the candidate under another. Resolving symlinks on
    // BOTH sides must canonicalize them to the same root and match.
    const symlinkMap: Record<string, string> = {
      '/var/folders/abc/wt': '/private/var/folders/abc/wt',
      '/var/folders/abc/wt/src/file.ts': '/private/var/folders/abc/wt/src/file.ts',
      '/private/var/folders/abc/wt': '/private/var/folders/abc/wt',
    };
    const symlinkRealpath: RealpathResolver = (p) => symlinkMap[p] ?? p;

    // Candidate under the symlinked /var form, worktree under /var form.
    expect(
      isPathWithin('/var/folders/abc/wt/src/file.ts', '/var/folders/abc/wt', symlinkRealpath),
    ).toBe(true);

    // Candidate under the symlinked form, worktree recorded under the canonical
    // /private/var form — both-sides resolution still matches.
    expect(
      isPathWithin(
        '/var/folders/abc/wt/src/file.ts',
        '/private/var/folders/abc/wt',
        symlinkRealpath,
      ),
    ).toBe(true);
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

  it.skipIf(process.platform === 'win32')(
    'defaultRealpath resolves a real symlinked root and matches',
    () => {
      // Exercise the *default* resolver against a real symlink: a candidate
      // addressed through the symlink must be judged within the worktree
      // addressed through the canonical (resolved) directory.
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wlm-pathcontain-'));
      try {
        const realRoot = path.join(base, 'real-root');
        const worktree = path.join(realRoot, 'wt');
        fs.mkdirSync(worktree, { recursive: true });
        const candidateFile = path.join(worktree, 'src', 'file.ts');
        fs.mkdirSync(path.dirname(candidateFile), { recursive: true });
        fs.writeFileSync(candidateFile, '// fixture');

        const link = path.join(base, 'link-root');
        fs.symlinkSync(realRoot, link, 'dir');

        // Candidate addressed via the symlink; worktree via the real path.
        const candidateViaLink = path.join(link, 'wt', 'src', 'file.ts');
        expect(isPathWithin(candidateViaLink, worktree)).toBe(true);

        // Sanity: defaultRealpath actually collapses the symlink.
        expect(defaultRealpath(path.join(link, 'wt'))).toBe(fs.realpathSync(worktree));

        // A sibling of the worktree, addressed via the symlink, is NOT within.
        const siblingViaLink = path.join(link, 'wt-sibling', 'file.ts');
        expect(isPathWithin(siblingViaLink, worktree)).toBe(false);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );
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
