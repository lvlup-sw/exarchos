import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadExarchosConfig } from './load-exarchos-config.js';

describe('loadExarchosConfig', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exarchos-load-cfg-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('loadConfig_PresentInWorktree_LoadedFromWorktree', () => {
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    const cfgPath = join(worktree, '.exarchos.yml');
    writeFileSync(cfgPath, 'test: bun test\n', 'utf-8');

    const result = loadExarchosConfig(worktree, { findRepoRoot: () => null });
    expect(result).not.toBeNull();
    expect(result?.config.test).toBe('bun test');
    expect(result?.source).toBe(resolve(cfgPath));
  });

  it('loadConfig_AbsentInWorktreePresentInRepoRoot_LoadedFromRepoRoot', () => {
    const repoRoot = join(tmpRoot, 'repo');
    const worktree = join(repoRoot, 'sub', 'wt');
    mkdirSync(worktree, { recursive: true });
    const cfgPath = join(repoRoot, '.exarchos.yml');
    writeFileSync(cfgPath, 'typecheck: tsc --noEmit\n', 'utf-8');

    const result = loadExarchosConfig(worktree, { findRepoRoot: () => repoRoot });
    expect(result).not.toBeNull();
    expect(result?.config.typecheck).toBe('tsc --noEmit');
    expect(result?.source).toBe(resolve(cfgPath));
  });

  it('loadConfig_PresentInBoth_WorktreeWins', () => {
    const repoRoot = join(tmpRoot, 'repo');
    const worktree = join(repoRoot, 'sub', 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repoRoot, '.exarchos.yml'), 'test: repo-test\n', 'utf-8');
    const wtCfgPath = join(worktree, '.exarchos.yml');
    writeFileSync(wtCfgPath, 'test: worktree-test\n', 'utf-8');

    const result = loadExarchosConfig(worktree, { findRepoRoot: () => repoRoot });
    expect(result).not.toBeNull();
    expect(result?.config.test).toBe('worktree-test');
    expect(result?.source).toBe(resolve(wtCfgPath));
  });

  it('loadConfig_AbsentInBoth_ReturnsNull', () => {
    const repoRoot = join(tmpRoot, 'repo');
    const worktree = join(repoRoot, 'sub', 'wt');
    mkdirSync(worktree, { recursive: true });

    const result = loadExarchosConfig(worktree, { findRepoRoot: () => repoRoot });
    expect(result).toBeNull();
  });

  it('loadConfig_WorktreeIsRepoRoot_OnlyChecksOnce', () => {
    const repoRoot = join(tmpRoot, 'repo');
    mkdirSync(repoRoot, { recursive: true });

    let callCount = 0;
    const findRepoRoot = (start: string): string => {
      callCount++;
      return repoRoot;
    };

    // No file anywhere — should return null and not double-attempt the same path.
    const result = loadExarchosConfig(repoRoot, { findRepoRoot });
    expect(result).toBeNull();
    // findRepoRoot can be called at most once. The contract is that the loader
    // does not redundantly read the same path twice when worktree===repoRoot.
    expect(callCount).toBeLessThanOrEqual(1);
  });

  it('loadConfig_MalformedYaml_ThrowsWithPath', () => {
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    const cfgPath = join(worktree, '.exarchos.yml');
    // Unbalanced bracket / bad YAML structure.
    writeFileSync(cfgPath, 'test: [unterminated\n  bad: : :\n', 'utf-8');

    expect(() => loadExarchosConfig(worktree, { findRepoRoot: () => null })).toThrow(
      /Failed to parse \.exarchos\.yml at .*\.exarchos\.yml/,
    );
  });

  it('loadConfig_FailsSchema_ThrowsWithFieldErrors', () => {
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.exarchos.yml'), 'unknown_field: x\n', 'utf-8');

    expect(() => loadExarchosConfig(worktree, { findRepoRoot: () => null })).toThrow(
      /Invalid \.exarchos\.yml at .*unknown_field/,
    );
  });

  it('loadConfig_FailsSchema_UnsafeChars_ThrowsWithReason', () => {
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.exarchos.yml'), "test: 'rm -rf /; pytest'\n", 'utf-8');

    expect(() => loadExarchosConfig(worktree, { findRepoRoot: () => null })).toThrow(
      /Invalid \.exarchos\.yml at .*test.*disallowed shell metacharacters/s,
    );
  });

  it('loadConfig_RepoRootResolutionFails_FallsBackToWorktreeOnly', () => {
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    // No .exarchos.yml in worktree, findRepoRoot returns null.
    const result = loadExarchosConfig(worktree, { findRepoRoot: () => null });
    expect(result).toBeNull();
  });

  it('loadConfig_FieldsParsedCorrectly', () => {
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(worktree, '.exarchos.yml'),
      'test: bun test\ntypecheck: tsc --noEmit\ninstall: bun install\n',
      'utf-8',
    );

    const result = loadExarchosConfig(worktree, { findRepoRoot: () => null });
    expect(result).not.toBeNull();
    expect(result?.config.test).toBe('bun test');
    expect(result?.config.typecheck).toBe('tsc --noEmit');
    expect(result?.config.install).toBe('bun install');
  });
});
