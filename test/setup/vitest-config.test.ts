import { describe, it, expect } from 'vitest';
import vitestConfig, { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import mcpVitestConfig from '../../servers/exarchos-mcp/vitest.config.js';

/** The tier policy in LINUX terms; win32 scales the ROOT rungs by the headroom. */
const BASE_UNIT = 5000;
const BASE_PROCESS = 15000;
const BASE_OUTCOME = 30000;
/** Not scaled — the MCP workspace's 60s was already chosen for Windows (#1620). */
const BASE_MCP = 60000;

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
    expect(byName.get('unit')).toBe(BASE_UNIT * WIN32_SPAWN_HEADROOM);
    expect(byName.get('process')).toBe(BASE_PROCESS * WIN32_SPAWN_HEADROOM);
    expect(byName.get('outcome')).toBe(BASE_OUTCOME * WIN32_SPAWN_HEADROOM);
  });

  it('VitestConfig_Win32_ScalesTheRootTiersForSpawnCost', () => {
    // #1699: the root tiers are calibrated on Linux, where all ten
    // `skills-guard.test.ts` tests finish in 423ms total; two of the SAME tests
    // take 5290ms and 10045ms each on the Windows runner. Without headroom the
    // lane fails by lottery — a different victim every run, always a timeout,
    // never an assertion. This pins the headroom so it cannot be quietly
    // reverted to a bare 5000 and reopen the class.
    if (process.platform === 'win32') {
      expect(WIN32_SPAWN_HEADROOM).toBeGreaterThan(1);
      // 3x slack over the worst observed victim (10045ms) at the unit tier.
      expect(BASE_UNIT * WIN32_SPAWN_HEADROOM).toBeGreaterThanOrEqual(30000);
    } else {
      // Elsewhere the tight budgets stand, so a genuine hang still fails fast
      // on the platform that runs most of the checks.
      expect(WIN32_SPAWN_HEADROOM).toBe(1);
    }
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
    // Stated in LINUX terms — the declared policy. On win32 the three ROOT rungs
    // scale uniformly by WIN32_SPAWN_HEADROOM (so their ordering is preserved),
    // while the MCP rung is left alone because its 60s already IS the Windows
    // allowance. Dividing the scaling back out is what keeps this a claim about
    // the policy rather than about whichever platform happens to run it.
    const ladder = [
      (rootByName.get('unit') as number) / WIN32_SPAWN_HEADROOM,
      (rootByName.get('process') as number) / WIN32_SPAWN_HEADROOM,
      (rootByName.get('outcome') as number) / WIN32_SPAWN_HEADROOM,
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
    expect(ladder).toEqual([BASE_UNIT, BASE_PROCESS, BASE_OUTCOME, BASE_MCP]);
  });
});
