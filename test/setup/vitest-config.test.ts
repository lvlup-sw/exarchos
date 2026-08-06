import { describe, it, expect } from 'vitest';
import vitestConfig from '../../vitest.config.js';
import mcpVitestConfig from '../../servers/exarchos-mcp/vitest.config.js';

describe('vitest.config', () => {
  it('VitestConfig_DeclaresOutcomeProject_Exists', () => {
    // The default export from `defineConfig` is a UserConfig-like object.
    // The `test.projects` array contains entries with their own `test.name`.
    const cfg = vitestConfig as unknown as {
      test?: { projects?: Array<{ test?: { name?: string } }> };
    };
    const projects = cfg.test?.projects ?? [];
    const names = projects
      .map((p) => p.test?.name)
      .filter((n): n is string => typeof n === 'string');
    expect(names).toContain('outcome');
  });

  it('VitestConfig_EveryProject_DeclaresExplicitTestTimeout', () => {
    // WFQ-015: the timeout policy must be stated, not implicit. Every root
    // project declares an explicit numeric `testTimeout` (unit 5s < process
    // 15s < outcome 30s) so no tier silently inherits vitest's 5000ms default.
    const cfg = vitestConfig as unknown as {
      test?: { projects?: Array<{ test?: { name?: string; testTimeout?: number } }> };
    };
    const projects = cfg.test?.projects ?? [];
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      const name = project.test?.name ?? '(unnamed)';
      expect(
        typeof project.test?.testTimeout,
        `project "${name}" must declare an explicit numeric testTimeout`,
      ).toBe('number');
    }
    // The declared policy is monotonic by tier severity.
    const byName = new Map(
      projects
        .filter((p) => typeof p.test?.name === 'string')
        .map((p) => [p.test!.name as string, p.test?.testTimeout]),
    );
    expect(byName.get('unit')).toBe(5000);
    expect(byName.get('process')).toBe(15000);
    expect(byName.get('outcome')).toBe(30000);
  });

  // WFQ-015 (P07-07): the nested `servers/exarchos-mcp` workspace must ALSO
  // state its timeout policy explicitly rather than leaning on vitest's implicit
  // 5000ms default. The MCP workspace is a single-tier config (no `projects`),
  // so the policy lives on its top-level `test.testTimeout` / `test.hookTimeout`.
  it('VitestConfig_McpWorkspace_DeclaresExplicitTimeouts', () => {
    const cfg = mcpVitestConfig as unknown as {
      test?: {
        testTimeout?: number;
        hookTimeout?: number;
        projects?: Array<{ test?: { name?: string; testTimeout?: number } }>;
      };
    };
    // The MCP workspace does not split into named tiers; if it ever does, every
    // tier must still declare an explicit timeout (same rule as the root).
    for (const project of cfg.test?.projects ?? []) {
      const name = project.test?.name ?? '(unnamed)';
      expect(
        typeof project.test?.testTimeout,
        `mcp project "${name}" must declare an explicit numeric testTimeout`,
      ).toBe('number');
    }
    expect(
      typeof cfg.test?.testTimeout,
      'the MCP workspace must declare an explicit numeric testTimeout',
    ).toBe('number');
    expect(
      typeof cfg.test?.hookTimeout,
      'the MCP workspace must declare an explicit numeric hookTimeout',
    ).toBe('number');
    // Windows-headroom tier (#1620): 60s, chosen above the root tiers so the
    // windows-latest fs + better-sqlite3 + spawn latency has slack.
    expect(cfg.test?.testTimeout).toBe(60000);
    expect(cfg.test?.hookTimeout).toBe(60000);
  });

  // The two workspaces form ONE coherent, monotonic tiered timeout policy:
  //   unit 5s < process 15s < outcome 30s < mcp (Windows headroom) 60s.
  // No tier — in either workspace — silently inherits the implicit default.
  it('VitestConfig_TieredTimeoutPolicy_IsCoherentAcrossBothWorkspaces', () => {
    const root = vitestConfig as unknown as {
      test?: { projects?: Array<{ test?: { name?: string; testTimeout?: number } }> };
    };
    const mcp = mcpVitestConfig as unknown as { test?: { testTimeout?: number } };
    const rootByName = new Map(
      (root.test?.projects ?? [])
        .filter((p) => typeof p.test?.name === 'string')
        .map((p) => [p.test!.name as string, p.test?.testTimeout]),
    );
    const ladder = [
      rootByName.get('unit'),
      rootByName.get('process'),
      rootByName.get('outcome'),
      mcp.test?.testTimeout,
    ];
    // Every rung is an explicit number.
    for (const rung of ladder) {
      expect(typeof rung).toBe('number');
    }
    // Strictly increasing by tier severity.
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i] as number).toBeGreaterThan(ladder[i - 1] as number);
    }
    expect(ladder).toEqual([5000, 15000, 30000, 60000]);
  });
});
