import { describe, it, expect } from 'vitest';
import { runtimeNodeVersion } from './runtime-node-version.js';
import { makeStubProbes } from './__shared__/make-stub-probes.js';

const signal = new AbortController().signal;

describe('runtime-node-version', () => {
  it('RuntimeNodeVersion_AtLeast20_ReturnsPass', async () => {
    const probes = makeStubProbes({ runtime: { nodeVersion: 'v20.11.0' } });

    const result = await runtimeNodeVersion(probes, signal);

    expect(result.category).toBe('runtime');
    expect(result.name).toBe('node-version');
    expect(result.status).toBe('Pass');
    expect(result.message).toContain('v20.11.0');
    expect(result.fix).toBeUndefined();
  });

  it('RuntimeNodeVersion_Below20_ReturnsFail', async () => {
    const probes = makeStubProbes({ runtime: { nodeVersion: 'v18.17.0' } });

    const result = await runtimeNodeVersion(probes, signal);

    expect(result.status).toBe('Fail');
    expect(result.message).toContain('v18.17.0');
    expect(result.message).toContain('Node.js >= 20');
    expect(result.fix).toBe('Upgrade Node via nvm install 20 or your package manager');
  });
});
