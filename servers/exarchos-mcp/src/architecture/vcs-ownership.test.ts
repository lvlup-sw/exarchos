import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditVcsOwnership,
  runVcsOwnershipCensus,
  detectVcsMutationSites,
  scanVcsMutationSites,
  stripComments,
  isScannableFile,
  VCS_MUTATION_OWNERS,
  type VcsMutationSite,
} from './vcs-ownership.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('detectVcsMutationSites', () => {
  it('detects worktree add / worktree remove / branch delete argument vectors', () => {
    const sites = detectVcsMutationSites(
      'x/y.ts',
      `gitRunner.run(['worktree', 'add', p, b], root);
       gitRunner.run(['worktree', 'remove', '--force', p], root);
       gitRunner.run(['branch', '-D', name], root);`,
    );
    expect(sites.map((s) => s.mutation).sort()).toEqual([
      'branch.delete',
      'worktree.add',
      'worktree.remove',
    ]);
  });

  it('does NOT count a mutation that appears only in a comment', () => {
    const sites = detectVcsMutationSites(
      'x/y.ts',
      `// runs ['worktree', 'add', ...] under the hood\n/* ['branch', '-D'] */\nexport const y = 1;`,
    );
    expect(sites).toHaveLength(0);
  });

  it('does NOT count a git read (worktree list) as a mutation', () => {
    const sites = detectVcsMutationSites(
      'x/y.ts',
      `gitRunner.run(['worktree', 'list', '--porcelain'], root);
       gitRunner.run(['branch', '--show-current'], root);`,
    );
    expect(sites).toHaveLength(0);
  });

  it('matches either quote style but not a mismatched pair', () => {
    expect(detectVcsMutationSites('a.ts', `run(["worktree", "add"])`)).toHaveLength(1);
    expect(detectVcsMutationSites('a.ts', "run(['worktree', 'add'])")).toHaveLength(1);
  });
});

describe('stripComments', () => {
  it('removes line + block comments but preserves string-literal content', () => {
    const out = stripComments(
      `const a = 'worktree'; // 'branch', '-D'\n/* 'worktree', 'remove' */ const b = "add";`,
    );
    expect(out).toContain("'worktree'");
    expect(out).toContain('"add"');
    expect(out).not.toContain('-D');
    expect(out).not.toContain('remove');
  });
});

describe('runVcsOwnershipCensus — verdict logic', () => {
  const owners = ['vcs/mutation-owner.ts'];

  it('flags a mutation site no owner claims as DIRECT_VCS_BYPASS', () => {
    const sites: VcsMutationSite[] = [
      { module: 'vcs/mutation-owner.ts', mutation: 'worktree.add', evidence: "'worktree', 'add'" },
      { module: 'verbs/rogue.ts', mutation: 'worktree.add', evidence: "'worktree', 'add'" },
    ];
    const result = runVcsOwnershipCensus(sites, owners);
    expect(result.ok).toBe(false);
    const bypass = result.diagnostics.find((d) => d.code === 'DIRECT_VCS_BYPASS');
    expect(bypass && 'module' in bypass && bypass.module).toBe('verbs/rogue.ts');
  });

  it('flags an owner that claims nothing as STALE_VCS_OWNER', () => {
    const result = runVcsOwnershipCensus([], owners);
    expect(result.diagnostics.map((d) => d.code)).toContain('STALE_VCS_OWNER');
  });

  it('passes when every site is owned and every owner claims a site', () => {
    const sites: VcsMutationSite[] = [
      { module: 'vcs/mutation-owner.ts', mutation: 'worktree.add', evidence: "'worktree', 'add'" },
    ];
    expect(runVcsOwnershipCensus(sites, owners).ok).toBe(true);
  });
});

describe('EXIT PROOF — live VCS-ownership census', () => {
  it('(a) the live shipped source has ZERO direct bypasses and no stale owner', async () => {
    const result = await auditVcsOwnership(SRC_ROOT);
    // Surfacing the diagnostics array makes any regression self-describing.
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.siteCount).toBeGreaterThan(0);
  });

  it('(a) a planted direct bypass in a non-owner module FAILS the census against the live sites', async () => {
    const sites = await scanVcsMutationSites(SRC_ROOT);
    const planted: VcsMutationSite = {
      module: 'verbs/rogue-bypass.ts',
      mutation: 'worktree.add',
      evidence: "'worktree', 'add'",
    };
    const result = runVcsOwnershipCensus([...sites, planted], VCS_MUTATION_OWNERS);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) =>
          d.code === 'DIRECT_VCS_BYPASS' &&
          'module' in d &&
          d.module === 'verbs/rogue-bypass.ts',
      ),
    ).toBe(true);
  });

  it('every declared owner corresponds to a real module path present in the scan root', async () => {
    const sites = await scanVcsMutationSites(SRC_ROOT);
    const liveModules = new Set(sites.map((s) => s.module));
    // Each declared owner must have at least one live mutation site — otherwise
    // the STALE_VCS_OWNER ratchet would (correctly) trip in the live audit.
    for (const owner of VCS_MUTATION_OWNERS) {
      expect(liveModules.has(owner)).toBe(true);
    }
  });
});

describe('isScannableFile', () => {
  it('accepts shipped .ts and rejects test/decl/bench files', () => {
    expect(isScannableFile('owner.ts')).toBe(true);
    expect(isScannableFile('owner.test.ts')).toBe(false);
    expect(isScannableFile('types.d.ts')).toBe(false);
    expect(isScannableFile('x.bench.ts')).toBe(false);
  });
});
