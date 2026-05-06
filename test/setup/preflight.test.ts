import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { assertExarchosOnPath } from './preflight.js';

describe('assertExarchosOnPath', () => {
  it('AssertExarchosOnPath_BinaryResolvable_DoesNotThrow', () => {
    // `node` is guaranteed to be on PATH since vitest itself runs on node.
    expect(() => assertExarchosOnPath('node')).not.toThrow();
  });

  it('AssertExarchosOnPath_BinaryMissing_ThrowsActionableError', () => {
    const sentinel = 'exarchos-definitely-not-real-' + crypto.randomUUID();
    let caught: unknown;
    try {
      assertExarchosOnPath(sentinel);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(sentinel);
    expect(message).toContain('not found on PATH');
    // Must name a v2.9 install remediation verbatim.
    expect(message).toMatch(/npm link|get-exarchos\.sh/);
  });

  it('AssertExarchosOnPath_CustomCommand_UsesOverride', () => {
    // Passing a custom command exercises the override path. A known-good
    // override (`node`) should resolve; a known-bad override should fail with
    // its own name in the message, proving the override is actually consulted.
    expect(() => assertExarchosOnPath('node')).not.toThrow();

    const sentinel = 'override-sentinel-' + crypto.randomUUID();
    expect(() => assertExarchosOnPath(sentinel)).toThrowError(
      new RegExp(sentinel),
    );
  });

  it('assertExarchosOnPath_missingBinary_throwsActionableError', () => {
    // Empty PATH guarantees no binary (including `exarchos`) resolves.
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '';
      let caught: unknown;
      try {
        assertExarchosOnPath();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain('exarchos');
      expect(message).toMatch(/npm link|get-exarchos\.sh/);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
