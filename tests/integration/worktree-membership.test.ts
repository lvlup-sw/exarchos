// ─── Worktree membership agrees with git (real repository) ───────────────────
//
// The unit suite stubs `git rev-parse`. This one runs the gate against a real
// repository with a real linked worktree, because the defect it replaced was
// precisely a predicate that looked right and disagreed with git: a
// `.worktrees/` substring test, which reports "not in a worktree" from inside
// the harness-native `.claude/worktrees/` layout.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleVerifyWorktree } from '../../src/verbs/gates/verify-worktree.js';

const STATE_DIR = join(tmpdir(), 'exarchos-verify-worktree-state');

let root = '';
let mainCheckout = '';
let harnessWorktree = '';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function verdictFor(dir: string): Promise<boolean> {
  const result = await handleVerifyWorktree({ cwd: dir }, STATE_DIR);
  expect(result.success).toBe(true);
  return (result.data as { passed: boolean }).passed;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'exarchos-worktree-'));
  mainCheckout = join(root, 'repo');
  mkdirSync(mainCheckout);

  git(mainCheckout, ['init', '-b', 'main']);
  git(mainCheckout, ['config', 'user.email', 'test@example.com']);
  git(mainCheckout, ['config', 'user.name', 'Exarchos Test']);
  writeFileSync(join(mainCheckout, 'README.md'), '# fixture\n');
  git(mainCheckout, ['add', 'README.md']);
  git(mainCheckout, ['commit', '-m', 'initial']);

  // The harness's own layout, nested two levels under a dot-directory.
  harnessWorktree = join(mainCheckout, '.claude', 'worktrees', 'feature-x');
  git(mainCheckout, ['worktree', 'add', '-b', 'feature-x', harnessWorktree]);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('verify_worktree against a real repository', () => {
  it('ClaudeWorktreesLayout_IsRecognized', async () => {
    // The retired predicate tested for a `.worktrees/` substring, which this
    // path does not contain.
    expect(harnessWorktree.replace(/\\/g, '/').includes('.worktrees/')).toBe(false);

    await expect(verdictFor(harnessWorktree)).resolves.toBe(true);
  });

  it('MainCheckout_IsNotAWorktree', async () => {
    await expect(verdictFor(mainCheckout)).resolves.toBe(false);
  });

  it('MembershipComesFromGit_NotASubstring', async () => {
    // `git worktree list --porcelain` is the authority: its first block is the
    // main worktree, every later block a linked one. The gate must agree with
    // that partition for every path git names, whatever the paths are spelled.
    const listed = git(mainCheckout, ['worktree', 'list', '--porcelain'])
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim());

    expect(listed.length).toBeGreaterThan(1);
    const [primary, ...linked] = listed;
    if (primary === undefined) throw new Error('git listed no worktrees');

    await expect(verdictFor(primary)).resolves.toBe(false);
    for (const path of linked) {
      await expect(verdictFor(path)).resolves.toBe(true);
    }
  });

  it('DirectoryOutsideAnyRepository_IsNotAWorktree', async () => {
    const loose = join(root, 'loose');
    mkdirSync(loose);

    await expect(verdictFor(loose)).resolves.toBe(false);
  });
});
