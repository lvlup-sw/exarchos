import { describe, it, expect } from 'vitest';
import type { AgentEnvironment } from '../../../../runtime/agent-environment-detector.js';
import { makeStubProbes } from './make-stub-probes.js';

describe('makeStubProbes', () => {
  it('MakeStubProbes_WithNoOverrides_ThrowsOnAnyProbeCall', () => {
    const probes = makeStubProbes();

    expect(() => probes.fs.readFile('/x')).toThrow(/probe not overridden: fs/);
    expect(() => probes.fs.stat('/x')).toThrow(/probe not overridden: fs/);
    expect(() => probes.git.which('git')).toThrow(/probe not overridden: git/);
    expect(() => probes.git.isRepo('/x')).toThrow(/probe not overridden: git/);
    expect(() => probes.git.version()).toThrow(/probe not overridden: git/);
    expect(() => probes.sqlite.handle()).toThrow(/probe not overridden: sqlite/);
    expect(() => probes.detector()).toThrow(/probe not overridden: detector/);
    expect(() => probes.eventStore.append({} as never)).toThrow(
      /probe not overridden: eventStore/,
    );
    // env is a plain readonly record; accessing it should not throw, but it
    // is empty by default so callers treat missing keys as unset.
    expect(probes.env).toEqual({});
  });

  it('MakeStubProbes_WithDetectorOverride_CallsOverride', async () => {
    const fakeEnv: AgentEnvironment[] = [];
    let called = false;
    const probes = makeStubProbes({
      detector: async () => {
        called = true;
        return fakeEnv;
      },
    });

    const result = await probes.detector();

    expect(called).toBe(true);
    expect(result).toBe(fakeEnv);
  });

  it('MakeStubProbes_WithPartialOverride_UnoverriddenProbesStillThrow', () => {
    const probes = makeStubProbes({
      detector: async () => [],
    });

    // detector overridden: safe to call
    expect(typeof probes.detector).toBe('function');
    // other probes still throw
    expect(() => probes.git.which('git')).toThrow(/probe not overridden: git/);
    expect(() => probes.sqlite.handle()).toThrow(/probe not overridden: sqlite/);
    expect(() => probes.fs.readFile('/x')).toThrow(/probe not overridden: fs/);
  });
});
