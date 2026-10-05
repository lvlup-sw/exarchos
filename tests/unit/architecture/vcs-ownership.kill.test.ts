// Kill tests for the widened VCS-mutation census.
//
// Each test plants real `.ts` files into a temp directory tree and runs `auditVcsOwnership(root)` end to end.
// A hand-built site array for `runVcsOwnershipCensus` proves only that the census rejects an unowned site.
// The detector must see an argv such as `['merge', '--no-ff', x]`.
// Only a round trip through the file system proves that.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditVcsOwnership,
  detectVcsMutationSites,
  stripComments,
  VCS_MUTATION_OWNERS,
  type VcsOwnershipDiagnostic,
} from '../../../tools/conformance/src/vcs-ownership.js';
import { lexModule } from '../../../tools/test-helpers/module-lexer.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../src');

/** The owner-shaped module planted in every fixture so no STALE_VCS_OWNER noise. */
const OWNER_MODULE = 'vcs/mutation-owner.ts';
const OWNER_SOURCE = `
export function mergeBranch(git: Git, repoRoot: string, source: string): void {
  git.run(['merge', '--no-ff', '--no-edit', source], repoRoot);
}
`;
const SCOPED_OWNERS = [OWNER_MODULE] as const;

/** Materialise `{ relativePath: source }` into a fresh temp source root. */
async function plantTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vcs-ownership-kill-'));
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, source, 'utf8');
  }
  return root;
}

function bypassesOf(
  diagnostics: readonly VcsOwnershipDiagnostic[],
): Extract<VcsOwnershipDiagnostic, { code: 'DIRECT_VCS_BYPASS' }>[] {
  return diagnostics.filter(
    (d): d is Extract<VcsOwnershipDiagnostic, { code: 'DIRECT_VCS_BYPASS' }> =>
      d.code === 'DIRECT_VCS_BYPASS',
  );
}

