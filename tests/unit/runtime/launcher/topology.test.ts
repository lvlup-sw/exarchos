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

/** Identity resolver: no symlinks, paths pass through unchanged (POSIX-keyed). */
const identity: RealpathResolver = (p) => p;

describe('deriveWorktreePath', () => {
  it('Derive_SiblingOffBase_Path', () => {
    const base = '/repo/.worktrees/agent-a';
    const derived = deriveWorktreePath(base, 'agent-b');

    // It is a sibling: same parent directory as the base, one level deep.
    expect(derived).toBe('/repo/.worktrees/agent-b');
    expect(path.posix.dirname(derived)).toBe(path.posix.dirname(base));

    // It is NOT nested inside the base worktree, and the guard confirms it is a
    // legal sibling (the derivation + guard compose cleanly).
    const guarded = guardWorktreeContainment(base, derived, identity);
    expect(guarded).toEqual<WorktreePathGuardResult>({
      ok: true,
      path: '/repo/.worktrees/agent-b',
    });
  });

  it('is a pure string transform with no filesystem access', () => {
    // A base that does not exist on disk still derives — proving no realpath/stat.
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
  it('Guard_NestedTarget_Refused', () => {
    const base = '/repo/.worktrees/agent-a';
    // A target that lives INSIDE the base worktree must be refused structurally.
    const nested = '/repo/.worktrees/agent-a/child';

    const result = guardWorktreeContainment(base, nested, identity);
    expect(result.ok).toBe(false);
    // Narrow to the refusal shape and assert the structured error contents.
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

  it('refuses a target nested inside a sibling worktree (deeper than one level)', () => {
    const base = '/repo/.worktrees/agent-a';
    // `agent-b/sub` is under the shared parent but two levels deep — nested
    // inside sibling `agent-b`, which the topology forbids.
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

  it('refuses a partial-segment sibling of the base (startsWith false-positive)', () => {
    // `/repo/.worktrees/agent-a` is a string prefix of `/repo/.worktrees/agent-abc`
    // but they are distinct siblings — that one is accepted, while a *nested*
    // partial-prefix path is not confused for containment.
    const base = '/repo/.worktrees/agent-a';
    const accepted = guardWorktreeContainment(base, '/repo/.worktrees/agent-abc', identity);
    expect(accepted.ok).toBe(true);
  });

  it('resolves symlinks on both sides before deciding containment', () => {
    // Model macOS /var -> /private/var: the base is recorded under the canonical
    // form and the target addressed through the symlink. Both-sides realpath must
    // canonicalize them so the nested target is still caught.
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
  it('Derive_Win32Path_ContainmentHolds', () => {
    // --- Cross-platform: assert the toPosix-NORMALIZED containment logic holds
    //     for a win32-STYLE path (backslashes, drive letter) on ANY host OS. The
    //     win32 base is parsed with win32 rules regardless of the running OS, and
    //     the derived sibling is emitted POSIX-normalized. An identity resolver
    //     keeps the decision deterministic (no real fs).
    const win32Base = 'C:\\repo\\.worktrees\\agent-a';

    const derived = deriveWorktreePath(win32Base, 'agent-b');
    // Derivation is POSIX-normalized even from a backslash base (#1620).
    expect(derived).toBe('C:/repo/.worktrees/agent-b');

    // The sibling is accepted; both mixed-separator forms canonicalize identically.
    const sibling = guardWorktreeContainment(win32Base, derived, identity);
    expect(sibling.ok).toBe(true);
    if (!sibling.ok) throw new Error('expected acceptance');
    expect(sibling.path).toBe('C:/repo/.worktrees/agent-b');

    // A win32 target nested inside the base (backslashes) is still refused — the
    // containment check is separator-agnostic after normalization.
    const nested = guardWorktreeContainment(win32Base, 'C:\\repo\\.worktrees\\agent-a\\child', identity);
    expect(nested.ok).toBe(false);
    if (nested.ok) throw new Error('expected refusal');
    expect(nested.reason).toBe('nested-inside-base');

    // A win32 target nested inside a SIBLING worktree escapes containment.
    const deep = guardWorktreeContainment(win32Base, 'C:\\repo\\.worktrees\\agent-b\\sub', identity);
    expect(deep.ok).toBe(false);
    if (deep.ok) throw new Error('expected refusal');
    expect(deep.reason).toBe('escapes-containment');

    // --- OS-native: on real Windows, exercise the DEFAULT realpath (real
    //     `fs.realpathSync.native`, which expands 8.3 short names) against real
    //     directories so containment survives 8.3/long-form divergence. Skipped
    //     off win32 where 8.3 short names and win32 fs semantics do not exist.
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

        // Default realpath: the real sibling is accepted, the nested target refused.
        expect(guardWorktreeContainment(baseWt, siblingWt).ok).toBe(true);
        const nestedReal = guardWorktreeContainment(baseWt, nestedTarget);
        expect(nestedReal.ok).toBe(false);

        // Derivation off the real win32 base yields the real sibling (POSIX-normalized).
        const derivedReal = deriveWorktreePath(baseWt, 'agent-b');
        expect(guardWorktreeContainment(baseWt, derivedReal).ok).toBe(true);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    }
  });
});
