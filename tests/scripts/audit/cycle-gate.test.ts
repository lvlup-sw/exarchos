import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  runCycleGate,
  loadCycleBaseline,
  detectCyclesOrThrow,
  CycleGraphParseError,
  EXIT_OK,
  EXIT_VIOLATIONS,
  EXIT_GATE_ERROR,
  EmptyCycleGraphError,
  type DepcruiseRun,
  type CycleGateDeps,
} from '../../../tools/audit/cycle-gate.js';

/**
 * Builds a depcruise `--output-type json` document from a list of edges. A
 * runtime edge has no `type-only` entry in its dependency types. The detector
 * counts the runtime edges and ignores the rest. The fixtures use the `src/`
 * prefix, and the tests pass `srcPrefix: 'src'`.
 */
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

/** A mutual runtime cycle a<->b. Its two live edges are `src/a.ts -> src/b.ts` and back. */
const CYCLE_AB = graph([
  ['src/a.ts', 'src/b.ts'],
  ['src/b.ts', 'src/a.ts'],
]);
/** An acyclic graph — the real (zero-cycle) tree's shape. */
const ACYCLIC = graph([
  ['src/a.ts', 'src/b.ts'],
  ['src/b.ts', 'src/c.ts'],
]);

/** A permanent (never-expiring) baseline entry for `from -> to`. */
const edge = (from: string, to: string) => ({
  rule: 'no-circular',
  from,
  to,
  owner: '@reedsalus',
  rationale: 'accepted seam',
  issue: '#0',
  permanent: true as const,
});

/** An expiring baseline entry — `expires` set, `permanent` absent (XOR). */
const expiringEdge = (from: string, to: string, expires: string) => ({
  rule: 'no-circular',
  from,
  to,
  owner: '@reedsalus',
  rationale: 'accepted seam',
  issue: '#0',
  expires,
});

const foundRun = (stdout: string, code = 0): DepcruiseRun => ({
  found: true,
  code,
  stdout,
  stderr: '',
  binPath: '/repo/node_modules/.bin/depcruise',
});

function captureDeps(overrides: {
  run: DepcruiseRun;
  baseline: unknown;
  now?: Date;
  srcPrefix?: string;
}): { deps: CycleGateDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CycleGateDeps = {
    runDepcruise: () => overrides.run,
    readBaseline: () => overrides.baseline,
    now: overrides.now ?? new Date('2026-07-16T12:00:00.000Z'),
    log: (m) => out.push(m),
    errlog: (m) => err.push(m),
    srcPrefix: overrides.srcPrefix ?? 'src',
  };
  return { deps, out, err };
}

const baselineDoc = (entries: unknown[]): { entries: unknown[] } => ({ entries });

describe('detectCyclesOrThrow', () => {
  /** The scan also reports the node and edge counts, so a zero-cycle verdict shows the size of the graph. */
  it('parses a valid graph into runtime cycles', () => {
    const scan = detectCyclesOrThrow(CYCLE_AB, 'src');
    expect(scan.cycles).toHaveLength(1);
    expect(scan.nodeCount).toBeGreaterThan(0);
    expect(scan.edgeCount).toBeGreaterThan(0);
  });

  /**
   * Kill fixture. The graph parses, but the prefix matches no module. A moved
   * tree or a depcruise run on the wrong path gives this state. Without this
   * error, the node set and the cycle list are empty and the gate prints an OK
   * verdict. The phantom check does not catch that, because the baseline is
   * empty.
   */
  it('throws EmptyCycleGraphError when the prefix resolves no first-party node', () => {
    expect(() => detectCyclesOrThrow(CYCLE_AB, 'no/such/prefix')).toThrow(EmptyCycleGraphError);
    expect(() => detectCyclesOrThrow(CYCLE_AB, 'no/such/prefix')).toThrow(
      /indistinguishable from an acyclic tree/,
    );
  });

  it('throws CycleGraphParseError on empty output (fail-closed, not "acyclic")', () => {
    expect(() => detectCyclesOrThrow('   ', 'src')).toThrow(CycleGraphParseError);
  });

  it('throws CycleGraphParseError on non-JSON output', () => {
    expect(() => detectCyclesOrThrow('depcruise crashed <<<', 'src')).toThrow(CycleGraphParseError);
  });

  it('throws CycleGraphParseError when the top-level modules[] array is missing', () => {
    expect(() => detectCyclesOrThrow(JSON.stringify({ notModules: [] }), 'src')).toThrow(/modules\[\]/);
  });
});

describe('loadCycleBaseline', () => {
  it('validates entries against the shared edge-register contract', () => {
    const b = loadCycleBaseline(baselineDoc([edge('src/a.ts', 'src/b.ts')]));
    expect(b.entries).toHaveLength(1);
  });

  it('throws when an entry violates the shared schema (missing owner)', () => {
    const { owner: _drop, ...noOwner } = edge('src/a.ts', 'src/b.ts');
    expect(() => loadCycleBaseline(baselineDoc([noOwner]))).toThrow(/schema validation/);
  });

  it('throws when the top-level entries[] array is missing', () => {
    expect(() => loadCycleBaseline({ version: 1 })).toThrow(/entries\[\]/);
  });

  it('the SHIPPED cycle-baseline.json conforms to the schema (and is empty by design)', () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../tools/audit/cycle-baseline.json', import.meta.url)), 'utf8'),
    );
    const b = loadCycleBaseline(raw);
    expect(b.entries).toEqual([]);
  });
});

