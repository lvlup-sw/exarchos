import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCommandSync } from '../utils/process.js';
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

// ─── Runtime Import-Cycle Regression Gate (DR-4, debloat task 009) ───────────
//
// dependency-cruiser is the SOLE acceptance instrument. The repo config's
// default `tsPreCompilationDeps: false` makes the graph count RUNTIME edges only
// (`import type` elided by TS emit; dynamic `import()` counted). This gate shells
// depcruise over `src`, detects strongly-connected components (Tarjan), and
// asserts zero runtime cycles outside `scripts/audit/cycle-baseline.json`.
//
// The depcruise run rides the `.cmd`-shim spawn class (`spawnCommandSync` →
// win32-correct `npx`) with a per-test timeout well ABOVE the child budget: this
// test runs in the blocking `test-windows` MCP lane, where a full `src` crawl is
// several seconds. depcruise is a hard devDependency of this package; the run is
// skipped (INV-4 degrade discipline) ONLY when the local binary is genuinely
// absent — never a false failure, never a silent pass in CI where it is present.

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <repo>/servers/exarchos-mcp/src/architecture → up 2 to the package root.
const MCP_PACKAGE_ROOT = path.resolve(here, '..', '..');
// up 2 more to the repo root, where `.dependency-cruiser.cjs` lives.
const REPO_ROOT = path.resolve(MCP_PACKAGE_ROOT, '..', '..');
const DEPCRUISE_CONFIG = path.join(REPO_ROOT, '.dependency-cruiser.cjs');
const CYCLE_BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'audit', 'cycle-baseline.json');

// Paths in the depcruise graph are relative to the run cwd (the MCP package
// root), so first-party modules are `src/…`.
const SRC_PREFIX = 'src';
const PROJECTION = 'src/views/workflow-state-projection.ts';
const STATE_STORE = 'src/workflow/state-store.ts';

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
 * Run depcruise once (memoized) and return its JSON stdout. Runs from the MCP
 * package root so `npx` resolves the local binary and the emitted paths are
 * `src/…`-relative; the repo-root config supplies the `.js`→`.ts` resolver.
 */
