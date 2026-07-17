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
  type DepcruiseRun,
  type CycleGateDeps,
} from './cycle-gate.js';

// ─── depcruise JSON graph builder ────────────────────────────────────────────
// A depcruise `--output-type json` document is `{ modules: [{ source,
// dependencies: [{ resolved, dependencyTypes }] }] }`. Runtime edges carry
// non-`type-only` dependencyTypes; the detector counts those and ignores the
// rest. Fixtures use the `src/` prefix and the tests pass `srcPrefix: 'src'`.
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
}): { deps: CycleGateDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CycleGateDeps = {
    runDepcruise: () => overrides.run,
    readBaseline: () => overrides.baseline,
    now: overrides.now ?? new Date('2026-07-16T12:00:00.000Z'),
    log: (m) => out.push(m),
    errlog: (m) => err.push(m),
    srcPrefix: 'src',
  };
  return { deps, out, err };
}

const baselineDoc = (entries: unknown[]): { entries: unknown[] } => ({ entries });

describe('detectCyclesOrThrow', () => {
  it('parses a valid graph into runtime cycles', () => {
    expect(detectCyclesOrThrow(CYCLE_AB, 'src')).toHaveLength(1);
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
      readFileSync(fileURLToPath(new URL('./cycle-baseline.json', import.meta.url)), 'utf8'),
    );
    const b = loadCycleBaseline(raw);
    expect(b.entries).toEqual([]);
  });
});

// ─── The FOUR DR-4 failure modes, one self-test each (BY NAME) ────────────────

describe('runCycleGate — DR-4 failure modes', () => {
  it('SYNTHETIC CYCLE → FAIL (exit 1): an unbaselined live cycle', () => {
    const { deps, err } = captureDeps({ run: foundRun(CYCLE_AB), baseline: baselineDoc([]) });
    expect(runCycleGate(deps)).toBe(EXIT_VIOLATIONS);
    expect(err.join('\n')).toMatch(/unbaselined-cycle/);
    expect(err.join('\n')).toMatch(/src\/a\.ts -> src\/b\.ts/);
  });

  it('EXPIRED baseline entry → FAIL (exit 1)', () => {
    // Both live edges are baselined (so no unbaselined / no phantom) but the
    // waivers have lapsed — isolates the `expired` mode.
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

  it('PHANTOM entry → FAIL (exit 1): a baselined edge matching no live cycle', () => {
    // Both live edges are baselined (no unbaselined) and all permanent (no
    // expired); the extra `src/x.ts -> src/y.ts` entry matches no live cycle —
    // isolates the `phantom` mode (the no-mask tooth).
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

// ─── The other DR-8 fail-closed paths + the green path ────────────────────────

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
