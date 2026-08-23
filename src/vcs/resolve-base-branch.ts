// ─── Base-Branch Resolution ──────────────────────────────────────────────────
//
// One seam answering "what does this repository call its default branch".
//
// The answer is either a name that was DETECTED or a typed `unresolved` — never
// an invented literal. A gate that silently diffs against a branch the governed
// repository does not have reports a scoped verdict it never actually scoped;
// `unresolved` is what lets it say so instead.
// ─────────────────────────────────────────────────────────────────────────────

import { runCommandSync } from '../utils/process.js';
import type { VcsProvider } from './provider.js';

/**
 * The repository's detected default branch, or a statement that nothing
 * answered. Two arms only: a fallback string arm is the defect this replaces.
 */
export type BaseBranchResolution =
  | { readonly kind: 'resolved'; readonly branch: string }
  | { readonly kind: 'unresolved'; readonly reason: string };

/**
 * Reads a git ref from `repoRoot`, or `null` when git cannot answer. Injected so
 * the fallback and rejected-ref arms are exercisable without a fixture repo.
 */
export type GitRefReader = (repoRoot: string, args: readonly string[]) => string | null;

const ORIGIN_HEAD_REF = 'refs/remotes/origin/HEAD';
const ORIGIN_PREFIX = 'refs/remotes/origin/';

// The two arms answer from different trust classes, so they need different
// rules; holding both to one rule is what silently discards a real branch.
//
// The git arm parses a name out of a command's stdout — whatever the process
// wrote, in whatever state the repository is in. It keeps the strict ALLOWLIST
// both private detectors applied before this seam replaced them: trusted only
// when every character is one an ordinary git ref carries.
//
// The provider arm is the host's own typed record of its default branch,
// returned by an API call rather than scraped. That name is real by
// construction, and the allowlist rejects real ones — `feature/日本語` is a
// branch GitHub will happily carry. So this arm gets a safety FLOOR instead:
// reject what cannot be a git ref or could escape into a shell, and accept
// every other name the host reports.
//
// Both floors exist because callers interpolate the result into a git
// invocation, and on Windows `runCommandSync` routes shim commands through a
// shell. An untrusted name counts as no answer rather than as a branch.

const TRUSTED_REF_NAME = /^[a-zA-Z0-9/_.-]+$/;

/**
 * Characters and sequences a hosted branch name must not carry: ASCII control
 * codes and whitespace, the punctuation git itself forbids in a ref name, the
 * shell metacharacters that could break out of an argument, and git's revision
 * syntax (`..`, `@{`) which would re-point a range rather than name a branch.
 */
const UNSAFE_IN_BRANCH_NAME = /[\p{Cc}\s~^:?*[\\;&|$`'"<>(){}!]|\.\.|@\{/u;

function trustedGitRefName(candidate: string | undefined): string | null {
  const name = candidate?.trim();
  if (!name) return null;
  return TRUSTED_REF_NAME.test(name) ? name : null;
}

function safeHostedBranchName(candidate: string | undefined): string | null {
  const name = candidate?.trim();
  if (!name) return null;
  return UNSAFE_IN_BRANCH_NAME.test(name) ? null : name;
}

const readGitRef: GitRefReader = (repoRoot, args) => {
  try {
    const stdout = runCommandSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return typeof stdout === 'string' ? stdout : stdout.toString('utf-8');
  } catch {
    return null;
  }
};

/**
 * A provider that cannot answer is not a failure: the GitLab and Azure DevOps
 * partials throw `UnsupportedOperationError` from `getRepository`, and a network
 * or auth fault is equally just "no answer" — resolution falls through to git.
 */
async function providerDefaultBranch(provider: VcsProvider): Promise<string | undefined> {
  try {
    return (await provider.getRepository()).defaultBranch;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the base branch of the repository at `repoRoot`: the host's own
 * `defaultBranch` when a provider supplies one, else `origin/HEAD`, else
 * `unresolved`.
 *
 * `runGit` is a test seam; production callers pass two arguments.
 */
export async function resolveBaseBranch(
  repoRoot: string,
  provider?: VcsProvider,
  runGit: GitRefReader = readGitRef,
): Promise<BaseBranchResolution> {
  if (provider) {
    const hosted = safeHostedBranchName(await providerDefaultBranch(provider));
    if (hosted) return { kind: 'resolved', branch: hosted };
  }

  // `symbolic-ref refs/remotes/origin/HEAD` answers with a full ref UNDER that
  // prefix. Anchor the strip: an unanchored `.replace` hands anything else back
  // whole, and `refs/heads/main` passes the allowlist unscathed — a ref path
  // laundered into a branch name. A ref that is not under the prefix is no
  // answer.
  const ref = runGit(repoRoot, ['symbolic-ref', ORIGIN_HEAD_REF])?.trim();
  const local = ref?.startsWith(ORIGIN_PREFIX)
    ? trustedGitRefName(ref.slice(ORIGIN_PREFIX.length))
    : null;
  if (local) return { kind: 'resolved', branch: local };

  return {
    kind: 'unresolved',
    reason:
      `no default branch for '${repoRoot}': neither the VCS provider nor ` +
      `'git symbolic-ref ${ORIGIN_HEAD_REF}' returned a trusted ref name`,
  };
}
