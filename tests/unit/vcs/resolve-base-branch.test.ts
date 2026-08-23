// @oracle-sources: ../../../src/vcs/resolve-base-branch.ts, the src/ tree walked at test time for callers
//
// The census below compares the module that DECLARES the resolver against the
// live source tree walked for uses of it. Neither side is written down here: a
// hand-listed caller set would keep naming a caller after it was deleted, and
// keep missing one that was added.

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveBaseBranch,
  resolveDiffBase,
  BASE_BRANCH_UNRESOLVED,
  type GitRefReader,
} from '../../../src/vcs/resolve-base-branch.js';
import { GitLabProvider } from '../../../src/vcs/gitlab.js';
import type { VcsProvider } from '../../../src/vcs/provider.js';

const SRC_DIR = fileURLToPath(new URL('../../../src/', import.meta.url));

/** Every `.ts` under `src/`, keyed by its path relative to `src/`. */
function sourceTree(): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        sources.set(relative(SRC_DIR, full).split('\\').join('/'), readFileSync(full, 'utf-8'));
      }
    }
  };
  walk(SRC_DIR);
  return sources;
}

/**
 * The names of the sources carrying `needle`, sorted.
 *
 * Takes its subject as an argument so the same scan the live assertion runs can
 * be pointed at a seeded violation.
 */
function filesContaining(sources: ReadonlyMap<string, string>, needle: string): string[] {
  return [...sources]
    .filter(([, source]) => source.includes(needle))
    .map(([file]) => file)
    .sort();
}

/** A provider whose only interesting method is `getRepository`. */
function makeProvider(getRepository: VcsProvider['getRepository']): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    addReply: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    searchIssuesByMarker: vi.fn(),
    getRepository,
  };
}

const noGit: GitRefReader = () => null;

/**
 * The reader keyed by git SUBCOMMAND, because the resolver now asks several
 * questions and a stub that answers them all with one string cannot tell a
 * ladder that stopped early from one that fell all the way through — it would
 * make the rung order untestable and would feed `refs/heads/main` to a rung that
 * expects a bare branch name.
 */
type GitSubcommand = 'symbolic-ref' | 'remote' | 'config' | 'rev-parse';
type GitAnswers = Partial<Record<GitSubcommand, string | null>>;

function gitStub(answers: GitAnswers): GitRefReader {
  return (_repoRoot, args) => answers[args[0] as GitSubcommand] ?? null;
}

/** The common case: only `symbolic-ref` answers. */
const gitReturning = (stdout: string): GitRefReader => gitStub({ 'symbolic-ref': stdout });

