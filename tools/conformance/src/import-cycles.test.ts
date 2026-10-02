// Runtime import-cycle gate.
//
// dependency-cruiser is the only acceptance instrument. With the default
// `tsPreCompilationDeps: false`, the graph counts runtime edges only: TS emit drops `import type`,
// and a dynamic `import()` counts. The gate runs depcruise over `src`, finds strongly connected
// components (Tarjan), and asserts no runtime cycle outside `tools/audit/cycle-baseline.json`.
//
// The run uses `spawnCommandSync`, which resolves the `npx` shim on win32. A depcruise test skips
// when the local binary is absent, when the spawn fails, or when depcruise prints nothing.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnAsync } from '../../test-helpers/spawn.js';
import { REPO_ROOT, SUBJECT_PACKAGE_ROOT } from './subject-root.js';
import {
  detectRuntimeCycles,
  scanRuntimeCycleGraph,
  EmptyCycleGraphError,
  runtimeEdgeExists,
  unbaselinedCycleEdges,
  phantomBaselineEntries,
  edgeKey,
  runForbiddenEdgeCensus,
  firstPartyModules,
  FORBIDDEN_RUNTIME_EDGES,
  type CycleBaseline,
  type ForbiddenEdgeRule,
} from './import-cycles.js';

/** depcruise runs from the subject package, so its graph paths stay `src/…`. */

const MCP_PACKAGE_ROOT = SUBJECT_PACKAGE_ROOT;
const DEPCRUISE_CONFIG = path.join(REPO_ROOT, '.dependency-cruiser.cjs');
const CYCLE_BASELINE_PATH = path.join(REPO_ROOT, 'tools', 'audit', 'cycle-baseline.json');

/** Paths in the depcruise graph are relative to the run directory, so first-party modules are `src/…`. */
const SRC_PREFIX = 'src';
const PROJECTION = 'src/projections/views/workflow-state-projection.ts';
const STATE_STORE = 'src/workflow/state-store.ts';

/** Per-test timeout for a depcruise test. A full `src` crawl takes several seconds. */
const DEPCRUISE_TIMEOUT_MS = 120_000;

/** Local depcruise binary — present in every real install of this package. */
function depcruiseBinPath(): string {
  const bin = process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise';
  return path.join(MCP_PACKAGE_ROOT, 'node_modules', '.bin', bin);
}

interface Capture {
  readonly available: boolean;
  readonly json: string;
}

let cached: Capture | undefined;

/**
 * Runs depcruise once (memoized) and returns its JSON stdout. It runs from the subject package
 * root, so `npx` resolves the local binary and the paths start with `src/`. The repo-root config
 * supplies the `.js` to `.ts` resolver. A spawn failure or an empty stdout makes the capture
 * unavailable, because a real graph always prints a `{ "modules": [...] }` document.
 */
async function captureGraph(): Promise<Capture> {
  if (cached) return cached;
  if (!existsSync(depcruiseBinPath())) {
    cached = { available: false, json: '' };
    return cached;
  }
  const result = await spawnAsync(
    'npx',
    ['depcruise', '--config', DEPCRUISE_CONFIG, '--output-type', 'json', SRC_PREFIX],
    { cwd: MCP_PACKAGE_ROOT },
  );
  const json = result.stdout;
  const available = result.error == null && json.trim().length > 0;
  cached = { available, json };
  return cached;
}

function loadBaseline(): CycleBaseline {
  const raw = JSON.parse(readFileSync(CYCLE_BASELINE_PATH, 'utf8')) as {
    entries?: CycleBaseline['entries'];
  };
  return { entries: raw.entries ?? [] };
}

