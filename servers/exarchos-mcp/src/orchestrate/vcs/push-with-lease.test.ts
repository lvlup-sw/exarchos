import { describe, it, expect, vi } from 'vitest';
import {
  buildForceWithLeaseArgs,
  buildPushWithLease,
  parseLsRemoteSha,
  readRemoteSha,
  resolveExpectedSha,
  type RunGit,
} from './push-with-lease.js';

// A valid 40-hex git SHA used throughout the explicit-form assertions.
const OBSERVED_SHA = 'a'.repeat(40);
const REMOTE_SHA = 'b'.repeat(40);

describe('buildForceWithLeaseArgs', () => {
  it('PushWithLease_EmitsExplicitShaForm', () => {
    const args = buildForceWithLeaseArgs('feat/x', OBSERVED_SHA);

    // The lease MUST carry the explicit `=<ref>:<sha>` payload …
    expect(args).toContain(`--force-with-lease=feat/x:${OBSERVED_SHA}`);
    // … and the full argv must be exactly the expected push command.
    expect(args).toEqual([
      'push',
      `--force-with-lease=feat/x:${OBSERVED_SHA}`,
      'origin',
      'feat/x',
    ]);

    // NEVER a bare `--force-with-lease` (the stale-lease footgun this guards).
    expect(args).not.toContain('--force-with-lease');
    expect(args.some((a) => a === '--force-with-lease')).toBe(false);
  });

  it('honors a custom remote', () => {
    const args = buildForceWithLeaseArgs('feat/x', OBSERVED_SHA, 'upstream');
    expect(args).toEqual([
      'push',
      `--force-with-lease=feat/x:${OBSERVED_SHA}`,
      'upstream',
      'feat/x',
    ]);
  });

  it('rejects an empty ref', () => {
    expect(() => buildForceWithLeaseArgs('', OBSERVED_SHA)).toThrow(/non-empty/);
  });

  it('rejects a ref with unsafe characters', () => {
    expect(() => buildForceWithLeaseArgs('feat/x; rm -rf /', OBSERVED_SHA)).toThrow(
      /unsafe characters/,
    );
    expect(() => buildForceWithLeaseArgs('feat/x $(whoami)', OBSERVED_SHA)).toThrow(
      /unsafe characters/,
    );
  });

  it('rejects an empty or garbage expected SHA', () => {
    expect(() => buildForceWithLeaseArgs('feat/x', '')).toThrow(/non-empty/);
    expect(() => buildForceWithLeaseArgs('feat/x', 'not-a-sha')).toThrow(/hex git SHA/);
    // A 7-char short SHA is NOT acceptable — ls-remote always yields the full 40.
    expect(() => buildForceWithLeaseArgs('feat/x', 'abc1234')).toThrow(/hex git SHA/);
  });
});

describe('parseLsRemoteSha', () => {
  it('parses the leading SHA from an ls-remote line', () => {
    expect(parseLsRemoteSha(`${REMOTE_SHA}\trefs/heads/feat/x\n`)).toBe(REMOTE_SHA);
  });

  it('returns undefined for empty / whitespace stdout (branch absent)', () => {
    expect(parseLsRemoteSha('')).toBeUndefined();
    expect(parseLsRemoteSha('   \n  \n')).toBeUndefined();
  });

  it('returns undefined when the leading token is not a full SHA', () => {
    expect(parseLsRemoteSha('garbage\trefs/heads/feat/x')).toBeUndefined();
  });
});

describe('resolveExpectedSha', () => {
  it('PushWithLease_FreshLsRemote_AnchorsToObservedSha — falls back to ls-remote', () => {
    const runGit = vi.fn<RunGit>().mockReturnValue(`${REMOTE_SHA}\trefs/heads/feat/x\n`);

    const sha = resolveExpectedSha('feat/x', { runGit });

    expect(sha).toBe(REMOTE_SHA);
    expect(runGit).toHaveBeenCalledWith(['ls-remote', '--heads', 'origin', 'feat/x']);
  });

  it('prefers observedSha and never shells out when it is supplied', () => {
    const runGit = vi.fn<RunGit>();

    const sha = resolveExpectedSha('feat/x', { observedSha: OBSERVED_SHA, runGit });

    expect(sha).toBe(OBSERVED_SHA);
    expect(runGit).not.toHaveBeenCalled();
  });

  it('falls back to ls-remote when observedSha is not a valid SHA', () => {
    const runGit = vi.fn<RunGit>().mockReturnValue(`${REMOTE_SHA}\trefs/heads/feat/x\n`);

    const sha = resolveExpectedSha('feat/x', { observedSha: 'bogus', runGit });

    expect(sha).toBe(REMOTE_SHA);
    expect(runGit).toHaveBeenCalledOnce();
  });

  it('returns undefined when the branch is absent on the remote', () => {
    const runGit = vi.fn<RunGit>().mockReturnValue('');
    expect(resolveExpectedSha('feat/x', { runGit })).toBeUndefined();
  });
});

describe('readRemoteSha', () => {
  it('reads via git ls-remote --heads against the named remote', () => {
    const runGit = vi.fn<RunGit>().mockReturnValue(`${REMOTE_SHA}\trefs/heads/feat/x\n`);

    const sha = readRemoteSha('feat/x', 'upstream', runGit);

    expect(sha).toBe(REMOTE_SHA);
    expect(runGit).toHaveBeenCalledWith(['ls-remote', '--heads', 'upstream', 'feat/x']);
  });
});

describe('buildPushWithLease', () => {
  it('PushWithLease_FreshLsRemote_AnchorsToObservedSha — anchors to the ls-remote SHA', () => {
    const runGit = vi.fn<RunGit>().mockReturnValue(`${REMOTE_SHA}\trefs/heads/feat/x\n`);

    const result = buildPushWithLease('feat/x', { runGit });

    expect(result).toBeDefined();
    expect(result?.source).toBe('ls-remote');
    expect(result?.expectedSha).toBe(REMOTE_SHA);
    expect(result?.args).toEqual([
      'push',
      `--force-with-lease=feat/x:${REMOTE_SHA}`,
      'origin',
      'feat/x',
    ]);
    expect(result?.args).not.toContain('--force-with-lease');
  });

  it('prefers the observed SHA (source observed, no git call)', () => {
    const runGit = vi.fn<RunGit>();

    const result = buildPushWithLease('feat/x', { observedSha: OBSERVED_SHA, runGit });

    expect(result?.source).toBe('observed');
    expect(result?.expectedSha).toBe(OBSERVED_SHA);
    expect(result?.args).toEqual([
      'push',
      `--force-with-lease=feat/x:${OBSERVED_SHA}`,
      'origin',
      'feat/x',
    ]);
    expect(runGit).not.toHaveBeenCalled();
  });

  it('returns undefined when no SHA can be resolved (cannot build an explicit lease)', () => {
    const runGit = vi.fn<RunGit>().mockReturnValue('');
    expect(buildPushWithLease('feat/x', { runGit })).toBeUndefined();
  });
});