describe('resolveBaseBranch', () => {
  it('PrefersProviderDefaultBranch', async () => {
    const provider = makeProvider(
      vi.fn().mockResolvedValue({ nameWithOwner: 'acme/widget', defaultBranch: 'trunk' }),
    );
    const runGit = vi.fn(gitReturning('refs/remotes/origin/develop\n'));

    const result = await resolveBaseBranch('/repo', provider, runGit);

    expect(result).toEqual({ kind: 'resolved', branch: 'trunk' });
    // The host answered, so git is never consulted.
    expect(runGit).not.toHaveBeenCalled();
  });

  it('FallsBackToSymbolicRef', async () => {
    const runGit = vi.fn(gitReturning('refs/remotes/origin/develop\n'));

    const result = await resolveBaseBranch('/repo', undefined, runGit);

    expect(result).toEqual({ kind: 'resolved', branch: 'develop' });
    expect(runGit).toHaveBeenCalledWith('/repo', ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  });

  it('Unresolved_IsTyped_NotMain', async () => {
    const result = await resolveBaseBranch('/repo', undefined, noGit);

    expect(result.kind).toBe('unresolved');
    expect(JSON.stringify(result)).not.toContain('"branch"');
    expect(result).not.toMatchObject({ branch: 'main' });
    if (result.kind === 'unresolved') {
      expect(result.reason).toContain('/repo');
    }
  });

  it('UnsupportedProviderOperation_IsNotACrash', async () => {
    // GitLab and Azure DevOps both throw UnsupportedOperationError here.
    const provider = new GitLabProvider({});
    await expect(provider.getRepository()).rejects.toThrow('getRepository is not yet supported');

    const result = await resolveBaseBranch('/repo', provider, gitReturning('refs/remotes/origin/develop\n'));

    expect(result).toEqual({ kind: 'resolved', branch: 'develop' });
  });

  it('RefNameFailingTheSanitizer_IsNotTrusted', async () => {
    const hostile = 'main;rm -rf /';
    const provider = makeProvider(
      vi.fn().mockResolvedValue({ nameWithOwner: 'acme/widget', defaultBranch: hostile }),
    );

    // Neither source is trusted on its own, so neither can be laundered into a
    // branch. Both floors have to reject it: the resolved name is interpolated
    // into a git invocation, and on Windows that can route through a shell.
    const fromProvider = await resolveBaseBranch('/repo', provider, noGit);
    const fromGit = await resolveBaseBranch(
      '/repo',
      undefined,
      gitReturning(`refs/remotes/origin/${hostile}\n`),
    );

    expect(fromProvider.kind).toBe('unresolved');
    expect(fromGit.kind).toBe('unresolved');
    expect(JSON.stringify([fromProvider, fromGit])).not.toContain('rm -rf');
  });

  it('HostedNonAsciiBranchName_IsNotDiscarded', async () => {
    // The host's typed record of its own default branch is real by
    // construction. An ASCII allowlist would reject this name, reporting
    // `unresolved` for a repository whose default branch plainly exists.
    const provider = makeProvider(
      vi.fn().mockResolvedValue({ nameWithOwner: 'acme/widget', defaultBranch: 'feature/日本語' }),
    );

    const result = await resolveBaseBranch('/repo', provider, noGit);

    expect(result).toEqual({ kind: 'resolved', branch: 'feature/日本語' });
  });

  it('RefOutsideTheOriginPrefix_IsNotLaundered', async () => {
    // `refs/heads/main` carries only allowlisted characters, so an unanchored
    // prefix strip hands the whole ref path back as if it were a branch name.
    const result = await resolveBaseBranch('/repo', undefined, gitReturning('refs/heads/main\n'));

    expect(result.kind).toBe('unresolved');
    expect(JSON.stringify(result)).not.toContain('refs/heads/main');
  });

  it('EmptyProviderDefaultBranch_FallsThrough', async () => {
    const provider = makeProvider(
      vi.fn().mockResolvedValue({ nameWithOwner: 'acme/widget', defaultBranch: '' }),
    );

    const result = await resolveBaseBranch('/repo', provider, gitReturning('refs/remotes/origin/develop\n'));

    expect(result).toEqual({ kind: 'resolved', branch: 'develop' });
  });

  // ─── The rungs below origin/HEAD ─────────────────────────────────────────

  it('NoOriginHead_TheRemoteIsAskedDirectly', async () => {
    // `git init` + `git remote add` never writes `refs/remotes/origin/HEAD`, and
    // neither do most CI checkouts. One rung meant that whole population — real
    // repositories with perfectly ordinary default branches — resolved
    // `unresolved` and took their gates offline.
    const runGit = vi.fn(
      gitStub({ remote: 'HEAD branch: develop\n  Remote branches:\n    develop tracked\n' }),
    );

    const result = await resolveBaseBranch('/repo', undefined, runGit);

    expect(result).toEqual({ kind: 'resolved', branch: 'develop' });
    expect(runGit).toHaveBeenCalledWith('/repo', ['remote', 'show', 'origin']);
  });

  it('RemoteWithNoHead_IsNotABranchNamedUnknown', async () => {
    // `git remote show` prints a literal `(unknown)` for a remote with no HEAD.
    const result = await resolveBaseBranch(
      '/repo',
      undefined,
      gitStub({ remote: 'HEAD branch: (unknown)\n' }),
    );

    expect(result.kind).toBe('unresolved');
    expect(JSON.stringify(result)).not.toContain('unknown)');
  });

  it('LocalRefWins_AndTheNetworkIsNeverTouched', async () => {
    // Trust order, and cost order with it: a local ref that already records the
    // remote's HEAD makes the round trip pointless.
    const runGit = vi.fn(
      gitStub({
        'symbolic-ref': 'refs/remotes/origin/trunk\n',
        remote: 'HEAD branch: develop\n',
      }),
    );

    const result = await resolveBaseBranch('/repo', undefined, runGit);

    expect(result).toEqual({ kind: 'resolved', branch: 'trunk' });
    expect(runGit).not.toHaveBeenCalledWith('/repo', ['remote', 'show', 'origin']);
  });

  it('InferredDefault_IsAcceptedOnlyAfterTheBranchIsSeenToExist', async () => {
    // `init.defaultBranch` describes what name NEW repositories get, so it is a
    // guess about THIS one. Confirming the branch exists is what separates the
    // guess from the invented literal this seam replaced.
    const runGit = vi.fn(
      gitStub({ config: 'trunk\n', 'rev-parse': 'a1b2c3d4\n' }),
    );

    const result = await resolveBaseBranch('/repo', undefined, runGit);

    expect(result).toEqual({ kind: 'resolved', branch: 'trunk' });
    expect(runGit).toHaveBeenCalledWith('/repo', [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/trunk',
    ]);
  });

  it('InferredDefault_NamingAMissingBranch_IsNoAnswer', async () => {
    // The guess named `trunk`; this repository does not have it. Returning it
    // would be the invented literal wearing a config file as a disguise.
    const result = await resolveBaseBranch(
      '/repo',
      undefined,
      gitStub({ config: 'trunk\n', 'rev-parse': null }),
    );

    expect(result.kind).toBe('unresolved');
    expect(JSON.stringify(result)).not.toContain('trunk');
  });

  it('UnresolvedReason_NamesEverySignalAndItsTrustClass', async () => {
    // The reason is the only thing an operator sees when a gate reports that it
    // could not scope itself. It has to say which knobs were consulted, and
    // which of them would have been a guess.
    const result = await resolveBaseBranch('/repo', undefined, noGit);

    expect(result.kind).toBe('unresolved');
    if (result.kind !== 'unresolved') return;
    for (const signal of [
      'symbolic-ref',
      'git remote show origin',
      'init.defaultBranch',
      'authoritative',
      'inferred',
    ]) {
      expect(result.reason, `the reason must name '${signal}'`).toContain(signal);
    }
  });
});

describe('resolveDiffBase', () => {
  it('ExplicitRefWins_AndNeverAsksGit', async () => {
    // A caller that already named its base has answered the question. Consulting
    // git anyway would spawn a subprocess per gate invocation for nothing.
    const result = await resolveDiffBase('/repo', 'release/2026.09');

    expect(result).toEqual({ kind: 'resolved', branch: 'release/2026.09' });
  });

  it('BlankExplicitRef_IsNoAnswer_NotABranch', async () => {
    // `''` and `'  '` reach here from optional schema fields and from callers
    // threading an unset value. Treating either as a ref would build
    // `git diff '   ...HEAD'`.
    for (const blank of ['', '   ']) {
      const result = await resolveDiffBase('/definitely-not-a-repo-xyz', blank);
      expect(result.kind, `blank ref ${JSON.stringify(blank)} must not resolve`).toBe(
        'unresolved',
      );
    }
  });

  it('AbsentExplicitRef_FallsThroughToDetection', async () => {
    // No provider is passed by a diff-reading gate, so detection is the git arm.
    // Pointing at a path that is not a repository exercises the failure edge
    // without a fixture: git cannot answer, and the answer is typed.
    const result = await resolveDiffBase('/definitely-not-a-repo-xyz', undefined);

    expect(result.kind).toBe('unresolved');
    expect(JSON.stringify(result)).not.toContain('"branch"');
  });

  it('DiscriminantText_LivesInExactlyOnePlace', () => {
    // Several gate carriers stamp this discriminant, and asserting the constant
    // equals its own literal proves nothing about them: rename it and both sides
    // move together, so the assertion stays green while a hand-typed copy
    // elsewhere becomes a SECOND spelling of the same inconclusive verdict.
    //
    // What catches that is the absence of copies — every carrier reaches the
    // text by importing the constant, so a rename cannot leave one behind.
    const sources = sourceTree();

    // Guard the guard on the DENOMINATOR: a moved directory reports zero
    // holders for the same reason a clean tree does.
    expect(
      sources.size,
      'no sources were read — the scan resolved nothing, so its result proves nothing',
    ).toBeGreaterThan(100);

    expect(
      filesContaining(sources, BASE_BRANCH_UNRESOLVED),
      'the discriminant text belongs to its declaration alone; carriers import ' +
        'the constant',
    ).toEqual(['vcs/resolve-base-branch.ts']);
  });

  it('SeededCopyOfTheDiscriminant_IsDetected', () => {
    // The same scan over a subject that must fail, so the assertion above is
    // known to be capable of failing at all.
    const seeded = new Map([
      ['carrier.ts', `  discriminant: '${BASE_BRANCH_UNRESOLVED}',\n`],
      ['innocent.ts', '  discriminant: SOME_OTHER_CAUSE,\n'],
    ]);

    expect(filesContaining(seeded, BASE_BRANCH_UNRESOLVED)).toEqual(['carrier.ts']);
  });
});
