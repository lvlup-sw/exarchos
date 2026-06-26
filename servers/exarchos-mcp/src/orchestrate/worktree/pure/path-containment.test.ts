import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPathWithin, defaultRealpath, type RealpathResolver } from './path-containment.js';

/** Identity resolver: no symlinks, paths pass through unchanged. */
const identity: RealpathResolver = (p) => p;

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