describe('runtime import cycles (dependency-cruiser acceptance)', () => {
  /**
   * The failure names every runtime cycle edge that is not in the baseline. The fix is to break
   * the edge or to add a tracked baseline entry.
   */
  it(
    'importGraph_DepcruiseRuntimeEdges_ZeroUnbaselinedCycles',
    async (ctx) => {
      const capture = await captureGraph();
      if (!capture.available) {
        ctx.skip();
        return;
      }
      const cycles = detectRuntimeCycles(capture.json, SRC_PREFIX);
      const baseline = loadBaseline();
      const unbaselined = unbaselinedCycleEdges(cycles, baseline);

      expect(
        unbaselined.map(edgeKey),
        `Unbaselined runtime import cycle(s) detected. Break the cycle by ` +
          `extraction (preferred) or add a tracked entry to ` +
          `tools/audit/cycle-baseline.json. Cycles: ` +
          JSON.stringify(cycles, null, 2),
      ).toEqual([]);
    },
    DEPCRUISE_TIMEOUT_MS,
  );

  /**
   * The projection must not import the state store at runtime. The store calls
   * `workflowStateProjection.apply` in `reconcileFromEvents`, so a back-edge forms the mutual cycle
   * again. Both sides import the shared mutation helpers from the `workflow/state-mutation.ts`
   * leaf. The one-way store-to-projection edge is the positive control against an empty graph.
   */
  it(
    'stateStoreProjectionSeam_NoRuntimeBackEdge',
    async (ctx) => {
      const capture = await captureGraph();
      if (!capture.available) {
        ctx.skip();
        return;
      }
      expect(
        runtimeEdgeExists(capture.json, PROJECTION, STATE_STORE, SRC_PREFIX),
        `${PROJECTION} must not runtime-import ${STATE_STORE} — import the shared ` +
          `helpers from workflow/state-mutation.ts instead (DR-4).`,
      ).toBe(false);

      expect(
        runtimeEdgeExists(capture.json, STATE_STORE, PROJECTION, SRC_PREFIX),
      ).toBe(true);
    },
    DEPCRUISE_TIMEOUT_MS,
  );

  /**
   * The live graph forms no declared forbidden back-edge, and every rule names real modules. The
   * endpoint check is the positive control: it proves that each pinned seam exists.
   */
  it(
    'forbiddenRuntimeEdges_LiveGraph_NoPresentOrStaleRule',
    async (ctx) => {
      const capture = await captureGraph();
      if (!capture.available) {
        ctx.skip();
        return;
      }
      const result = runForbiddenEdgeCensus(capture.json, FORBIDDEN_RUNTIME_EDGES, SRC_PREFIX);
      expect(
        result.diagnostics,
        `Forbidden-edge census failed. Break the offending edge, or fix a stale ` +
          `rule whose module was renamed. Diagnostics: ` +
          JSON.stringify(result.diagnostics, null, 2),
      ).toEqual([]);
      expect(result.ok).toBe(true);

      const nodes = firstPartyModules(capture.json, SRC_PREFIX);
      for (const rule of FORBIDDEN_RUNTIME_EDGES) {
        expect(nodes.has(rule.from), `${rule.from} absent from graph`).toBe(true);
        expect(nodes.has(rule.to), `${rule.to} absent from graph`).toBe(true);
      }
    },
    DEPCRUISE_TIMEOUT_MS,
  );
});

/**
 * Pure detector tests over synthetic graphs, with no depcruise. They cover the cycle math where the
 * depcruise tests skip, with graphs that do and do not contain cycles.
 */
