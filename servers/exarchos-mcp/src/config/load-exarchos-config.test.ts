import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadExarchosConfig } from './load-exarchos-config.js';
import { readInvariantsConfig } from '../architecture/invariants-loader.js';

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

  // ─── #1479: reconcile dual config readers ───────────────────────────────
  //
  // `loadExarchosConfig` (strict, ExarchosConfigSchema) and the lenient
  // `readInvariantsConfig` (architecture/invariants-loader.ts) both parse the
  // SAME `.exarchos.yml`. Before reconciliation they diverged: a file with an
  // unknown sibling key threw under the strict reader but silently yielded its
  // invariants block under the lenient one — so a typo'd config could disable
  // governance under one path while passing the other. These tests pin the
  // reconciled contract: both readers reach the same verdict on a given file.

  it('dualReaders_KnownProjectSiblingKey_ValidInvariants_BothAccept', () => {
    // `agents:` is a valid ProjectConfigSchema key — unknown to the bare
    // ExarchosConfigSchema before reconciliation. Both readers must now accept
    // the file and surface the valid invariants block.
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    const cfgPath = join(worktree, '.exarchos.yml');
    writeFileSync(
      cfgPath,
      [
        'agents:',
        '  default-model: opus',
        'invariants:',
        '  devCatalog: enabled',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Strict reader: no throw, invariants block present.
    const strict = loadExarchosConfig(worktree, { findRepoRoot: () => null });
    expect(strict).not.toBeNull();
    expect(strict!.config.invariants?.devCatalog).toBe('enabled');

    // Lenient reader: same verdict — invariants block honored.
    const lenient = readInvariantsConfig(cfgPath);
    expect(lenient.invariants?.devCatalog).toBe('enabled');
  });

  it('dualReaders_UnknownSiblingKey_ValidInvariants_BehaveIdentically', () => {
    // A genuinely-unknown sibling key (typo) is invalid in BOTH schemas. The
    // reconciled contract: the strict reader throws AND the lenient reader does
    // NOT honor the invariants block from the invalid file (returns {}). A
    // typo'd config cannot silently keep governance configuration alive on one
    // path while failing the other.
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    const cfgPath = join(worktree, '.exarchos.yml');
    writeFileSync(
      cfgPath,
      [
        'agentss: oops', // typo'd key — invalid under both schemas
        'invariants:',
        '  devCatalog: enabled',
        '',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadExarchosConfig(worktree, { findRepoRoot: () => null })).toThrow(
      /Invalid \.exarchos\.yml/,
    );

    const lenient = readInvariantsConfig(cfgPath);
    expect(lenient.invariants?.devCatalog).toBeUndefined();
  });

  it('dualReaders_InvalidInvariantsBlock_BehaveIdentically', () => {
    // A malformed invariants block (unknown nested key) must be rejected
    // consistently: the strict reader throws and the lenient reader does not
    // surface a bogus invariants config.
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    const cfgPath = join(worktree, '.exarchos.yml');
    writeFileSync(
      cfgPath,
      ['invariants:', '  devCatalog: enabled', '  bogusKey: true', ''].join('\n'),
      'utf-8',
    );

    expect(() => loadExarchosConfig(worktree, { findRepoRoot: () => null })).toThrow(
      /Invalid \.exarchos\.yml/,
    );

    const lenient = readInvariantsConfig(cfgPath);
    expect(lenient.invariants?.devCatalog).toBeUndefined();
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
