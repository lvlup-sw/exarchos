import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadExarchosConfig } from '../../../src/config/load-exarchos-config.js';
import { readInvariantsConfig } from '../../../src/architecture/invariants-loader.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The `dualReaders` tests compare the strict `loadExarchosConfig` with the lenient
 * `readInvariantsConfig`. Both read the same `.exarchos.yml` and must give the same verdict,
 * so a typo cannot turn off governance on one path only.
 */
describe('loadExarchosConfig', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exarchos-load-cfg-'));
  });

  afterEach(() => {
    try {
      rmrf(tmpRoot);
    } catch {
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

  /**
   * No config file exists. When the worktree is the repo root, the loader must call
   * `findRepoRoot` one time at most.
   */
  it('loadConfig_WorktreeIsRepoRoot_OnlyChecksOnce', () => {
    const repoRoot = join(tmpRoot, 'repo');
    mkdirSync(repoRoot, { recursive: true });

    let callCount = 0;
    const findRepoRoot = (start: string): string => {
      callCount++;
      return repoRoot;
    };

    const result = loadExarchosConfig(repoRoot, { findRepoRoot });
    expect(result).toBeNull();
    expect(callCount).toBeLessThanOrEqual(1);
  });

  it('loadConfig_MalformedYaml_ThrowsWithPath', () => {
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    const cfgPath = join(worktree, '.exarchos.yml');
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
    const result = loadExarchosConfig(worktree, { findRepoRoot: () => null });
    expect(result).toBeNull();
  });

  /**
   * `agents:` is a valid project key. Both readers accept the file, and both convert the
   * deprecated `devCatalog` alias into the same `catalogs` registration.
   */
  it('dualReaders_KnownProjectSiblingKey_ValidInvariants_BothAccept', () => {
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

    const strict = loadExarchosConfig(worktree, { findRepoRoot: () => null });
    expect(strict).not.toBeNull();
    expect(strict!.config.invariants?.catalogs).toEqual([
      { path: '.exarchos/invariants.md', tier: 'dev' },
    ]);
    expect(strict!.deprecations.map((d) => d.key)).toEqual([
      'invariants.devCatalog',
    ]);

    const lenient = readInvariantsConfig(cfgPath);
    expect(lenient.invariants?.catalogs).toEqual([
      { path: '.exarchos/invariants.md', tier: 'dev' },
    ]);
  });

  /**
   * `agentss` is a typo, so the file is invalid. The strict reader throws, and the lenient
   * reader returns no `invariants` block at all. The control file without the typo shows
   * that the typo causes the empty result.
   */
  it('dualReaders_UnknownSiblingKey_ValidInvariants_BehaveIdentically', () => {
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    const cfgPath = join(worktree, '.exarchos.yml');
    writeFileSync(
      cfgPath,
      [
        'agentss: oops',
        'invariants:',
        '  catalogs:',
        '    - ./team.md',
        '',
      ].join('\n'),
      'utf-8',
    );

    expect(() => loadExarchosConfig(worktree, { findRepoRoot: () => null })).toThrow(
      /Invalid \.exarchos\.yml/,
    );

    const lenient = readInvariantsConfig(cfgPath);
    expect(lenient.invariants).toBeUndefined();

    const okPath = join(worktree, 'ok', '.exarchos.yml');
    mkdirSync(join(worktree, 'ok'), { recursive: true });
    writeFileSync(
      okPath,
      ['invariants:', '  catalogs:', '    - ./team.md', ''].join('\n'),
      'utf-8',
    );
    expect(readInvariantsConfig(okPath).invariants?.catalogs).toEqual(['./team.md']);
  });

  /**
   * An unknown nested key makes the `invariants` block invalid for both readers. The control
   * file without the key shows that the key causes the empty result.
   */
  it('dualReaders_InvalidInvariantsBlock_BehaveIdentically', () => {
    const worktree = join(tmpRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    const cfgPath = join(worktree, '.exarchos.yml');
    writeFileSync(
      cfgPath,
      ['invariants:', '  catalogs: []', '  bogusKey: true', ''].join('\n'),
      'utf-8',
    );

    expect(() => loadExarchosConfig(worktree, { findRepoRoot: () => null })).toThrow(
      /Invalid \.exarchos\.yml/,
    );

    const lenient = readInvariantsConfig(cfgPath);
    expect(lenient.invariants).toBeUndefined();

    const okPath = join(worktree, 'ok2', '.exarchos.yml');
    mkdirSync(join(worktree, 'ok2'), { recursive: true });
    writeFileSync(
      okPath,
      ['invariants:', '  catalogs: []', ''].join('\n'),
      'utf-8',
    );
    expect(readInvariantsConfig(okPath).invariants?.catalogs).toEqual([]);
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