describe('detectRuntimeCycles', () => {
  const graph = (edges: Array<[string, string, string[]?]>): string =>
    JSON.stringify({
      modules: (() => {
        const bySource = new Map<string, Array<{ resolved: string; dependencyTypes: string[] }>>();
        for (const [from, to, types] of edges) {
          if (!bySource.has(from)) bySource.set(from, []);
          bySource.get(from)!.push({ resolved: to, dependencyTypes: types ?? ['local', 'import'] });
          if (!bySource.has(to)) bySource.set(to, []);
        }
        return [...bySource.entries()].map(([source, dependencies]) => ({ source, dependencies }));
      })(),
    });

  it('DetectRuntimeCycles_MutualRuntimePair_ReportsCycle', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/a.ts'],
    ]);
    const cycles = detectRuntimeCycles(json, 'src');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].members).toEqual(['src/a.ts', 'src/b.ts']);
    expect(cycles[0].edges.map(edgeKey).sort()).toEqual([
      'src/a.ts -> src/b.ts',
      'src/b.ts -> src/a.ts',
    ]);
  });

  it('DetectRuntimeCycles_AcyclicGraph_ReportsNone', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/c.ts'],
    ]);
    expect(detectRuntimeCycles(json, 'src')).toEqual([]);
  });

  /**
   * The scan reports its first-party population. `vendor/x.ts` and the edge to it are not
   * first-party, so the denominator counts only what the rule governs.
   */
  it('ScanRuntimeCycleGraph_ReportsTheFirstPartyPopulationItSearched', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/c.ts'],
      ['src/c.ts', 'vendor/x.ts'],
    ]);
    const scan = scanRuntimeCycleGraph(json, 'src');
    expect(scan.cycles).toEqual([]);
    expect(scan.nodeCount).toBe(3);
    expect(scan.edgeCount).toBe(2);
  });

  /**
   * `startsWith('src')` also matches `src-legacy/` and `src.bak/`. That puts modules of a tree that
   * the rule does not govern into the graph, with their cycles. The boundary is the separator, so
   * only `src/…` and `src` count, and a trailing separator on the prefix changes nothing.
   */
  it('ScanRuntimeCycleGraph_SiblingDirectorySharingThePrefix_IsNotFirstParty', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src-legacy/x.ts', 'src-legacy/y.ts'],
      ['src-legacy/y.ts', 'src-legacy/x.ts'],
      ['src.bak/p.ts', 'src.bak/q.ts'],
    ]);
    const scan = scanRuntimeCycleGraph(json, 'src');
    expect(scan.nodeCount).toBe(2);
    expect(scan.edgeCount).toBe(1);
    expect(scan.cycles).toEqual([]);

    expect(scanRuntimeCycleGraph(json, 'src/').nodeCount).toBe(2);
  });

  /**
   * Kill fixture. "No cycle" is the healthy answer, and a scan that resolved nothing returns it too.
   * Here the graph is well formed and not empty, and only the prefix is wrong. The scan must throw,
   * and the message must name the prefix and the module count of the graph.
   */
  it('ScanRuntimeCycleGraph_PrefixMatchingNothing_FailsClosed', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/a.ts'],
    ]);
    expect(() => scanRuntimeCycleGraph(json, 'servers/relocated/src')).toThrow(
      EmptyCycleGraphError,
    );
    expect(() => detectRuntimeCycles(json, 'servers/relocated/src')).toThrow(
      /indistinguishable from an acyclic tree/,
    );
    expect(() => detectRuntimeCycles(json, 'servers/relocated/src')).toThrow(
      /servers\/relocated\/src/,
    );
    expect(() => detectRuntimeCycles(json, 'servers/relocated/src')).toThrow(/2 module\(s\)/);
  });

  /** The degenerate twin: depcruise found no modules. That is a broken surface, not a clean one. */
  it('ScanRuntimeCycleGraph_EmptyModuleList_FailsClosed', () => {
    expect(() => scanRuntimeCycleGraph(JSON.stringify({ modules: [] }), 'src')).toThrow(
      EmptyCycleGraphError,
    );
  });

  /**
   * A `type-only` back-edge does not close a runtime cycle. The default depcruise config drops
   * these edges, and the detector guard keeps the rule explicit.
   */
  it('DetectRuntimeCycles_TypeOnlyBackEdge_ExcludedFromCycles', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts', ['local', 'import']],
      ['src/b.ts', 'src/a.ts', ['type-only']],
    ]);
    expect(detectRuntimeCycles(json, 'src')).toEqual([]);
  });

  /** A dynamic `import()` survives compilation, so it is a runtime edge. */
  it('DetectRuntimeCycles_DynamicImportBackEdge_CountsAsRuntime', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts', ['local', 'import']],
      ['src/b.ts', 'src/a.ts', ['local', 'dynamic-import']],
    ]);
    expect(detectRuntimeCycles(json, 'src')).toHaveLength(1);
  });

  /** Edges into or out of `node_modules` are not first-party, and the detector ignores them. */
  it('DetectRuntimeCycles_ThirdPartyEdges_Ignored', () => {
    const json = graph([
      ['src/a.ts', 'node_modules/zod/index.ts'],
      ['node_modules/zod/index.ts', 'src/a.ts'],
    ]);
    expect(detectRuntimeCycles(json, 'src')).toEqual([]);
  });

  it('UnbaselinedCycleEdges_BaselineCoversEdges_ReturnsEmpty', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/a.ts'],
    ]);
    const cycles = detectRuntimeCycles(json, 'src');
    const baseline: CycleBaseline = {
      entries: [
        { rule: 'no-circular', from: 'src/a.ts', to: 'src/b.ts', owner: 'x', rationale: 'y', issue: '#0', permanent: true },
        { rule: 'no-circular', from: 'src/b.ts', to: 'src/a.ts', owner: 'x', rationale: 'y', issue: '#0', permanent: true },
      ],
    };
    expect(unbaselinedCycleEdges(cycles, baseline)).toEqual([]);
  });

  it('UnbaselinedCycleEdges_PartialBaseline_ReturnsUncoveredEdge', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/a.ts'],
    ]);
    const cycles = detectRuntimeCycles(json, 'src');
    const baseline: CycleBaseline = {
      entries: [
        { rule: 'no-circular', from: 'src/a.ts', to: 'src/b.ts', owner: 'x', rationale: 'y', issue: '#0', permanent: true },
      ],
    };
    expect(unbaselinedCycleEdges(cycles, baseline).map(edgeKey)).toEqual(['src/b.ts -> src/a.ts']);
  });

  /**
   * A baselined edge that no current cycle uses is a phantom. It is stale cover that permits a
   * future cycle on that seam.
   */
  it('PhantomBaselineEntries_EdgeMatchesNoLiveCycle_ReportsEntry', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/a.ts'],
    ]);
    const cycles = detectRuntimeCycles(json, 'src');
    const phantom = { rule: 'no-circular', from: 'src/x.ts', to: 'src/y.ts', owner: 'x', rationale: 'y', issue: '#0', permanent: true as const };
    const baseline: CycleBaseline = {
      entries: [
        { rule: 'no-circular', from: 'src/a.ts', to: 'src/b.ts', owner: 'x', rationale: 'y', issue: '#0', permanent: true },
        { rule: 'no-circular', from: 'src/b.ts', to: 'src/a.ts', owner: 'x', rationale: 'y', issue: '#0', permanent: true },
        phantom,
      ],
    };
    expect(phantomBaselineEntries(cycles, baseline)).toEqual([phantom]);
  });

  it('PhantomBaselineEntries_EveryEntryLive_ReturnsEmpty', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/a.ts'],
    ]);
    const cycles = detectRuntimeCycles(json, 'src');
    const baseline: CycleBaseline = {
      entries: [
        { rule: 'no-circular', from: 'src/a.ts', to: 'src/b.ts', owner: 'x', rationale: 'y', issue: '#0', permanent: true },
        { rule: 'no-circular', from: 'src/b.ts', to: 'src/a.ts', owner: 'x', rationale: 'y', issue: '#0', permanent: true },
      ],
    };
    expect(phantomBaselineEntries(cycles, baseline)).toEqual([]);
  });
});

