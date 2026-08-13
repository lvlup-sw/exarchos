import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  resolveWorktreeBaseRef,
  assertWorktreeBaseRefPinned,
} from '../../../../src/verbs/team/worktree-baseref.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CWD = '/repo';
const HOME = '/home/u';

const PROJECT = path.join(CWD, '.claude', 'settings.json');
const LOCAL = path.join(CWD, '.claude', 'settings.local.json');
const USER = path.join(HOME, '.claude', 'settings.json');

/** Build an injectable reader from a path→contents map; missing paths → null. */
function reader(files: Record<string, string>): (p: string) => string | null {
  return (p: string) => (p in files ? files[p]! : null);
}

const headSettings = JSON.stringify({ worktree: { baseRef: 'head' } });
const freshSettings = JSON.stringify({ worktree: { baseRef: 'fresh' } });

// ─── resolveWorktreeBaseRef ─────────────────────────────────────────────────

describe('resolveWorktreeBaseRef', () => {
  it('resolves "head" from the project .claude/settings.json', () => {
    const result = resolveWorktreeBaseRef({
      cwd: CWD,
      home: HOME,
      readFile: reader({ [PROJECT]: headSettings }),
    });
    expect(result.effective).toBe('head');
    expect(result.source).toBe(PROJECT);
  });

  it('returns null when baseRef is unset across the whole cascade', () => {
    const result = resolveWorktreeBaseRef({
      cwd: CWD,
      home: HOME,
      readFile: reader({ [PROJECT]: JSON.stringify({ permissions: {} }) }),
    });
    expect(result.effective).toBeNull();
    expect(result.source).toBeUndefined();
  });

  it('lists the inspected files in precedence order (local > project > user)', () => {
    const result = resolveWorktreeBaseRef({
      cwd: CWD,
      home: HOME,
      readFile: reader({}),
    });
    expect(result.checked).toEqual([LOCAL, PROJECT, USER]);
  });

  it('lets settings.local.json override the project settings', () => {
    const result = resolveWorktreeBaseRef({
      cwd: CWD,
      home: HOME,
      readFile: reader({ [LOCAL]: freshSettings, [PROJECT]: headSettings }),
    });
    expect(result.effective).toBe('fresh');
    expect(result.source).toBe(LOCAL);
  });

  it('falls back to the user-level settings when project files are absent', () => {
    const result = resolveWorktreeBaseRef({
      cwd: CWD,
      home: HOME,
      readFile: reader({ [USER]: headSettings }),
    });
    expect(result.effective).toBe('head');
    expect(result.source).toBe(USER);
  });

  it('skips a malformed settings file and falls through to the next', () => {
    const result = resolveWorktreeBaseRef({
      cwd: CWD,
      home: HOME,
      readFile: reader({ [LOCAL]: '{ not valid json', [PROJECT]: headSettings }),
    });
    expect(result.effective).toBe('head');
    expect(result.source).toBe(PROJECT);
  });

  it('treats all-malformed settings as unset (fail-closed, no throw)', () => {
    const result = resolveWorktreeBaseRef({
      cwd: CWD,
      home: HOME,
      readFile: reader({ [LOCAL]: '}{', [PROJECT]: 'nope', [USER]: '[1,2' }),
    });
    expect(result.effective).toBeNull();
  });

  it('ignores a non-enum baseRef value', () => {
    const result = resolveWorktreeBaseRef({
      cwd: CWD,
      home: HOME,
      readFile: reader({ [PROJECT]: JSON.stringify({ worktree: { baseRef: 'origin/main' } }) }),
    });
    expect(result.effective).toBeNull();
  });
});

// ─── assertWorktreeBaseRefPinned ────────────────────────────────────────────

describe('assertWorktreeBaseRefPinned', () => {
  it('passes when baseRef is pinned to "head"', () => {
    const result = assertWorktreeBaseRefPinned({
      cwd: CWD,
      home: HOME,
      readFile: reader({ [PROJECT]: headSettings }),
    });
    expect(result.pinned).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.remediation).toBeUndefined();
  });

  it('blocks with remediation when baseRef is unset', () => {
    const result = assertWorktreeBaseRefPinned({
      cwd: CWD,
      home: HOME,
      readFile: reader({}),
    });
    expect(result.pinned).toBe(false);
    expect(result.reason).toBe('worktree-baseref-unset');
    expect(result.remediation).toEqual({
      file: '.claude/settings.json',
      patch: { worktree: { baseRef: 'head' } },
    });
    expect(result.hint).toMatch(/baseRef/);
  });

  it('blocks when baseRef is "fresh" (worktrees would still branch from origin/HEAD)', () => {
    const result = assertWorktreeBaseRefPinned({
      cwd: CWD,
      home: HOME,
      readFile: reader({ [PROJECT]: freshSettings }),
    });
    expect(result.pinned).toBe(false);
    expect(result.reason).toBe('worktree-baseref-unset');
    expect(result.effective).toBe('fresh');
  });
});
