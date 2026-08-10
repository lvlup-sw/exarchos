import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  auditVcsOwnership,
  runVcsOwnershipCensus,
  detectVcsMutationSites,
  scanVcsMutationSites,
  scanVcsTree,
  stripComments,
  isScannableFile,
  EXCLUDED_DIRS,
  GOVERNED_SOURCE_ROOT,
  VCS_MUTATION_OWNERS,
  type VcsMutationSite,
} from './vcs-ownership.js';
import { listTrackedFiles } from '../test-helpers/tracked-population.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { lexModule } from '../test-helpers/module-lexer.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The repository root — `servers/exarchos-mcp/src` is three levels down. */
const REPO_ROOT = join(SRC_ROOT, '..', '..', '..');

describe('detectVcsMutationSites', () => {
  it('detects worktree add / worktree remove / branch delete argument vectors', () => {
    const sites = detectVcsMutationSites(
      'x/y.ts',
      `gitRunner.run(['worktree', 'add', p, b], root);
       gitRunner.run(['worktree', 'remove', '--force', p], root);
       gitRunner.run(['branch', '-D', name], root);`,
      lexModule,
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
      lexModule,
    );
    expect(sites).toHaveLength(0);
  });

  it('does NOT count a git read (worktree list) as a mutation', () => {
    const sites = detectVcsMutationSites(
      'x/y.ts',
      `gitRunner.run(['worktree', 'list', '--porcelain'], root);
       gitRunner.run(['branch', '--show-current'], root);`,
      lexModule,
    );
    expect(sites).toHaveLength(0);
  });

  it('matches either quote style but not a mismatched pair', () => {
    expect(detectVcsMutationSites('a.ts', `run(["worktree", "add"])`, lexModule)).toHaveLength(1);
    expect(detectVcsMutationSites('a.ts', "run(['worktree', 'add'])", lexModule)).toHaveLength(1);
  });
});

describe('stripComments', () => {
  it('removes line + block comments but preserves string-literal content', () => {
    const out = stripComments(
      `const a = 'worktree'; // 'branch', '-D'\n/* 'worktree', 'remove' */ const b = "add";`,
      lexModule,
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
      { module: 'orchestrate/rogue.ts', mutation: 'worktree.add', evidence: "'worktree', 'add'" },
    ];
    const result = runVcsOwnershipCensus(sites, owners);
    expect(result.ok).toBe(false);
    const bypass = result.diagnostics.find((d) => d.code === 'DIRECT_VCS_BYPASS');
    expect(bypass && 'module' in bypass && bypass.module).toBe('orchestrate/rogue.ts');
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
    const result = await auditVcsOwnership(SRC_ROOT, lexModule);
    // Surfacing the diagnostics array makes any regression self-describing.
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.siteCount).toBeGreaterThan(0);
  });

  it('(a) a planted direct bypass in a non-owner module FAILS the census against the live sites', async () => {
    const sites = await scanVcsMutationSites(SRC_ROOT, lexModule);
    const planted: VcsMutationSite = {
      module: 'orchestrate/rogue-bypass.ts',
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
          d.module === 'orchestrate/rogue-bypass.ts',
      ),
    ).toBe(true);
  });

  it('every declared owner corresponds to a real module path present in the scan root', async () => {
    const sites = await scanVcsMutationSites(SRC_ROOT, lexModule);
    const liveModules = new Set(sites.map((s) => s.module));
    // Each declared owner must have at least one live mutation site — otherwise
    // the STALE_VCS_OWNER ratchet would (correctly) trip in the live audit.
    for (const owner of VCS_MUTATION_OWNERS) {
      expect(liveModules.has(owner)).toBe(true);
    }
  });
});

// ─── DR-8 / task 079 — the scan root is part of the claim ────────────────────
//
// This census is cited for a property about git mutation in THIS REPOSITORY, but
// it walks one subtree. Previously the gap lived only in prose: the module header
// said "the shipped source" and every caller passed `servers/exarchos-mcp/src`,
// so a `git worktree add` shelled from root `src/` was not exempt — it was
// invisible, and the census reported a clean tree.
//
// The gap is closed by measuring the complement rather than by widening the walk.
// Widening is the wrong instrument here: VCS_MUTATION_OWNERS's entries are
// root-relative module paths, so a repo-wide walk renames every module and
// strands every owner rule. Measuring the complement proves the same property
// over the union — governed subtree ∪ everything else — while leaving the owner
// vocabulary intact.

/**
 * Modules outside the governed root that mutate git, recorded rather than hidden.
 *
 * The alternative was silence — before this sweep existed these modules were not
 * exempt, they were INVISIBLE, and the census's repo-wide claim was simply false
 * outside the subtree it measured. An exemption is a debt with an owner and a
 * reason; an unmeasured complement is a debt nobody can see.
 *
 * Entries are held to the same no-phantom-cover ratchet as VCS_MUTATION_OWNERS:
 * an entry naming no live site fails, so the list cannot rot into a rubber stamp.
 */
