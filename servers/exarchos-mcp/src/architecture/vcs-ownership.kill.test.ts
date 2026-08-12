import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditVcsOwnership,
  detectVcsMutationSites,
  stripComments,
  VCS_MUTATION_OWNERS,
  type VcsOwnershipDiagnostic,
} from './vcs-ownership.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * DR-12 kill tests for the widened VCS-mutation census.
 *
 * These are deliberately INTEGRATION-layer: each plants real `.ts` files into a
 * real temp directory tree and runs the async `auditVcsOwnership(root)`
 * end-to-end (walk → read → strip → detect → census). A hand-built site array
 * fed to `runVcsOwnershipCensus` would only prove the *census* rejects an
 * unowned site — which it already did before DR-12. The defect DR-12 names is in
 * the DETECTOR: `['merge', '--no-ff', x]` was invisible, so the census stayed
 * green over a tree that plainly mutated. Only a filesystem round-trip can kill
 * that.
 */

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
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it('CONTROL — an owner-only tree is GREEN (so redness below is caused by the plant)', async () => {
    const root = await plant({ [OWNER_MODULE]: OWNER_SOURCE });
    const result = await auditVcsOwnership(root, SCOPED_OWNERS);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('VcsOwnership_PlantedMergeOutsideOwner_CensusFailsClosed', async () => {
    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      // The exact vector DR-12 names: a direct `git merge --no-ff` in a module
      // no owner rule claims. This passed the census before the widening.
      'verbs/rogue-merge.ts': `
        import type { GitExec } from './pure/execute-merge.js';
        export function landBranch(gitExec: GitExec, repoRoot: string, target: string): void {
          gitExec(repoRoot, ['merge', '--no-ff', target]);
        }
      `,
    });

    const result = await auditVcsOwnership(root, SCOPED_OWNERS);

    expect(result.ok).toBe(false);
    const bypasses = bypassesOf(result.diagnostics);
    expect(bypasses).toHaveLength(1);
    expect(bypasses[0]?.module).toBe('verbs/rogue-merge.ts');
    expect(bypasses[0]?.mutation).toBe('merge');
    expect(bypasses[0]?.message).toContain('verbs/rogue-merge.ts');
    // The plant is the ONLY reason the tree is red.
    expect(result.diagnostics.map((d) => d.code)).toEqual(['DIRECT_VCS_BYPASS']);
  });

  it('VcsOwnership_PlantedBranchCreateOutsideOwner_CensusFailsClosed', async () => {
    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      // `git branch <name> <base>` — creation via the bare subcommand.
      'verbs/rogue-branch.ts': `
        export function forkBranch(git: Git, repoRoot: string, name: string, base: string): void {
          git.run(['branch', name, base], repoRoot);
        }
      `,
      // `git checkout -b <name>` — the other real creation vector.
      'launcher/rogue-checkout.ts': `
        export function cutBranch(git: Git, repoRoot: string, name: string): void {
          git.run(['checkout', '-b', name], repoRoot);
        }
      `,
      // `git switch -c <name>` — the modern equivalent.
      'launcher/rogue-switch.ts': `
        export function cutBranchModern(git: Git, repoRoot: string, name: string): void {
          git.run(['switch', '-c', name], repoRoot);
        }
      `,
    });

    const result = await auditVcsOwnership(root, SCOPED_OWNERS);

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

  it('FALSE-POSITIVE GUARD — incidental `merge`/`branch` literals from the live tree yield NO site', async () => {
    // Every snippet below is copied in SHAPE from a real shipped module that
    // contains a bare `'merge'` or `'branch'` string literal but performs no git
    // mutation. If any of these matched, the widening would be unusable.
    const incidental: Record<string, string> = {
      // registry.ts — Zod strategy enum + the wait-predicate selector, which is
      // the nastiest case: `'merge'` IS the head element of an array literal.
      'registry.ts': `
        const a = z.enum(['squash', 'rebase', 'merge']);
        const b = z.enum(['merge', 'idle']).optional();
      `,
      // event-store/liveness-registry.ts — surface union + object field.
      'events/liveness-registry.ts': `
        export type LivenessSurface = 'merge' | 'launch' | 'mutation' | 'prune';
        const entry = { surface: 'merge', ttlMs: 1000 };
      `,
      // vcs/github.ts — a gh PR merge (remote API), not a git argv.
      'vcs/github.ts': `
        await exec('gh', ['pr', 'merge', prId, strategyFlag]);
      `,
      // vcs/gitlab.ts — glab MR merge built by push(), not a git argv.
      'vcs/gitlab.ts': `
        const args = ['mr', 'merge', prId];
        if (strategy === 'squash') { args.push('--squash'); }
      `,
      // vcs/azure-devops.ts — switch case label.
      'vcs/azure-devops.ts': `
        switch (strategy) { case 'merge': return 'noFastForward'; }
      `,
      // views/lifecycle/wait.ts — nested quotes inside a double-quoted string.
      'projections/views/lifecycle/wait.ts': `
        const shape = { expectedShape: { until: "'merge' | 'idle'" } };
        const fix = { params: { action: 'wait', until: 'merge' } };
      `,
      // runbooks/definitions.ts — 'branch' as a template-variable name, followed
      // by another quoted literal.
      'runbooks/definitions.ts': `
        const templateVars = ['taskId', 'featureId', 'streamId', 'branch', 'worktreePath'];
      `,
      // verbs/gates/pre-synthesis-check.ts — a git READ, not a create.
      'verbs/gates/pre-synthesis-check.ts': `
        currentBranch = execFileSync('git', ['branch', '--show-current'], { cwd: root });
      `,
      // verbs/review/review-diff.ts — the same read through a helper.
      'verbs/review/review-diff.ts': `
        const currentBranch = git(['branch', '--show-current'], worktreePath);
      `,
      // architecture/sdlc-catalog.ts — a catalog tag list.
      'architecture/sdlc-catalog.ts': `
        const applies = { 'applies-to': ['pull-requests', 'branch-topology', 'merge'] };
      `,
      // verbs/gates/test-adequacy.ts — `checkout <ref> -- <paths>` restores the
      // working tree; it creates no branch.
      'verbs/gates/test-adequacy.ts': `
        const result = gitExec(repoRoot, ['checkout', stashSha, '--', '.']);
        const c = gitExec(repoRoot, ['checkout', baseRef, '--', ...basePaths]);
      `,
      // Index access / extractor call shapes.
      'projections/views/tools.ts': `
        const x = typeof e['branch'] === 'string' ? { branch: e['branch'] as string } : {};
        const y = extractString(event.data, 'branch');
      `,
    };

    // Unit-level: no snippet yields a site.
    for (const [module, source] of Object.entries(incidental)) {
      expect(detectVcsMutationSites(module, source), `${module} must yield no site`).toEqual(
        [],
      );
    }

    // Integration-level: a whole tree of them, with a real owner, stays GREEN.
    const root = await plant({ ...incidental, [OWNER_MODULE]: OWNER_SOURCE });
    const result = await auditVcsOwnership(root, SCOPED_OWNERS);
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
    const result = await auditVcsOwnership(root, SCOPED_OWNERS);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('stripComments does not desync on a regex literal containing quote characters', () => {
    // Regression guard for the lexer defect the widening exposed: the `'` inside
    // a regex character class is NOT a string delimiter. Before the fix the
    // scanner entered a phantom string here and stopped recognising `//`, so
    // comment prose leaked into the scan and self-matched.
    //
    // The comment is on the SAME LINE as the regex on purpose. A newline would
    // resynchronise the lexer by itself (`'`/`"` are line-bounded), so a
    // next-line fixture passes even WITHOUT regex awareness and would leave this
    // guard vacuous. Same-line is the case only regex awareness can strip.
    const sameLine = [
      "const RE = /(['\"`])x\\1/; // legacy called ['merge', '--no-ff', target]",
      'export const after = 1;',
    ].join('\n');
    expect(stripComments(sameLine)).not.toContain('merge');
    expect(stripComments(sameLine)).toContain('export const after = 1;');
    expect(detectVcsMutationSites('architecture/detector.ts', sameLine)).toEqual([]);

    // Same for a same-line BLOCK comment and a branch-create vector.
    const blockSameLine =
      "const RE = /(['\"`])x\\1/; /* used ['checkout', '-b', tmp] */ export const a = 1;";
    expect(stripComments(blockSameLine)).not.toContain('checkout');
    expect(detectVcsMutationSites('architecture/detector.ts', blockSameLine)).toEqual([]);

    // A `/` in DIVISION position must NOT be mistaken for a regex opener — that
    // would swallow real code and cause a false NEGATIVE (the dangerous
    // direction for a ratchet).
    const division = "const ratio = total / count;\ngit.run(['merge', '--no-ff', target]);";
    expect(detectVcsMutationSites('x/y.ts', division).map((s) => s.mutation)).toEqual([
      'merge',
    ]);
  });

  it('a desync from the regex heuristic blind spot is capped at one line', () => {
    // `return /(['"])/` is the conservative heuristic's known blind spot: the
    // previous significant character is `n` (of `return`), so the `/` is scored
    // as division and regex mode is NOT entered. Line-bounded `'`/`"` strings
    // are what stop the resulting phantom string from running to EOF and
    // dragging every later comment into the scan.
    const source = [
      `export function isQuote(x: string): boolean { return /(['"])/.test(x); }`,
      `// historical: ['merge', '--no-ff', target]`,
      `export function land(git: Git, root: string) { git.run(['worktree', 'add', p, b], root); }`,
    ].join('\n');

    const sites = detectVcsMutationSites('x/y.ts', source);
    // The commented-out merge must NOT leak …
    expect(sites.map((s) => s.mutation)).toEqual(['worktree.add']);
    // … while the real mutation on the line AFTER the desync is still seen, so
    // the cap resynchronises rather than blinding the detector.
    expect(sites[0]?.mutation).toBe('worktree.add');
  });
});