describe('DR-12 kill — widened census sees merge and branch-create', () => {
  const roots: string[] = [];
  const plant = async (files: Record<string, string>): Promise<string> => {
    const root = await plantTree(files);
    roots.push(root);
    return root;
  };

  afterAll(async () => {
    await Promise.all(roots.map((r) => rmrfAsync(r)));
  });

  it('CONTROL — an owner-only tree is GREEN (so redness below is caused by the plant)', async () => {
    const root = await plant({ [OWNER_MODULE]: OWNER_SOURCE });
    const result = await auditVcsOwnership(root, lexModule, SCOPED_OWNERS);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /** The plant is a direct `git merge --no-ff` in a module that no owner rule claims. It is the only diagnostic. */
  it('VcsOwnership_PlantedMergeOutsideOwner_CensusFailsClosed', async () => {
    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      'verbs/rogue-merge.ts': `
        import type { GitExec } from './pure/execute-merge.js';
        export function landBranch(gitExec: GitExec, repoRoot: string, target: string): void {
          gitExec(repoRoot, ['merge', '--no-ff', target]);
        }
      `,
    });

    const result = await auditVcsOwnership(root, lexModule, SCOPED_OWNERS);

    expect(result.ok).toBe(false);
    const bypasses = bypassesOf(result.diagnostics);
    expect(bypasses).toHaveLength(1);
    expect(bypasses[0]?.module).toBe('verbs/rogue-merge.ts');
    expect(bypasses[0]?.mutation).toBe('merge');
    expect(bypasses[0]?.message).toContain('verbs/rogue-merge.ts');
    expect(result.diagnostics.map((d) => d.code)).toEqual(['DIRECT_VCS_BYPASS']);
  });

  /** The three plants are the creation vectors: `git branch <name> <base>`, `git checkout -b` and `git switch -c`. */
  it('VcsOwnership_PlantedBranchCreateOutsideOwner_CensusFailsClosed', async () => {
    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      'verbs/rogue-branch.ts': `
        export function forkBranch(git: Git, repoRoot: string, name: string, base: string): void {
          git.run(['branch', name, base], repoRoot);
        }
      `,
      'launcher/rogue-checkout.ts': `
        export function cutBranch(git: Git, repoRoot: string, name: string): void {
          git.run(['checkout', '-b', name], repoRoot);
        }
      `,
      'launcher/rogue-switch.ts': `
        export function cutBranchModern(git: Git, repoRoot: string, name: string): void {
          git.run(['switch', '-c', name], repoRoot);
        }
      `,
    });

    const result = await auditVcsOwnership(root, lexModule, SCOPED_OWNERS);

    expect(result.ok).toBe(false);
    const bypasses = bypassesOf(result.diagnostics);
    expect(bypasses.map((d) => d.module).sort()).toEqual([
      'launcher/rogue-checkout.ts',
      'launcher/rogue-switch.ts',
      'verbs/rogue-branch.ts',
    ]);
    for (const bypass of bypasses) {
      expect(bypass.mutation).toBe('branch.create');
    }
    expect(result.diagnostics.every((d) => d.code === 'DIRECT_VCS_BYPASS')).toBe(true);
  });

  /**
   * Each snippet copies the shape of a shipped module that holds a bare `'merge'` or `'branch'` literal
   * and does no git mutation. The hardest case is `registry.ts`, where `'merge'` is the head of an array literal.
   * Other cases are a `gh` or `glab` argv, a git read such as `branch --show-current`,
   * and a `checkout` that restores paths.
   * The test checks each snippet alone, then a whole tree of the snippets with a real owner.
   */
  it('FALSE-POSITIVE GUARD — incidental `merge`/`branch` literals from the live tree yield NO site', async () => {
    const incidental: Record<string, string> = {
      'registry.ts': `
        const a = z.enum(['squash', 'rebase', 'merge']);
        const b = z.enum(['merge', 'idle']).optional();
      `,
      'events/liveness-registry.ts': `
        export type LivenessSurface = 'merge' | 'launch' | 'mutation' | 'prune';
        const entry = { surface: 'merge', ttlMs: 1000 };
      `,
      'vcs/github.ts': `
        await exec('gh', ['pr', 'merge', prId, strategyFlag]);
      `,
      'vcs/gitlab.ts': `
        const args = ['mr', 'merge', prId];
        if (strategy === 'squash') { args.push('--squash'); }
      `,
      'vcs/azure-devops.ts': `
        switch (strategy) { case 'merge': return 'noFastForward'; }
      `,
      'projections/views/lifecycle/wait.ts': `
        const shape = { expectedShape: { until: "'merge' | 'idle'" } };
        const fix = { params: { action: 'wait', until: 'merge' } };
      `,
      'runbooks/definitions.ts': `
        const templateVars = ['taskId', 'featureId', 'streamId', 'branch', 'worktreePath'];
      `,
      'verbs/gates/pre-synthesis-check.ts': `
        currentBranch = execFileSync('git', ['branch', '--show-current'], { cwd: root });
      `,
      'verbs/review/review-diff.ts': `
        const currentBranch = git(['branch', '--show-current'], worktreePath);
      `,
      'architecture/sdlc-catalog.ts': `
        const applies = { 'applies-to': ['pull-requests', 'branch-topology', 'merge'] };
      `,
      'verbs/gates/test-adequacy.ts': `
        const result = gitExec(repoRoot, ['checkout', stashSha, '--', '.']);
        const c = gitExec(repoRoot, ['checkout', baseRef, '--', ...basePaths]);
      `,
      'projections/views/tools.ts': `
        const x = typeof e['branch'] === 'string' ? { branch: e['branch'] as string } : {};
        const y = extractString(event.data, 'branch');
      `,
    };

    for (const [module, source] of Object.entries(incidental)) {
      expect(
        detectVcsMutationSites(module, source, lexModule),
        `${module} must yield no site`,
      ).toEqual([]);
    }

    const root = await plant({ ...incidental, [OWNER_MODULE]: OWNER_SOURCE });
    const result = await auditVcsOwnership(root, lexModule, SCOPED_OWNERS);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('a merge/branch-create mentioned only in a COMMENT is still not a site', async () => {
    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      'verbs/documented.ts': `
        // Landing runs ['merge', '--no-ff', target] under the hood.
        /* and ['checkout', '-b', tmp] for the rebase strategy */
        export const documented = 1;
      `,
    });
    const result = await auditVcsOwnership(root, lexModule, SCOPED_OWNERS);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * The `'` inside a regex character class is not a string delimiter.
   * A lexer that opens a string there stops recognizing `//`, and comment prose leaks into the scan.
   * The comment sits on the same line as the regex on purpose. A newline resynchronizes a line-bounded lexer,
   * so a next-line fixture passes without regex awareness.
   * A `/` in division position must not open a regex. That error hides real code and gives a false negative.
   */
  it('stripComments does not desync on a regex literal containing quote characters', () => {
    const sameLine = [
      "const RE = /(['\"`])x\\1/; // legacy called ['merge', '--no-ff', target]",
      'export const after = 1;',
    ].join('\n');
    expect(stripComments(sameLine, lexModule)).not.toContain('merge');
    expect(stripComments(sameLine, lexModule)).toContain('export const after = 1;');
    expect(detectVcsMutationSites('architecture/detector.ts', sameLine, lexModule)).toEqual([]);

    const blockSameLine =
      "const RE = /(['\"`])x\\1/; /* used ['checkout', '-b', tmp] */ export const a = 1;";
    expect(stripComments(blockSameLine, lexModule)).not.toContain('checkout');
    expect(detectVcsMutationSites('architecture/detector.ts', blockSameLine, lexModule)).toEqual(
      [],
    );

    const division = "const ratio = total / count;\ngit.run(['merge', '--no-ff', target]);";
    expect(detectVcsMutationSites('x/y.ts', division, lexModule).map((s) => s.mutation)).toEqual([
      'merge',
    ]);
  });

  /**
   * A heuristic that reads the character before a `/` scores the regex after `return` as division and loses sync.
   * The parser reports the regex literal in every operand position.
   * The merge in the comment must not leak, and the real mutation on the next line must still show.
   * `tools/conformance/src/vcs-ownership.kill-lexer.test.ts` holds an input that a line-bounded cap does not survive.
   */
  it('the retired heuristic blind spot is answered by the grammar, not capped', () => {
    const source = [
      `export function isQuote(x: string): boolean { return /(['"])/.test(x); }`,
      `// historical: ['merge', '--no-ff', target]`,
      `export function land(git: Git, root: string) { git.run(['worktree', 'add', p, b], root); }`,
    ].join('\n');

    const sites = detectVcsMutationSites('x/y.ts', source, lexModule);
    expect(sites.map((s) => s.mutation)).toEqual(['worktree.add']);
    expect(sites[0]?.mutation).toBe('worktree.add');
  });
});