function captureGraph(): Capture {
  if (cached) return cached;
  if (!existsSync(depcruiseBinPath())) {
    cached = { available: false, json: '' };
    return cached;
  }
  const result = spawnCommandSync(
    'npx',
    ['depcruise', '--config', DEPCRUISE_CONFIG, '--output-type', 'json', SRC_PREFIX],
    {
      cwd: MCP_PACKAGE_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // A spawn failure (ENOENT / shim missing) → degrade to unavailable. A ran-but-
  // nonzero exit with empty stdout is treated the same; a real graph always
  // yields a `{ "modules": [...] }` document on stdout.
  const json = typeof result.stdout === 'string' ? result.stdout : '';
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
  it(
    'importGraph_DepcruiseRuntimeEdges_ZeroUnbaselinedCycles',
    (ctx) => {
      const capture = captureGraph();
      if (!capture.available) {
        ctx.skip();
        return;
      }
      const cycles = detectRuntimeCycles(capture.json, SRC_PREFIX);
      const baseline = loadBaseline();
      const unbaselined = unbaselinedCycleEdges(cycles, baseline);

      // Fail LOUD: name every unbaselined runtime cycle edge so a regression is
      // actionable (either break the edge or add a tracked baseline entry).
      expect(
        unbaselined.map(edgeKey),
        `Unbaselined runtime import cycle(s) detected. Break the cycle by ` +
          `extraction (preferred) or add a tracked entry to ` +
          `scripts/audit/cycle-baseline.json. Cycles: ` +
          JSON.stringify(cycles, null, 2),
      ).toEqual([]);
    },
    DEPCRUISE_TIMEOUT_MS,
  );

  it(
    'stateStoreProjectionSeam_NoRuntimeBackEdge',
    (ctx) => {
      const capture = captureGraph();
      if (!capture.available) {
        ctx.skip();
        return;
      }
      // The projection MUST NOT runtime-import the state store: the store
      // value-imports the projection's `apply` (`reconcileFromEvents`), so any
      // projection→store runtime edge re-forms the mutual cycle. The shared
      // mutation primitives live in the `workflow/state-mutation.ts` leaf both
      // sides import instead.
      expect(
        runtimeEdgeExists(capture.json, PROJECTION, STATE_STORE, SRC_PREFIX),
        `${PROJECTION} must not runtime-import ${STATE_STORE} — import the shared ` +
          `helpers from workflow/state-mutation.ts instead (DR-4).`,
      ).toBe(false);

      // Positive control: the one-way store→projection edge is expected to
      // remain (the store folds events through the projection's `apply`). This
      // guards against a vacuous pass where depcruise simply saw no edges.
      expect(
        runtimeEdgeExists(capture.json, STATE_STORE, PROJECTION, SRC_PREFIX),
      ).toBe(true);
    },
    DEPCRUISE_TIMEOUT_MS,
  );

  it(
    'forbiddenRuntimeEdges_LiveGraph_NoPresentOrStaleRule',
    (ctx) => {
      const capture = captureGraph();
      if (!capture.available) {
        ctx.skip();
        return;
      }
      // EXIT PROOF (a): the live graph forms none of the declared forbidden
      // back-edges AND every declared rule names real modules (no stale guard).
      const result = runForbiddenEdgeCensus(capture.json, FORBIDDEN_RUNTIME_EDGES, SRC_PREFIX);
      expect(
        result.diagnostics,
        `Forbidden-edge census failed. Break the offending edge, or fix a stale ` +
          `rule whose module was renamed. Diagnostics: ` +
          JSON.stringify(result.diagnostics, null, 2),
      ).toEqual([]);
      expect(result.ok).toBe(true);

      // The rule's endpoints must be REAL nodes — otherwise the guard is vacuous
      // and would (correctly) report STALE_FORBIDDEN_EDGE above. This asserts the
      // positive control that the seam being pinned actually exists.
      const nodes = firstPartyModules(capture.json, SRC_PREFIX);
      for (const rule of FORBIDDEN_RUNTIME_EDGES) {
        expect(nodes.has(rule.from), `${rule.from} absent from graph`).toBe(true);
        expect(nodes.has(rule.to), `${rule.to} absent from graph`).toBe(true);
      }
    },
    DEPCRUISE_TIMEOUT_MS,
  );
});

// ─── Pure detector unit tests (no depcruise; run everywhere) ─────────────────
// These pin the graph-theory core independently of the shelled tool, so the
// contract stays covered even where depcruise is skipped, and the cycle math is
// exercised against synthetic graphs that DO and DO NOT contain cycles.

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

  // ── DR-8 / task 079 — "no cycle" and "nothing examined" are different ──────
  //
  // Cycle detection has no natural tooth of its own. "No cycle" is the healthy
  // answer, so it is also what a scan that resolved nothing returns — and a
  // `srcPrefix` matching nothing is an easy, silent way to get there. The
  // blocking CI consumer printed `OK: 0 runtime cycle(s)` and exited 0 on it.

  it('ScanRuntimeCycleGraph_ReportsTheFirstPartyPopulationItSearched', () => {
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src/b.ts', 'src/c.ts'],
      ['src/c.ts', 'vendor/x.ts'],
    ]);
    const scan = scanRuntimeCycleGraph(json, 'src');
    expect(scan.cycles).toEqual([]);
    // Three first-party nodes; `vendor/x.ts` is not one, and neither is the edge
    // reaching it — so the denominator counts what the rule actually governs.
    expect(scan.nodeCount).toBe(3);
    expect(scan.edgeCount).toBe(2);
  });

  it('ScanRuntimeCycleGraph_SiblingDirectorySharingThePrefix_IsNotFirstParty', () => {
    // `startsWith('src')` also matches `src-legacy/` and `src.bak/`, which drags
    // modules from a tree this rule does not govern into the graph — and any
    // cycle among them is reported against the governed tree. The boundary is
    // the separator, so only `src/…` (and `src` itself) counts.
    const json = graph([
      ['src/a.ts', 'src/b.ts'],
      ['src-legacy/x.ts', 'src-legacy/y.ts'],
      ['src-legacy/y.ts', 'src-legacy/x.ts'],
      ['src.bak/p.ts', 'src.bak/q.ts'],
    ]);
    const scan = scanRuntimeCycleGraph(json, 'src');
    expect(scan.nodeCount).toBe(2);
    expect(scan.edgeCount).toBe(1);
    // …and the sibling's genuine cycle is not attributed to the governed tree.
    expect(scan.cycles).toEqual([]);

    // A trailing separator on the prefix is the same prefix.
    expect(scanRuntimeCycleGraph(json, 'src/').nodeCount).toBe(2);
  });

  it('ScanRuntimeCycleGraph_PrefixMatchingNothing_FailsClosed', () => {
    // KILL FIXTURE. The graph is well-formed and non-empty; only the prefix is
    // wrong (a relocated tree, a renamed package directory, a depcruise run
    // scoped elsewhere). Before this arm the answer was `[]` — byte-identical to
    // the acyclic case directly above.
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
    // The message carries both sides of the disagreement — the prefix that
    // resolved nothing, and the module count the graph did report.
    expect(() => detectRuntimeCycles(json, 'servers/relocated/src')).toThrow(
      /servers\/relocated\/src/,
    );
    expect(() => detectRuntimeCycles(json, 'servers/relocated/src')).toThrow(/2 module\(s\)/);
  });

  it('ScanRuntimeCycleGraph_EmptyModuleList_FailsClosed', () => {
    // The degenerate twin: depcruise emitted a valid document that found nothing
    // at all. Also a broken surface, not a clean one.
    expect(() => scanRuntimeCycleGraph(JSON.stringify({ modules: [] }), 'src')).toThrow(
      EmptyCycleGraphError,
    );
  });

  it('DetectRuntimeCycles_TypeOnlyBackEdge_ExcludedFromCycles', () => {
    // A `type-only` back-edge does not close a RUNTIME cycle (import-type is not
    // a runtime dependency). depcruise's default config already elides these;
    // the detector's guard keeps the semantics explicit.
    const json = graph([
      ['src/a.ts', 'src/b.ts', ['local', 'import']],
      ['src/b.ts', 'src/a.ts', ['type-only']],
    ]);
    expect(detectRuntimeCycles(json, 'src')).toEqual([]);
  });

  it('DetectRuntimeCycles_DynamicImportBackEdge_CountsAsRuntime', () => {
    // Dynamic `import()` survives compilation and IS a runtime edge.
    const json = graph([
      ['src/a.ts', 'src/b.ts', ['local', 'import']],
      ['src/b.ts', 'src/a.ts', ['local', 'dynamic-import']],
    ]);
    expect(detectRuntimeCycles(json, 'src')).toHaveLength(1);
  });

  it('DetectRuntimeCycles_ThirdPartyEdges_Ignored', () => {
    // Edges into / out of node_modules are not first-party and never counted.
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

  it('PhantomBaselineEntries_EdgeMatchesNoLiveCycle_ReportsEntry', () => {
    // A baselined edge that no current cycle exercises is a PHANTOM — stale
    // cover that would silently pre-authorize a future cycle on that seam.
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

// ─── Forbidden runtime back-edge registry (P07-06) ───────────────────────────
// Pure verdict tests over synthetic graphs, so the cycle-prevention enforcement
// is covered independently of the shelled tool. The `graph` builder mirrors the
// detector tests above (a `resolved`/`source` module doc depcruise would emit).

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
    from: 'src/views/projection.ts',
    to: 'src/workflow/store.ts',
    reason: 'would re-form the mutual cycle.',
  };

  it('flags a present forbidden edge as FORBIDDEN_RUNTIME_EDGE', () => {
    const json = graph([
      ['src/workflow/store.ts', 'src/views/projection.ts'], // legal one-way edge
      ['src/views/projection.ts', 'src/workflow/store.ts'], // the forbidden back-edge
    ]);
    const result = runForbiddenEdgeCensus(json, [rule], 'src');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['FORBIDDEN_RUNTIME_EDGE']);
  });

  it('passes when the forbidden edge is absent but both endpoints exist', () => {
    const json = graph([['src/workflow/store.ts', 'src/views/projection.ts']]);
    const result = runForbiddenEdgeCensus(json, [rule], 'src');
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('flags a rule whose endpoint is absent from the graph as STALE_FORBIDDEN_EDGE', () => {
    // `store.ts` never appears (renamed away) — the guard protects nothing.
    const json = graph([['src/views/projection.ts', 'src/other/leaf.ts']]);
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
