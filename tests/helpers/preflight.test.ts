import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { assertExarchosOnPath, assertExarchosVersion } from './preflight.js';
import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';

/**
 * Timeout for the tests that spawn a real `where` or `which` lookup.
 * On a loaded Windows runner, one lookup can take longer than the 5 s vitest default.
 * The budget absorbs host latency. It does not bound the assertion.
 */
const PATH_LOOKUP_TIMEOUT_MS = 30_000 * WIN32_SPAWN_HEADROOM;

describe('assertExarchosOnPath', () => {
  /** `node` is on PATH, because vitest runs on node. */
  it('AssertExarchosOnPath_BinaryResolvable_DoesNotThrow', async () => {
    await expect(assertExarchosOnPath('node')).resolves.toBeUndefined();
  }, PATH_LOOKUP_TIMEOUT_MS);

  /** The error is actionable when it names the install script. */
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
    expect(message).toMatch(/get-exarchos\.sh/);
  }, PATH_LOOKUP_TIMEOUT_MS);

  /**
   * A good override (`node`) resolves. A bad override fails with its own name in the
   * message, which proves that the function reads the override.
   */
  it('AssertExarchosOnPath_CustomCommand_UsesOverride', async () => {
    await expect(assertExarchosOnPath('node')).resolves.toBeUndefined();

    const sentinel = 'override-sentinel-' + crypto.randomUUID();
    await expect(assertExarchosOnPath(sentinel)).rejects.toThrowError(
      new RegExp(sentinel),
    );
  }, PATH_LOOKUP_TIMEOUT_MS);

  /** With an empty PATH, no binary resolves, `exarchos` included. */
  it('assertExarchosOnPath_missingBinary_throwsActionableError', async () => {
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
  /**
   * The stub resolver reports an older release. The error must name the expected
   * major.minor and the actual version.
   */
  it('assertExarchosVersion_staleBinary_throwsVersionMismatch', async () => {
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

  /** A pre-release tag such as `2.12.0-rc.3` compares on major.minor only. */
  it('AssertExarchosVersion_PrereleaseSuffix_DoesNotThrow', async () => {
    const stub = async () => '2.12.0-rc.3';
    await expect(
      assertExarchosVersion({ resolveVersion: stub }),
    ).resolves.toBeUndefined();
  });
});