describe('DR-12 live tree — the widened census is green and load-bearing', () => {
  let live: Awaited<ReturnType<typeof auditVcsOwnership>>;

  beforeAll(async () => {
    live = await auditVcsOwnership(SRC_ROOT, lexModule);
  });

  it('the live shipped source is GREEN under the WIDENED detector', () => {
    expect(live.diagnostics).toEqual([]);
    expect(live.ok).toBe(true);
  });

  /**
   * Without this test the census can be green because the rules match nothing.
   * The detector must see the merge in `verbs/merge/local-git-merge.ts`.
   */
  it('the widened detector actually SEES merge + branch.create on the live tree', async () => {
    const { scanVcsMutationSites } = await import('../../../tools/conformance/src/vcs-ownership.js');
    const sites = await scanVcsMutationSites(SRC_ROOT, lexModule);
    const kinds = new Set(sites.map((s) => s.mutation));
    expect(kinds.has('merge')).toBe(true);
    expect(kinds.has('branch.create')).toBe(true);
    expect(
      sites.some((s) => s.module === 'verbs/merge/local-git-merge.ts' && s.mutation === 'merge'),
    ).toBe(true);
  });

  it('every declared owner still claims a live site (STALE_VCS_OWNER ratchet intact)', async () => {
    const { scanVcsMutationSites } = await import('../../../tools/conformance/src/vcs-ownership.js');
    const sites = await scanVcsMutationSites(SRC_ROOT, lexModule);
    const liveModules = new Set(sites.map((s) => s.module));
    for (const owner of VCS_MUTATION_OWNERS) {
      expect(liveModules.has(owner), `${owner} declares cover but claims no site`).toBe(true);
    }
  });

  /** The two owners are load-bearing: without either one, the live tree fails with a direct bypass. */
  it('dropping a DR-12 owner turns the live census RED (the new owners are load-bearing)', async () => {
    for (const dropped of ['verbs/merge/local-git-merge.ts', 'verbs/pure/execute-merge.ts']) {
      const owners = VCS_MUTATION_OWNERS.filter((o) => o !== dropped);
      const result = await auditVcsOwnership(SRC_ROOT, lexModule, owners);
      expect(result.ok, `${dropped} should be load-bearing`).toBe(false);
      expect(
        bypassesOf(result.diagnostics).some((d) => d.module === dropped),
        `${dropped} should be reported as a direct bypass`,
      ).toBe(true);
    }
  });
});
