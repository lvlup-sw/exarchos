import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { assertExarchosMcpOnPath } from './preflight.js';

describe('assertExarchosMcpOnPath', () => {
  it('AssertExarchosMcpOnPath_BinaryResolvable_DoesNotThrow', () => {
    // `node` is guaranteed to be on PATH since vitest itself runs on node.
    expect(() => assertExarchosMcpOnPath('node')).not.toThrow();
  });

  it('AssertExarchosMcpOnPath_BinaryMissing_ThrowsActionableError', () => {
    const sentinel = 'exarchos-mcp-definitely-not-real-' + crypto.randomUUID();
    let caught: unknown;
    try {
      assertExarchosMcpOnPath(sentinel);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(sentinel);
    expect(message).toContain('not found on PATH');
    // Must name the remediation command verbatim.
    expect(message).toContain('npm link');
  });

  it('AssertExarchosMcpOnPath_CustomCommand_UsesOverride', () => {
    // Passing a custom command exercises the override path. A known-good
    // override (`node`) should resolve; a known-bad override should fail with
    // its own name in the message, proving the override is actually consulted.
    expect(() => assertExarchosMcpOnPath('node')).not.toThrow();

    const sentinel = 'override-sentinel-' + crypto.randomUUID();
    expect(() => assertExarchosMcpOnPath(sentinel)).toThrowError(
      new RegExp(sentinel),
    );
  });
});