describe('runCycleGate — DR-4 failure modes', () => {
  it('SYNTHETIC CYCLE → FAIL (exit 1): an unbaselined live cycle', () => {
    const { deps, err } = captureDeps({ run: foundRun(CYCLE_AB), baseline: baselineDoc([]) });
    expect(runCycleGate(deps)).toBe(EXIT_VIOLATIONS);
    expect(err.join('\n')).toMatch(/unbaselined-cycle/);
    expect(err.join('\n')).toMatch(/src\/a\.ts -> src\/b\.ts/);
  });

  /** Both live edges are in the baseline with past dates, so only the `expired` mode fires. */
  it('EXPIRED baseline entry → FAIL (exit 1)', () => {
    const { deps, err } = captureDeps({
      run: foundRun(CYCLE_AB),
      baseline: baselineDoc([
        expiringEdge('src/a.ts', 'src/b.ts', '2020-01-01'),
        expiringEdge('src/b.ts', 'src/a.ts', '2020-01-01'),
      ]),
    });
    expect(runCycleGate(deps)).toBe(EXIT_VIOLATIONS);
    expect(err.join('\n')).toMatch(/expired/);
  });

  /**
   * Both live edges are in the baseline and are permanent. The extra entry
   * `src/x.ts -> src/y.ts` matches no live cycle, so only the `phantom` mode fires.
   */
  it('PHANTOM entry → FAIL (exit 1): a baselined edge matching no live cycle', () => {
    const { deps, err } = captureDeps({
      run: foundRun(CYCLE_AB),
      baseline: baselineDoc([
        edge('src/a.ts', 'src/b.ts'),
        edge('src/b.ts', 'src/a.ts'),
        edge('src/x.ts', 'src/y.ts'),
      ]),
    });
    expect(runCycleGate(deps)).toBe(EXIT_VIOLATIONS);
    expect(err.join('\n')).toMatch(/phantom/);
    expect(err.join('\n')).toMatch(/src\/x\.ts -> src\/y\.ts/);
  });

  it('TOOL-MISSING → FAIL CLOSED (exit 2, DR-8): depcruise binary absent', () => {
    const { deps, err } = captureDeps({
      run: { found: false, code: -1, stdout: '', stderr: 'ENOENT', binPath: '/repo/node_modules/.bin/depcruise' },
      baseline: baselineDoc([]),
    });
    expect(runCycleGate(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/tool-missing/);
    expect(err.join('\n')).toMatch(/dependency-cruiser binary not found/);
  });
});

describe('runCycleGate — additional fail-closed paths (DR-8)', () => {
  it('UNPARSEABLE-OUTPUT → FAIL CLOSED (exit 2) when depcruise emits garbage', () => {
    const { deps, err } = captureDeps({ run: foundRun('not json <<<', 1), baseline: baselineDoc([]) });
    expect(runCycleGate(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/unparseable-output/);
  });

  it('BAD-BASELINE → FAIL CLOSED (exit 2) when a baseline entry is malformed', () => {
    const { owner: _drop, ...noOwner } = edge('src/a.ts', 'src/b.ts');
    const { deps, err } = captureDeps({ run: foundRun(ACYCLIC), baseline: baselineDoc([noOwner]) });
    expect(runCycleGate(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/bad-baseline/);
  });

  /**
   * Kill fixture. The graph is well-formed and depcruise exits 0, but
   * `srcPrefix` matches no module. The gate must fail closed, and must print no
   * OK verdict for a tree that it did not examine.
   */
  it('EMPTY-GRAPH → FAIL CLOSED (exit 2) when the source root resolves no module', () => {
    const { deps, err, out } = captureDeps({
      run: foundRun(CYCLE_AB),
      baseline: baselineDoc([]),
      srcPrefix: 'servers/relocated/src',
    });
    expect(runCycleGate(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/empty-graph/);
    expect(err.join('\n')).toMatch(/No first-party module resolved/);
    expect(out.join('\n')).not.toMatch(/OK/);
  });
});

describe('runCycleGate — green path', () => {
  it('PASSES (exit 0) on the zero-cycle tree with an empty baseline', () => {
    const { deps, out } = captureDeps({ run: foundRun(ACYCLIC), baseline: baselineDoc([]) });
    expect(runCycleGate(deps)).toBe(EXIT_OK);
    expect(out.join('\n')).toMatch(/OK/);
  });

  it('PASSES (exit 0) when every live cycle edge is baselined & unexpired (no phantom)', () => {
    const { deps } = captureDeps({
      run: foundRun(CYCLE_AB),
      baseline: baselineDoc([edge('src/a.ts', 'src/b.ts'), edge('src/b.ts', 'src/a.ts')]),
    });
    expect(runCycleGate(deps)).toBe(EXIT_OK);
  });
});