/**
 * Pure verdict tests for the forbidden back-edge registry, over synthetic graphs with no depcruise.
 * The `graph` builder copies the one in the detector tests.
 */
describe('runForbiddenEdgeCensus', () => {
  const graph = (edges: Array<[string, string]>): string =>
    JSON.stringify({
      modules: (() => {
        const bySource = new Map<string, Array<{ resolved: string; dependencyTypes: string[] }>>();
        for (const [from, to] of edges) {
          if (!bySource.has(from)) bySource.set(from, []);
          bySource.get(from)!.push({ resolved: to, dependencyTypes: ['local', 'import'] });
          if (!bySource.has(to)) bySource.set(to, []);
        }
        return [...bySource.entries()].map(([source, dependencies]) => ({ source, dependencies }));
      })(),
    });

  const rule: ForbiddenEdgeRule = {
    from: 'src/projections/views/projection.ts',
    to: 'src/workflow/store.ts',
    reason: 'would re-form the mutual cycle.',
  };

  /** The graph holds the legal one-way edge and then the forbidden back-edge. */
  it('flags a present forbidden edge as FORBIDDEN_RUNTIME_EDGE', () => {
    const json = graph([
      ['src/workflow/store.ts', 'src/projections/views/projection.ts'],
      ['src/projections/views/projection.ts', 'src/workflow/store.ts'],
    ]);
    const result = runForbiddenEdgeCensus(json, [rule], 'src');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['FORBIDDEN_RUNTIME_EDGE']);
  });

  it('passes when the forbidden edge is absent but both endpoints exist', () => {
    const json = graph([['src/workflow/store.ts', 'src/projections/views/projection.ts']]);
    const result = runForbiddenEdgeCensus(json, [rule], 'src');
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  /** `store.ts` is absent from the graph, so the rule protects nothing. */
  it('flags a rule whose endpoint is absent from the graph as STALE_FORBIDDEN_EDGE', () => {
    const json = graph([['src/projections/views/projection.ts', 'src/other/leaf.ts']]);
    const result = runForbiddenEdgeCensus(json, [rule], 'src');
    expect(result.ok).toBe(false);
    const stale = result.diagnostics.find((d) => d.code === 'STALE_FORBIDDEN_EDGE');
    expect(stale && 'missing' in stale && stale.missing).toBe('to');
  });

  it('firstPartyModules returns every local source and resolved target node', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'node_modules/zod/index.ts'],
    ]);
    const nodes = firstPartyModules(json, 'src');
    expect([...nodes].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(nodes.has('node_modules/zod/index.ts')).toBe(false);
  });

  it('the shipped FORBIDDEN_RUNTIME_EDGES registry is non-empty and well-formed', () => {
    expect(FORBIDDEN_RUNTIME_EDGES.length).toBeGreaterThan(0);
    for (const r of FORBIDDEN_RUNTIME_EDGES) {
      expect(r.from).toMatch(/^src\//);
      expect(r.to).toMatch(/^src\//);
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});
