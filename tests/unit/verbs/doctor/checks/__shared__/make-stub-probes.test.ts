import { describe, it, expect } from 'vitest';
import type { AgentEnvironment } from '../../../../../../src/runtime/agent-environment-detector.js';
import { makeStubProbes } from '../../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';

describe('makeStubProbes', () => {
  /** Unlike the probes, a read of `env` does not throw. The record is empty, so callers read a missing key as unset. */
  it('MakeStubProbes_WithNoOverrides_ThrowsOnAnyProbeCall', () => {
    const probes = makeStubProbes();

    expect(() => probes.fs.readFile('/x')).toThrow(/probe not overridden: fs/);
    expect(() => probes.fs.stat('/x')).toThrow(/probe not overridden: fs/);
    expect(() => probes.git.which('git')).toThrow(/probe not overridden: git/);
    expect(() => probes.git.isRepo('/x')).toThrow(/probe not overridden: git/);
    expect(() => probes.git.version()).toThrow(/probe not overridden: git/);
    expect(() => probes.sqlite.runIntegrityCheck()).toThrow(
      /probe not overridden: sqlite/,
    );
    expect(() => probes.detector()).toThrow(/probe not overridden: detector/);
    expect(() => probes.eventStore.append({} as never)).toThrow(
      /probe not overridden: eventStore/,
    );
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

    expect(typeof probes.detector).toBe('function');
    expect(() => probes.git.which('git')).toThrow(/probe not overridden: git/);
    expect(() => probes.sqlite.runIntegrityCheck()).toThrow(
      /probe not overridden: sqlite/,
    );
    expect(() => probes.fs.readFile('/x')).toThrow(/probe not overridden: fs/);
  });
});
