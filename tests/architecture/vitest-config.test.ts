import { describe, it, expect } from 'vitest';
import vitestConfig from '../../vitest.config.js';

/** The root config's projects, as `defineConfig` leaves them. */
function projects(): Array<{ test?: { name?: string; testTimeout?: number; hookTimeout?: number } }> {
  const cfg = vitestConfig as unknown as {
    test?: { projects?: Array<{ test?: { name?: string; testTimeout?: number; hookTimeout?: number } }> };
  };
  return cfg.test?.projects ?? [];
}

// The value type says `number | undefined` rather than `?:` because that is
// what reading an absent key yields: under `exactOptionalPropertyTypes` an
// optional property and one present-but-undefined are different types, and a
// project that declares no timeout produces the second.
function timeoutsByName(): Map<string, { testTimeout: number | undefined; hookTimeout: number | undefined }> {
  const entries: Array<[string, { testTimeout: number | undefined; hookTimeout: number | undefined }]> = [];
  for (const p of projects()) {
    const name = p.test?.name;
    // Narrowed by the read, which also retires the `as string` this replaces.
    if (typeof name !== 'string') continue;
    entries.push([name, { testTimeout: p.test?.testTimeout, hookTimeout: p.test?.hookTimeout }]);
  }
  return new Map(entries);
}

describe('vitest.config', () => {
  it('VitestConfig_DeclaresOutcomeProject_Exists', () => {
    const names = projects()
      .map((p) => p.test?.name)
      .filter((n): n is string => typeof n === 'string');
    expect(names).toContain('outcome');
  });

  it('VitestConfig_EveryProject_DeclaresExplicitTestTimeout', () => {
    // WFQ-015: the timeout policy must be stated, not implicit. Every project
    // declares an explicit numeric `testTimeout` so no tier silently inherits
    // vitest's 5000ms default.
    expect(projects().length).toBeGreaterThan(0);
    for (const project of projects()) {
      const name = project.test?.name ?? '(unnamed)';
      expect(
        typeof project.test?.testTimeout,
        `project "${name}" must declare an explicit numeric testTimeout`,
      ).toBe('number');
    }
    const byName = timeoutsByName();
    expect(byName.get('unit')?.testTimeout).toBe(5000);
    expect(byName.get('process')?.testTimeout).toBe(15000);
    expect(byName.get('outcome')?.testTimeout).toBe(30000);
  });

  // WFQ-015 (P07-07): the Windows-headroom tier states its policy explicitly
  // too. It was the nested `servers/exarchos-mcp` workspace's top-level
  // `test.testTimeout` until task 019 dissolved that package; the knob was
  // carried onto the `core` project verbatim, so this asserts the same fact
  // about the same tier — only the file it lives in changed.
  it('VitestConfig_CoreTier_DeclaresExplicitTimeouts', () => {
    const core = timeoutsByName().get('core');
    expect(core, 'the core project must exist — it carries the dissolved workspace policy').toBeDefined();
    expect(
      typeof core?.testTimeout,
      'the core tier must declare an explicit numeric testTimeout',
    ).toBe('number');
    expect(
      typeof core?.hookTimeout,
      'the core tier must declare an explicit numeric hookTimeout',
    ).toBe('number');
    // Windows-headroom tier (#1620): 60s, above every other tier so the
    // windows-latest fs + better-sqlite3 + spawn latency has slack.
    expect(core?.testTimeout).toBe(60000);
    expect(core?.hookTimeout).toBe(60000);
  });

  // The tiers form ONE coherent, monotonic timeout policy:
  //   unit 5s < process 15s < outcome 30s < core (Windows headroom) 60s.
  // No tier silently inherits the implicit default.
  it('VitestConfig_TieredTimeoutPolicy_IsCoherent', () => {
    const byName = timeoutsByName();
    const ladder = [
      byName.get('unit')?.testTimeout,
      byName.get('process')?.testTimeout,
      byName.get('outcome')?.testTimeout,
      byName.get('core')?.testTimeout,
    ];
    for (const rung of ladder) {
      expect(typeof rung).toBe('number');
    }
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i] as number).toBeGreaterThan(ladder[i - 1] as number);
    }
    expect(ladder).toEqual([5000, 15000, 30000, 60000]);
  });
});
