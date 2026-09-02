// ─── VCS Helper: explicit-SHA force-with-lease push (DR-4 / #1596) ───────────
//
// A bare `git push --force-with-lease` (no `=<ref>:<sha>`) leases against the
// LOCAL remote-tracking ref, which can be stale — it silently clobbers a
// concurrent push the loop never observed. The explicit
// `--force-with-lease=<ref>:<expected-sha>` form anchors the lease to a SHA the
// shepherd loop actually observed at the remote (via `assess_stack`, else a
// fresh `git ls-remote`), so the push fails closed when the remote has moved.
//
// This module locks that contract: PURE argv construction is split from the
// IMPURE git read of the remote SHA, with the git exec behind an injectable
// seam so tests never touch a real remote. Production call sites (the SDK push
// consolidation) adopt `buildPushWithLease` later — forward-compatible by
// design.

// RESERVED(issue: #1596, owner: exarchos, expires: 2027-01-31) — reserved dead stub; deletion at expiry if unadopted (DR-7 module-intent gate)

import { execFileSync } from 'node:child_process';

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Safe ref charset — mirrors the sanitizer used in `prepare-synthesis.ts` and
 * `extract-intent.ts`. Rejects shell-metacharacters and ref names that could
 * smuggle extra argv into the git invocation.
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

// ─── Pure argv construction ───────────────────────────────────────────────────

/**
 * Build the `git push` argv for an explicit-SHA force-with-lease.
 *
 * Returns `['push', '--force-with-lease=<ref>:<expectedSha>', <remote>, <ref>]`.
 * NEVER emits a bare `--force-with-lease` — the whole point of this helper is to
 * anchor the lease to an observed remote SHA. Inputs are validated (non-empty,
 * sanitized ref, 40-hex SHA); bad input throws rather than degrading to an
 * un-anchored push.
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

// ─── Git exec seam ─────────────────────────────────────────────────────────────

/**
 * Injectable git runner: takes the argv (sans the `git` binary) and returns
 * stdout as a string. Defaults to a synchronous `execFileSync` with a 30s
 * ceiling and piped stdio — tests override it so they never hit a real remote.
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
 * Parse the leading 40-hex SHA from `git ls-remote --heads` output. ls-remote
 * prints `<sha>\t<ref>` lines; an empty/whitespace stdout means the branch is
 * absent on the remote — return `undefined` so the caller knows there is no SHA
 * to anchor a lease to.
 */
export function parseLsRemoteSha(stdout: string): string | undefined {
  const firstLine = stdout.split('\n').find((line) => line.trim().length > 0);
  if (firstLine === undefined) return undefined;
  const [sha] = firstLine.trim().split(/\s+/, 1);
  return sha !== undefined && FULL_SHA_RE.test(sha) ? sha : undefined;
}

/**
 * Read the current SHA of `<ref>` at `<remote>` via `git ls-remote --heads`.
 * Mirrors the `remoteBranchExists` pattern in `workflow/compensation.ts`.
 * Returns `undefined` when the branch is absent (empty stdout). The git exec is
 * injectable so tests stub the network read.
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

// ─── Expected-SHA resolution ───────────────────────────────────────────────────

/** Where the resolved expected SHA came from — diagnostic for callers/tests. */
export type ExpectedShaSource = 'observed' | 'ls-remote';

export interface ResolveExpectedShaOptions {
  /** Remote name; defaults to `origin`. */
  readonly remote?: string;
  /**
   * The SHA the shepherd loop last observed at the remote (via `assess_stack`).
   * PREFERRED when present — it avoids a redundant network round-trip and uses
   * the exact SHA the loop reasoned about.
   */
  readonly observedSha?: string | undefined;
  /** Injectable git runner; defaults to a real `execFileSync`. */
  readonly runGit?: RunGit;
}

/**
 * Resolve the SHA to anchor the lease to. Prefers `observedSha` (the SHA the
 * shepherd loop last saw via `assess_stack`); falls back to a fresh
 * `git ls-remote` when absent. Returns `undefined` when neither yields a valid
 * SHA — the caller then knows it cannot build an explicit-SHA lease (and must
 * NOT silently degrade to a bare lease).
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

// ─── Convenience: resolve + build ──────────────────────────────────────────────

export interface BuildPushWithLeaseResult {
  /** The `git push` argv (sans the `git` binary). */
  readonly args: string[];
  /** The expected SHA the lease is anchored to. */
  readonly expectedSha: string;
  /** Where that SHA came from. */
  readonly source: ExpectedShaSource;
}

/**
 * Resolve the expected remote SHA (observed > fresh ls-remote), then build the
 * explicit-SHA force-with-lease argv. Returns `undefined` when no SHA can be
 * resolved — meaning an explicit-SHA lease cannot be built and the caller must
 * decide how to proceed rather than fall back to an un-anchored push.
 *
 * Kept pure-ish via the injectable `runGit` seam: with `observedSha` supplied,
 * no git process runs at all.
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
