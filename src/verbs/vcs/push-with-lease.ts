/**
 * Builds a `git push --force-with-lease=<ref>:<sha>` with an explicit SHA. A bare
 * `--force-with-lease` leases against the local remote-tracking ref, which can be stale. The
 * explicit SHA comes from `assess_stack` or from a fresh `git ls-remote`, so the push fails when
 * the remote moved. The argv build is pure, and the git read sits behind an injectable runner.
 * No production call site uses this module yet.
 *
 * RESERVED(issue: #1596, owner: exarchos, expires: 2027-01-31). If no caller adopts this stub
 * before expiry, the module-intent gate fails until someone deletes it.
 */

import { execFileSync } from 'node:child_process';

/**
 * Safe ref characters, the same set as the branch sanitizer in `prepare-synthesis.ts` and
 * `extract-intent.ts`. It rejects shell metacharacters and refs that can add argv to the git call.
 */
const SAFE_REF_RE = /^[a-zA-Z0-9/_.-]+$/;

/** Full git object name: 40 lowercase hex. ls-remote always prints the full SHA. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function assertSafeRef(ref: string): void {
  if (ref.length === 0) {
    throw new Error('push-with-lease: ref must be a non-empty string');
  }
  if (!SAFE_REF_RE.test(ref)) {
    throw new Error(
      `push-with-lease: ref "${ref}" contains unsafe characters (allowed: ${SAFE_REF_RE.source})`,
    );
  }
}

function assertValidSha(sha: string): void {
  if (sha.length === 0) {
    throw new Error('push-with-lease: expectedSha must be a non-empty string');
  }
  if (!FULL_SHA_RE.test(sha)) {
    throw new Error(
      `push-with-lease: expectedSha "${sha}" is not a 40-char lowercase hex git SHA`,
    );
  }
}

/**
 * Returns `['push', '--force-with-lease=<ref>:<expectedSha>', <remote>, <ref>]`. It never emits a
 * bare `--force-with-lease`. A bad ref, remote or SHA throws, so the push cannot lose its anchor.
 */
export function buildForceWithLeaseArgs(
  ref: string,
  expectedSha: string,
  remote = 'origin',
): string[] {
  assertSafeRef(ref);
  assertValidSha(expectedSha);
  assertSafeRef(remote);
  return ['push', `--force-with-lease=${ref}:${expectedSha}`, remote, ref];
}

/**
 * Injectable git runner. It takes the argv without the `git` binary and returns stdout. The default
 * runs `execFileSync` with a 30-second timeout. Tests replace it, so they never reach a real remote.
 */
export type RunGit = (args: readonly string[]) => string;

const GIT_TIMEOUT_MS = 30_000;

const defaultRunGit: RunGit = (args) =>
  execFileSync('git', [...args], {
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/**
 * Returns the SHA on the first `<sha>\t<ref>` line of `git ls-remote --heads` output. It returns
 * `undefined` when the output is blank, because the branch is absent on the remote.
 */
export function parseLsRemoteSha(stdout: string): string | undefined {
  const firstLine = stdout.split('\n').find((line) => line.trim().length > 0);
  if (firstLine === undefined) return undefined;
  const [sha] = firstLine.trim().split(/\s+/, 1);
  return sha !== undefined && FULL_SHA_RE.test(sha) ? sha : undefined;
}

/**
 * Reads the current SHA of `<ref>` at `<remote>` with `git ls-remote --heads`. It returns
 * `undefined` when the branch is absent.
 */
export function readRemoteSha(
  ref: string,
  remote = 'origin',
  runGit: RunGit = defaultRunGit,
): string | undefined {
  assertSafeRef(ref);
  assertSafeRef(remote);
  const stdout = runGit(['ls-remote', '--heads', remote, ref]);
  return parseLsRemoteSha(stdout);
}

/** The source of the resolved expected SHA. */
export type ExpectedShaSource = 'observed' | 'ls-remote';

export interface ResolveExpectedShaOptions {
  /** Remote name. The default is `origin`. */
  readonly remote?: string;
  /**
   * The remote SHA that the shepherd loop last saw through `assess_stack`. A valid value wins,
   * because it is the SHA the loop used and it needs no network read.
   */
  readonly observedSha?: string | undefined;
  /** Injectable git runner. The default runs `execFileSync`. */
  readonly runGit?: RunGit;
}

/**
 * Returns a valid `observedSha`, or else the SHA from a fresh `git ls-remote`. It returns
 * `undefined` when neither gives a valid SHA. The caller must then not fall back to a bare lease.
 */
export function resolveExpectedSha(
  ref: string,
  options: ResolveExpectedShaOptions = {},
): string | undefined {
  assertSafeRef(ref);
  const { remote = 'origin', observedSha, runGit = defaultRunGit } = options;
  if (observedSha !== undefined && FULL_SHA_RE.test(observedSha)) {
    return observedSha;
  }
  return readRemoteSha(ref, remote, runGit);
}

export interface BuildPushWithLeaseResult {
  /** The `git push` argv (sans the `git` binary). */
  readonly args: string[];
  /** The expected SHA the lease is anchored to. */
  readonly expectedSha: string;
  /** Where that SHA came from. */
  readonly source: ExpectedShaSource;
}

/**
 * Resolves the expected SHA with {@link resolveExpectedSha}, then builds the push argv. It returns
 * `undefined` when no SHA resolves. A valid `observedSha` means that no git process runs.
 */
export function buildPushWithLease(
  ref: string,
  options: ResolveExpectedShaOptions = {},
): BuildPushWithLeaseResult | undefined {
  const { remote = 'origin', observedSha, runGit = defaultRunGit } = options;
  const source: ExpectedShaSource =
    observedSha !== undefined && FULL_SHA_RE.test(observedSha) ? 'observed' : 'ls-remote';
  const expectedSha = resolveExpectedSha(ref, { remote, observedSha, runGit });
  if (expectedSha === undefined) return undefined;
  return {
    args: buildForceWithLeaseArgs(ref, expectedSha, remote),
    expectedSha,
    source,
  };
}
