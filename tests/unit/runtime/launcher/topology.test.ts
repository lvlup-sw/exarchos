import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deriveWorktreePath,
  guardWorktreeContainment,
  type RealpathResolver,
  type WorktreePathGuardResult,
} from '../../../../src/runtime/launcher/topology.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/** An identity resolver. It models a filesystem with no symlinks. */
const identity: RealpathResolver = (p) => p;

describe('deriveWorktreePath', () => {
  /** The derived path has the same parent directory as the base, and the guard accepts it as a sibling. */
  it('Derive_SiblingOffBase_Path', () => {
    const base = '/repo/.worktrees/agent-a';
    const derived = deriveWorktreePath(base, 'agent-b');

    expect(derived).toBe('/repo/.worktrees/agent-b');
    expect(path.posix.dirname(derived)).toBe(path.posix.dirname(base));

    const guarded = guardWorktreeContainment(base, derived, identity);
    expect(guarded).toEqual<WorktreePathGuardResult>({
      ok: true,
      path: '/repo/.worktrees/agent-b',
    });
  });

  /** The base does not exist on disk, and the function still derives the sibling path. */
  it('is a pure string transform with no filesystem access', () => {
    const derived = deriveWorktreePath('/nonexistent/root/wt-a', 'wt-b');
    expect(derived).toBe('/nonexistent/root/wt-b');
  });

  it('refuses a multi-segment or traversal id (cannot escape one level)', () => {
    expect(() => deriveWorktreePath('/repo/.worktrees/wt-a', 'a/b')).toThrow(RangeError);
    expect(() => deriveWorktreePath('/repo/.worktrees/wt-a', '..')).toThrow(RangeError);
    expect(() => deriveWorktreePath('/repo/.worktrees/wt-a', '')).toThrow(RangeError);
    expect(() => deriveWorktreePath('/repo/.worktrees/wt-a', 'a\\b')).toThrow(RangeError);
  });
});

describe('guardWorktreeContainment', () => {
  /** The refusal carries the reason, the supplied base and target, and a message. */
  it('Guard_NestedTarget_Refused', () => {
    const base = '/repo/.worktrees/agent-a';
    const nested = '/repo/.worktrees/agent-a/child';

    const result = guardWorktreeContainment(base, nested, identity);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('nested-inside-base');
    expect(result.base).toBe(base);
    expect(result.target).toBe(nested);
    expect(result.message).toMatch(/nest inside/);
  });

  it('refuses the base worktree itself (equal path is not a sibling)', () => {
    const base = '/repo/.worktrees/agent-a';
    const result = guardWorktreeContainment(base, base, identity);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('nested-inside-base');
  });

  /** The target `agent-b/sub` is below the shared parent directory, but it is two levels deep. */
  it('refuses a target nested inside a sibling worktree (deeper than one level)', () => {
    const base = '/repo/.worktrees/agent-a';
    const result = guardWorktreeContainment(base, '/repo/.worktrees/agent-b/sub', identity);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('escapes-containment');
  });

  it('refuses a target that climbs out of the base parent directory', () => {
    const base = '/repo/.worktrees/agent-a';
    const result = guardWorktreeContainment(base, '/repo/elsewhere/agent-b', identity);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('escapes-containment');
  });

  /**
   * The base path is a string prefix of the target path `agent-abc`.
   * The two are different siblings, so the guard accepts the target.
   */
  it('refuses a partial-segment sibling of the base (startsWith false-positive)', () => {
    const base = '/repo/.worktrees/agent-a';
    const accepted = guardWorktreeContainment(base, '/repo/.worktrees/agent-abc', identity);
    expect(accepted.ok).toBe(true);
  });

  /**
   * The resolver models the macOS symlink from `/var` to `/private/var`.
   * The base has the canonical form, and the nested target goes through the symlink.
   */
  it('resolves symlinks on both sides before deciding containment', () => {
    const symlinkMap: Record<string, string> = {
      '/var/wt/agent-a': '/private/var/wt/agent-a',
      '/var/wt/agent-a/child': '/private/var/wt/agent-a/child',
    };
    const symlinkRealpath: RealpathResolver = (p) => symlinkMap[p] ?? p;

    const result = guardWorktreeContainment(
      '/private/var/wt/agent-a',
      '/var/wt/agent-a/child',
      symlinkRealpath,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('nested-inside-base');
  });
});

describe('win32 containment (DR-8 win32-fragile surface)', () => {
  /**
   * The first part runs on each host OS with the identity resolver, so it reads no filesystem.
   * A win32-style base (drive letter, backslashes) gives a POSIX-normalized sibling.
   * The guard accepts that sibling and refuses the nested backslash targets.
   * The second part runs only on Windows. It uses the default resolver on real directories,
   * because that resolver expands 8.3 short names.
   */
  it('Derive_Win32Path_ContainmentHolds', () => {
    const win32Base = 'C:\\repo\\.worktrees\\agent-a';

    const derived = deriveWorktreePath(win32Base, 'agent-b');
    expect(derived).toBe('C:/repo/.worktrees/agent-b');

    const sibling = guardWorktreeContainment(win32Base, derived, identity);
    expect(sibling.ok).toBe(true);
    if (!sibling.ok) throw new Error('expected acceptance');
    expect(sibling.path).toBe('C:/repo/.worktrees/agent-b');

    const nested = guardWorktreeContainment(win32Base, 'C:\\repo\\.worktrees\\agent-a\\child', identity);
    expect(nested.ok).toBe(false);
    if (nested.ok) throw new Error('expected refusal');
    expect(nested.reason).toBe('nested-inside-base');

    const deep = guardWorktreeContainment(win32Base, 'C:\\repo\\.worktrees\\agent-b\\sub', identity);
    expect(deep.ok).toBe(false);
    if (deep.ok) throw new Error('expected refusal');
    expect(deep.reason).toBe('escapes-containment');

    if (process.platform === 'win32') {
      const parent = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), 'topology-win32-')),
      );
      try {
        const baseWt = path.join(parent, 'agent-a');
        const siblingWt = path.join(parent, 'agent-b');
        const nestedTarget = path.join(baseWt, 'child');
        fs.mkdirSync(baseWt, { recursive: true });
        fs.mkdirSync(siblingWt, { recursive: true });

        expect(guardWorktreeContainment(baseWt, siblingWt).ok).toBe(true);
        const nestedReal = guardWorktreeContainment(baseWt, nestedTarget);
        expect(nestedReal.ok).toBe(false);

        const derivedReal = deriveWorktreePath(baseWt, 'agent-b');
        expect(guardWorktreeContainment(baseWt, derivedReal).ok).toBe(true);
      } finally {
        rmrf(parent);
      }
    }
  });
});
