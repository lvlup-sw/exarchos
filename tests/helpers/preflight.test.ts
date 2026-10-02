import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { assertExarchosOnPath, assertExarchosVersion } from './preflight.js';
import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';

/**
 * Budget for the tests that really spawn `where`/`which` via `execFileAsync`.
 *
 * Vitest's 5s default is a poor fit here: each test spawns a real lookup
 * process. On a loaded Windows runner (`where.exe` under a cold PATH scan, with an
 * antivirus filter in the open path) a single lookup has been observed past
 * that default, which reds the lane for a reason unrelated to what these tests
 * assert. The budget is generous because it exists to absorb host latency, not
 * to bound the assertion.
 */
const PATH_LOOKUP_TIMEOUT_MS = 30_000 * WIN32_SPAWN_HEADROOM;

describe('assertExarchosOnPath', () => {
  it('AssertExarchosOnPath_BinaryResolvable_DoesNotThrow', async () => {
    // `node` is guaranteed to be on PATH since vitest itself runs on node.
    await expect(assertExarchosOnPath('node')).resolves.toBeUndefined();
  }, PATH_LOOKUP_TIMEOUT_MS);

  it('AssertExarchosOnPath_BinaryMissing_ThrowsActionableError', async () => {
    const sentinel = 'exarchos-definitely-not-real-' + crypto.randomUUID();
    let caught: unknown;
    try {
      await assertExarchosOnPath(sentinel);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(sentinel);
    expect(message).toContain('not found on PATH');
    // Must name a v2.10 install remediation verbatim.
    expect(message).toMatch(/get-exarchos\.sh/);
  }, PATH_LOOKUP_TIMEOUT_MS);

  it('AssertExarchosOnPath_CustomCommand_UsesOverride', async () => {
    // Passing a custom command exercises the override path. A known-good
    // override (`node`) should resolve; a known-bad override should fail with
    // its own name in the message, proving the override is actually consulted.
    await expect(assertExarchosOnPath('node')).resolves.toBeUndefined();

    const sentinel = 'override-sentinel-' + crypto.randomUUID();
    await expect(assertExarchosOnPath(sentinel)).rejects.toThrowError(
      new RegExp(sentinel),
    );
  }, PATH_LOOKUP_TIMEOUT_MS);

  it('assertExarchosOnPath_missingBinary_throwsActionableError', async () => {
    // Empty PATH guarantees no binary (including `exarchos`) resolves.
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '';
      let caught: unknown;
      try {
        await assertExarchosOnPath();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain('exarchos');
      expect(message).toMatch(/get-exarchos\.sh/);
    } finally {
      process.env.PATH = savedPath;
    }
  }, PATH_LOOKUP_TIMEOUT_MS);
});

describe('assertExarchosVersion', () => {
  it('assertExarchosVersion_staleBinary_throwsVersionMismatch', async () => {
    // Stub the version resolver to simulate a binary that advertises an
    // older release. The check must reject with both the expected
    // major.minor and the actual version named in the message.
    const stub = async () => '2.8.3';
    let caught: unknown;
    try {
      await assertExarchosVersion({ resolveVersion: stub });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('2.12');
    expect(message).toContain('2.8.3');
  });

  it('AssertExarchosVersion_MatchingMajorMinor_DoesNotThrow', async () => {
    const stub = async () => '2.12.7';
    await expect(
      assertExarchosVersion({ resolveVersion: stub }),
    ).resolves.toBeUndefined();
  });

  it('AssertExarchosVersion_PrereleaseSuffix_DoesNotThrow', async () => {
    // Pre-release tags (e.g. `2.12.0-rc.3`) must compare on major.minor only.
    const stub = async () => '2.12.0-rc.3';
    await expect(
      assertExarchosVersion({ resolveVersion: stub }),
    ).resolves.toBeUndefined();
  });
});
