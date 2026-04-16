import { describe, it, expect } from 'vitest';
import type { DispatchContext } from '../../core/dispatch.js';
import { buildProbes } from './probes.js';

/** Minimal DispatchContext fake. Only fields buildProbes reads are set. */
function fakeContext(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    stateDir: '/tmp/state-dir',
    eventStore: { append: () => {} } as unknown as DispatchContext['eventStore'],
    enableTelemetry: false,
    ...overrides,
  };
}

describe('buildProbes', () => {
  it('BuildProbes_FromDispatchContext_ReturnsProbesWithDetectorBound', () => {
    const ctx = fakeContext();

    const probes = buildProbes(ctx);

    expect(typeof probes.detector).toBe('function');
  });

  it('BuildProbes_FromDispatchContext_ReturnsProbesWithEventStoreBound', () => {
    const marker = { append: () => {}, __marker: 'identity' };
    const ctx = fakeContext({ eventStore: marker as unknown as DispatchContext['eventStore'] });

    const probes = buildProbes(ctx);

    expect(probes.eventStore).toBe(marker);
  });

  it('BuildProbes_FromDispatchContext_ReturnsGitProbeWithWhichIsRepoAndVersion', () => {
    const ctx = fakeContext();

    const probes = buildProbes(ctx);

    expect(typeof probes.git.which).toBe('function');
    expect(typeof probes.git.isRepo).toBe('function');
    expect(typeof probes.git.version).toBe('function');
  });

  it('BuildProbes_SqliteRunIntegrityCheck_DelegatesToEventStore', async () => {
    const sentinel = { ok: 'skipped' as const, reason: 'test-marker' };
    const recorded: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
    const fakeStore = {
      append: () => {},
      runIntegrityCheck: async (opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
        recorded.push(opts ?? {});
        return sentinel;
      },
    };
    const ctx = fakeContext({ eventStore: fakeStore as unknown as DispatchContext['eventStore'] });

    const probes = buildProbes(ctx);
    const result = await probes.sqlite.runIntegrityCheck({ timeoutMs: 777 });

    expect(result).toBe(sentinel);
    expect(recorded).toEqual([{ timeoutMs: 777 }]);
  });
});