const COMPLEMENT_EXEMPTIONS: readonly { module: string; owner: string; rationale: string }[] =
  Object.freeze([
    {
      module: 'tests/outcome/_helpers/tmp-git.ts',
      owner: 'exarchos-core',
      rationale:
        'Outcome-test harness. Creates a throwaway repo under os.tmpdir() and adds/removes ' +
        'sibling worktrees INSIDE it, never in this repository, so the mutation-owner ' +
        'contract (idempotency, fencing, compensation) has no subject: the whole tree is ' +
        'discarded when the test ends. Routing it through vcs/mutation-owner.ts would make ' +
        'the harness depend on the production module it exists to test around.',
    },
  ]);

describe('DR-8 — the governed root is declared, and its complement is measured', () => {
  it('VcsOwnership_DeclaredGovernedRoot_IsTheRootTheLiveAuditWalks', () => {
    expect(resolve(REPO_ROOT, GOVERNED_SOURCE_ROOT)).toBe(resolve(SRC_ROOT));
  });

  it('VcsOwnership_EveryFirstPartyTreeIsEitherGovernedOrProvenFree', async () => {
    // Every module the repository tracks, partitioned into governed / not. The
    // population comes from `git ls-files` — it knows nothing about the census's
    // scan root, so it cannot inherit the census's blind spot.
    const tracked = listTrackedFiles(REPO_ROOT, {
      exclude: (path) => {
        const segments = path.split('/');
        const name = segments[segments.length - 1] ?? '';
        return (
          segments.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir)) || !isScannableFile(name)
        );
      },
    });
    const ungoverned = tracked.filter((path) => !path.startsWith(`${GOVERNED_SOURCE_ROOT}/`));

    // Both partitions must be real, or the partition proves nothing.
    expect(tracked.length).toBeGreaterThan(0);
    expect(
      ungoverned.length,
      'no tracked module falls outside the governed root — either the repository ' +
        'collapsed to one package, or this walk is not seeing the tree',
    ).toBeGreaterThan(0);

    // The census's own detector, applied to the tree the census does NOT walk.
    const complementSites: VcsMutationSite[] = [];
    for (const path of ungoverned) {
      complementSites.push(
        ...detectVcsMutationSites(path, await readFile(join(REPO_ROOT, path), 'utf8'), lexModule),
      );
    }

    const exempt = new Set(COMPLEMENT_EXEMPTIONS.map((entry) => entry.module));
    const undeclared = complementSites.filter((site) => !exempt.has(site.module));

    expect(
      undeclared.map((site) => `${site.module} [${site.mutation}]`),
      'A module OUTSIDE the governed scan root performs direct git worktree/branch ' +
        'mutation. It is invisible to the census — which is exactly the shape DR-8 ' +
        'names: the guard reads green for a reason unrelated to the tree being clean. ' +
        'Route it through vcs/mutation-owner.ts, widen the census (and move ' +
        'VCS_MUTATION_OWNERS to repo-relative paths), or record it in ' +
        'COMPLEMENT_EXEMPTIONS with an owner and a rationale.',
    ).toEqual([]);

    // NO PHANTOM COVER — the same ratchet VCS_MUTATION_OWNERS carries. An
    // exemption that names no live site is stale cover pre-authorizing a future
    // mutation on that exact path, so it fails rather than lingering.
    const live = new Set(complementSites.map((site) => site.module));
    expect(
      COMPLEMENT_EXEMPTIONS.filter((entry) => !live.has(entry.module)).map((e) => e.module),
      'these complement exemptions claim no live mutation site — delete them',
    ).toEqual([]);
  });

  it('VcsOwnership_ComplementSweepFiresOnAPlantedMutation', async () => {
    // KILL FIXTURE for the sweep above. A complement that is clean today says
    // nothing unless the instrument that found it clean can find a dirty one —
    // and the sweep reuses the census's own detector precisely so this holds.
    const sites = detectVcsMutationSites(
      'src/rogue-cli.ts',
      `await run(['worktree', 'add', target, branch]);`,
      lexModule,
    );
    expect(sites.map((s) => s.mutation)).toEqual(['worktree.add']);
  });

  it('VcsOwnership_WalkVisitingZeroModules_FailsRatherThanReportingACleanTree', async () => {
    // NON-EMPTY DENOMINATOR. A root that resolves to a tree with no scannable
    // module yields no sites — and "no sites" is what a clean tree yields too.
    // Passing an EMPTY owner list removes the STALE_VCS_OWNER ratchet, which is
    // what catches this today only incidentally; the tooth under test has to
    // stand on its own.
    const root = await mkdtemp(join(tmpdir(), 'exarchos-vcs-empty-'));
    try {
      const result = await auditVcsOwnership(root, lexModule, []);
      expect(result.ok).toBe(false);
      expect(result.moduleCount).toBe(0);
      expect(result.diagnostics.map((d) => d.code)).toEqual(['EMPTY_MODULE_POPULATION']);
    } finally {
      await rmrfAsync(root);
    }

    // The live root, by contrast, reports a real population — so the tooth above
    // rejects emptiness rather than rejecting everything.
    const live = await scanVcsTree(SRC_ROOT, lexModule);
    expect(live.moduleCount).toBeGreaterThan(0);
    expect((await auditVcsOwnership(SRC_ROOT, lexModule)).moduleCount).toBe(live.moduleCount);
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
