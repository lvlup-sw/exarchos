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
 * Runs a read-only git command in `repoRoot` and hands back its stdout, or
 * `null` when git cannot answer (non-zero exit, missing repository, timeout).
 * Injected so every rung of the ladder below — including the one that talks to
 * the network — is exercisable without a fixture repo.
 */
export type GitRefReader = (repoRoot: string, args: readonly string[]) => string | null;

const ORIGIN_HEAD_REF = 'refs/remotes/origin/HEAD';
const ORIGIN_PREFIX = 'refs/remotes/origin/';

/** `git remote show origin` prints the remote's own HEAD on this line. */
const REMOTE_SHOW_HEAD = /^\s*HEAD branch:\s*(\S+)\s*$/m;

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

/**
 * Bounds every rung, including the one that reaches the network. A remote that
 * hangs must cost a gate a few seconds and then fall to the next signal, not
 * stall the run it was asked to scope.
 */
const GIT_READ_TIMEOUT_MS = 5_000;

const readGitRef: GitRefReader = (repoRoot, args) => {
  try {
    const stdout = runCommandSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: GIT_READ_TIMEOUT_MS,
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

// ─── The git ladder ─────────────────────────────────────────────────────────
//
// `symbolic-ref refs/remotes/origin/HEAD` is the cheapest local answer, and it
// is also the one that is MISSING most often: `git clone` writes it, but
// `git init` + `git remote add` never does, and neither do the shallow or
// detached checkouts most CI providers hand a job. One rung meant that whole
// population resolved `unresolved`, which — now that no literal stands behind
// it — takes a working gate offline on a repository that has a perfectly
// ordinary default branch.
//
// So the ladder is explicit about WHAT KIND of statement each rung makes:
//
//   authoritative — someone who knows the answer said it. The host's API
//                   record, the local ref git wrote from the remote's HEAD, and
//                   the remote's own reply to `git remote show`. Accepting one
//                   of these is reporting a fact.
//
//   inferred      — nobody stated this repository's default; the name is a
//                   guess assembled from a setting that describes something
//                   ELSE (`init.defaultBranch` says what name NEW repositories
//                   get). A guess is only ever accepted after the branch it
//                   names is confirmed to exist here, which is what keeps this
//                   from being the invented literal in a new costume: an
//                   inferred rung can be wrong about which branch is the
//                   default, but it can never name a branch the repository does
//                   not have.
//
// Deliberately NOT a rung: "there is exactly one remote-tracking branch, so
// that must be it". A `fetch-depth: 1` CI checkout has exactly one — the PR's
// own head — and diffing a branch against itself is empty, which reads as a
// clean pass. Elimination is only sound when the population is complete, and in
// a shallow checkout it never is.

type RungTrust = 'authoritative' | 'inferred';

interface GitRung {
  /** Names the signal in the unresolved reason, so a reader can go look. */
  readonly label: string;
  readonly trust: RungTrust;
  /** The candidate this signal yields, already trust-filtered, or `null`. */
  readonly read: (repoRoot: string, runGit: GitRefReader) => string | null;
}

/** Whether `name` is a branch this repository actually has. */
function branchExists(repoRoot: string, runGit: GitRefReader, name: string): boolean {
  for (const prefix of [ORIGIN_PREFIX, 'refs/heads/']) {
    const found = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${prefix}${name}`]);
    if (found !== null && found.trim().length > 0) return true;
  }
  return false;
}

const GIT_RUNGS: readonly GitRung[] = [
  {
    label: `git symbolic-ref ${ORIGIN_HEAD_REF}`,
    trust: 'authoritative',
    read: (repoRoot, runGit) => {
      // The command answers with a full ref UNDER that prefix. Anchor the strip:
      // an unanchored `.replace` hands anything else back whole, and
      // `refs/heads/main` passes the allowlist unscathed — a ref path laundered
      // into a branch name. A ref that is not under the prefix is no answer.
      const ref = runGit(repoRoot, ['symbolic-ref', ORIGIN_HEAD_REF])?.trim();
      return ref?.startsWith(ORIGIN_PREFIX)
        ? trustedGitRefName(ref.slice(ORIGIN_PREFIX.length))
        : null;
    },
  },
  {
    label: 'git remote show origin',
    trust: 'authoritative',
    read: (repoRoot, runGit) => {
      // Asks the remote directly, so it answers where no local ref was ever
      // written. It is a network round trip — bounded by the reader's timeout —
      // and it is only reached once the free local rung above has come up empty.
      // A remote with no HEAD prints `(unknown)`, which the allowlist rejects on
      // its parentheses without needing a case of its own.
      const shown = runGit(repoRoot, ['remote', 'show', 'origin']);
      return trustedGitRefName(shown?.match(REMOTE_SHOW_HEAD)?.[1]);
    },
  },
  {
    label: 'git config init.defaultBranch (verified to exist)',
    trust: 'inferred',
    read: (repoRoot, runGit) => {
      const configured = trustedGitRefName(
        runGit(repoRoot, ['config', '--get', 'init.defaultBranch'])?.trim(),
      );
      if (!configured) return null;
      return branchExists(repoRoot, runGit, configured) ? configured : null;
    },
  },
];

/**
 * Resolve the base branch of the repository at `repoRoot`: the host's own
 * `defaultBranch` when a provider supplies one, else the git ladder above,
 * else `unresolved`.
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

  for (const rung of GIT_RUNGS) {
    const branch = rung.read(repoRoot, runGit);
    if (branch) return { kind: 'resolved', branch };
  }

  // The reason enumerates what was asked, with each signal's trust class, so the
  // gate carrying it can tell an operator which knob would fix their repository
  // rather than only that something was missing.
  const tried = [
    `the VCS provider [${provider ? 'authoritative' : 'not supplied'}]`,
    ...GIT_RUNGS.map((rung) => `'${rung.label}' [${rung.trust}]`),
  ].join(', ');
  return {
    kind: 'unresolved',
    reason: `no default branch for '${repoRoot}': nothing answered — tried ${tried}`,
  };
}

/**
 * The discriminant a carrier stamps on itself when it could not learn which
 * branch its diff was supposed to be scoped against. Read by the gate verdict
 * normalizer through the generic skip descriptor, so it needs no arm of its own.
 */
export const BASE_BRANCH_UNRESOLVED = 'base-branch-unresolved';

/**
 * The base a diff-scoped caller should measure against: the ref it was handed,
 * else the repository's detected default branch.
 *
 * The precedence lives here rather than at each call site because "an explicit
 * ref wins" and "an absent one is detected, never invented" are one rule, and a
 * rule copied ten times is a rule that drifts. An explicit ref short-circuits
 * detection entirely: the caller already answered the question, so there is
 * nothing to ask git — which also keeps a caller that always supplies a base
 * free of a subprocess it never needed.
 */
export async function resolveDiffBase(
  repoRoot: string,
  explicit: string | undefined,
): Promise<BaseBranchResolution> {
  const given = explicit?.trim();
  if (given) return { kind: 'resolved', branch: given };
  return resolveBaseBranch(repoRoot);
}