describe('DR-12 live tree — the widened census is green and load-bearing', () => {
  let live: Awaited<ReturnType<typeof auditVcsOwnership>>;

  beforeAll(async () => {
    live = await auditVcsOwnership(SRC_ROOT);
  });

  it('the live shipped source is GREEN under the WIDENED detector', () => {
    expect(live.diagnostics).toEqual([]);
    expect(live.ok).toBe(true);
  });

  it('the widened detector actually SEES merge + branch.create on the live tree', async () => {
    // Without this the census could be green merely because the new rules never
    // match anything — a vacuous pass. `local-git-merge.ts` is the module DR-12
    // names as "invisible by design"; it must now be visible.
    const { scanVcsMutationSites } = await import('./vcs-ownership.js');
    const sites = await scanVcsMutationSites(SRC_ROOT);
    const kinds = new Set(sites.map((s) => s.mutation));
    expect(kinds.has('merge')).toBe(true);
    expect(kinds.has('branch.create')).toBe(true);
    expect(
      sites.some((s) => s.module === 'verbs/merge/local-git-merge.ts' && s.mutation === 'merge'),
    ).toBe(true);
  });

  it('every declared owner still claims a live site (STALE_VCS_OWNER ratchet intact)', async () => {
    const { scanVcsMutationSites } = await import('./vcs-ownership.js');
    const sites = await scanVcsMutationSites(SRC_ROOT);
    const liveModules = new Set(sites.map((s) => s.module));
    for (const owner of VCS_MUTATION_OWNERS) {
      expect(liveModules.has(owner), `${owner} declares cover but claims no site`).toBe(true);
    }
  });

  it('dropping a DR-12 owner turns the live census RED (the new owners are load-bearing)', async () => {
    // Proves the two DR-12 additions are not decorative: remove either and the
    // live tree fails closed with a real bypass, not a shrug.
    for (const dropped of ['verbs/merge/local-git-merge.ts', 'verbs/pure/execute-merge.ts']) {
      const owners = VCS_MUTATION_OWNERS.filter((o) => o !== dropped);
      const result = await auditVcsOwnership(SRC_ROOT, owners);
      expect(result.ok, `${dropped} should be load-bearing`).toBe(false);
      expect(
        bypassesOf(result.diagnostics).some((d) => d.module === dropped),
        `${dropped} should be reported as a direct bypass`,
      ).toBe(true);
    }
  });
});
