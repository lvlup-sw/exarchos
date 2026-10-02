import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { SUBJECT_SRC_ROOT, REPO_ROOT } from './subject-root.js';
import { listTrackedFiles } from '../../test-helpers/tracked-population.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { lexModule } from '../../test-helpers/module-lexer.js';

/** The tree this census governs — the subject's, not this package's. */
const SRC_ROOT = SUBJECT_SRC_ROOT;

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
  /** It asserts the diagnostics array first, so a regression describes itself. */
  it('(a) the live shipped source has ZERO direct bypasses and no stale owner', async () => {
    const result = await auditVcsOwnership(SRC_ROOT, lexModule);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.siteCount).toBeGreaterThan(0);
  });

  it('(a) a planted direct bypass in a non-owner module FAILS the census against the live sites', async () => {
    const sites = await scanVcsMutationSites(SRC_ROOT, lexModule);
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

  /** Each declared owner has a live mutation site, or `STALE_VCS_OWNER` trips in the live audit. */
  it('every declared owner corresponds to a real module path present in the scan root', async () => {
    const sites = await scanVcsMutationSites(SRC_ROOT, lexModule);
    const liveModules = new Set(sites.map((s) => s.module));
    for (const owner of VCS_MUTATION_OWNERS) {
      expect(liveModules.has(owner)).toBe(true);
    }
  });
});

/**
 * Modules outside the governed root that mutate git, recorded and not hidden.
 *
 * The census walks one subtree, but it is cited for git mutation in the whole repository. This
 * suite measures the complement, and does not widen the walk. The `VCS_MUTATION_OWNERS` entries
 * are relative to the governed root, so a repo-wide walk renames each module and strands each
 * owner rule.
 *
 * An entry that names no live site fails, the same ratchet as for `VCS_MUTATION_OWNERS`.
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

  /**
   * It partitions each tracked module into governed and ungoverned. `git ls-files` gives the
   * population, so it does not inherit the blind spot of the census scan root. Both partitions must
   * be non-empty. The census detector then runs on the ungoverned modules. An exemption that names
   * no live site fails, because it pre-authorizes a future mutation on that path.
   */
  it('VcsOwnership_EveryFirstPartyTreeIsEitherGovernedOrProvenFree', async () => {
    const tracked = await listTrackedFiles(REPO_ROOT, {
      exclude: (path) => {
        const segments = path.split('/');
        const name = segments[segments.length - 1] ?? '';
        return (
          segments.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir)) || !isScannableFile(name)
        );
      },
    });
    const ungoverned = tracked.filter((path) => !path.startsWith(`${GOVERNED_SOURCE_ROOT}/`));

    expect(tracked.length).toBeGreaterThan(0);
    expect(
      ungoverned.length,
      'no tracked module falls outside the governed root — either the repository ' +
        'collapsed to one package, or this walk is not seeing the tree',
    ).toBeGreaterThan(0);

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

    const live = new Set(complementSites.map((site) => site.module));
    expect(
      COMPLEMENT_EXEMPTIONS.filter((entry) => !live.has(entry.module)).map((e) => e.module),
      'these complement exemptions claim no live mutation site — delete them',
    ).toEqual([]);
  });

  /**
   * The kill fixture for the complement sweep. The sweep uses the census detector, so this case
   * proves that the detector finds a mutation outside the governed root.
   */
  it('VcsOwnership_ComplementSweepFiresOnAPlantedMutation', async () => {
    const sites = detectVcsMutationSites(
      'src/rogue-cli.ts',
      `await run(['worktree', 'add', target, branch]);`,
      lexModule,
    );
    expect(sites.map((s) => s.mutation)).toEqual(['worktree.add']);
  });

  /**
   * A root with no scannable module yields no sites, the same as a clean tree, so the census must
   * fail on it. The empty owner list removes the `STALE_VCS_OWNER` ratchet, so this check stands
   * alone. The live root reports a real population, so the check rejects only emptiness.
   */
  it('VcsOwnership_WalkVisitingZeroModules_FailsRatherThanReportingACleanTree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exarchos-vcs-empty-'));
    try {
      const result = await auditVcsOwnership(root, lexModule, []);
      expect(result.ok).toBe(false);
      expect(result.moduleCount).toBe(0);
      expect(result.diagnostics.map((d) => d.code)).toEqual(['EMPTY_MODULE_POPULATION']);
    } finally {
      await rmrfAsync(root);
    }

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
