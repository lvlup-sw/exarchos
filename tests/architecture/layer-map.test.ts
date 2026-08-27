import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLayerEdges } from '../../src/architecture/layer-boundaries-seam.js';
import { lexModule } from '../../tools/test-helpers/module-lexer.js';

// ─── The authoritative layer mapping (DR-2, task 010) ────────────────────────
//
// Every later move task in Phase 1 reads `tools/audit/layer-map.json` to decide
// where a directory goes. That makes this file the thing standing between "the
// map is the plan of record" and "each move task invents a placement and the
// map quietly describes a tree that no longer exists."
//
// Scope is read from DISK, never from the map. A map that simply omits a
// directory would otherwise be self-consistent and wrong — the same evasion the
// DR-30 oracle guards against, in a different costume.
//
// The 11 targets → 9 published layers relation is asserted as a RELATION, not as
// set equality, because task 044 asserts that specific shape: L5 is served by
// two directories (`contract` and `dispatch`), and `install` is a declared
// non-layer peer rather than a tenth layer.
//
// @oracle-sources: ../../tools/audit/layer-map.json, live-src-directory-listing

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const SRC = path.join(REPO_ROOT, 'src');
const MAP_PATH = path.join(REPO_ROOT, 'tools/audit/layer-map.json');

interface MappedEntry {
  readonly disposition: 'mapped';
  readonly target: string;
  readonly layer: string;
  readonly reason: string;
}
interface ExceptionEntry {
  readonly disposition: 'exception';
  readonly destination: string;
  readonly reason: string;
}
type Entry = MappedEntry | ExceptionEntry;

interface LayerMap {
  readonly tree: string;
  readonly counts: Record<string, number>;
  readonly publishedLayers: Record<string, { name: string; targets: string[] }>;
  readonly nonLayerPeers: Record<string, string>;
  readonly directories: Record<string, Entry>;
}

const map = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as LayerMap;

/** The live tree — the only authority on what directories exist. */
const liveDirs = readdirSync(SRC)
  .filter((d) => statSync(path.join(SRC, d)).isDirectory())
  .sort();

/** The 11 target buckets Phase 1 moves everything into. */
const TARGETS = [
  'storage',
  'events',
  'projections',
  'workflow',
  'contract',
  'dispatch',
  'verbs',
  'lifecycle',
  'adapters',
  'runtime',
  'install',
] as const;

describe('LayerMap_EveryCoreDirectory_MapsToALayerOrAStatedException', () => {
  it('the scan is not vacuous', () => {
    // A listing that returns nothing would make every assertion below trivially
    // true. The floor sits well under the measured 28 so ordinary consolidation
    // does not trip it, and well over zero. It was 40 against the pre-fold tree
    // of 44; task 019 consolidated to 28, which is the refactor working rather
    // than a regression — the floor tracks the tree, it does not pin its size.
    expect(liveDirs.length).toBeGreaterThan(20);
  });

  it('every directory on disk has an entry', () => {
    const unmapped = liveDirs.filter((d) => !(d in map.directories));
    expect(
      unmapped,
      'These exist under src/ but the layer map does not mention them. ' +
        'Every directory must map to one of the 11 targets or carry a stated exception — a ' +
        'directory the map cannot see is one no move task knows what to do with.',
    ).toEqual([]);
  });

  it('every entry names a directory that exists', () => {
    const phantom = Object.keys(map.directories).filter((d) => !liveDirs.includes(d));
    expect(
      phantom,
      'The map describes directories that are not on disk. Either they were moved without ' +
        'updating the map, or the map was written against a different tree.',
    ).toEqual([]);
  });

  it('every mapped directory names exactly one real target and a reason', () => {
    for (const dir of liveDirs) {
      const entry = map.directories[dir] as Entry;
      if (entry.disposition !== 'mapped') continue;
      expect(TARGETS, `${dir} → unknown target '${entry.target}'`).toContain(entry.target);
      expect(entry.reason.trim().length, `${dir}: mapped with no reason`).toBeGreaterThan(20);
    }
  });

  it('every exception states a destination AND a reason', () => {
    // An exception without a reason is just an unmapped directory with better
    // manners. The plan's wording is "a stated exception with a reason".
    for (const dir of liveDirs) {
      const entry = map.directories[dir] as Entry;
      if (entry.disposition !== 'exception') continue;
      expect(entry.destination.trim().length, `${dir}: exception with no destination`).toBeGreaterThan(0);
      expect(entry.reason.trim().length, `${dir}: exception with no reason`).toBeGreaterThan(20);
    }
  });

  it('no directory is both mapped and excepted', () => {
    for (const dir of liveDirs) {
      const entry = map.directories[dir] as Entry;
      expect(['mapped', 'exception']).toContain(entry.disposition);
    }
  });

  it('the recorded counts match the live tree', () => {
    // The counts are quoted in the spec and in ARCHITECTURE.md, so they have to
    // be measured rather than asserted — a stale count is a false premise the
    // next reader inherits.
    const entries = liveDirs.map((d) => map.directories[d] as Entry);
    expect(map.counts.directories).toBe(liveDirs.length);
    expect(map.counts.mapped).toBe(entries.filter((e) => e.disposition === 'mapped').length);
    expect(map.counts.exceptions).toBe(entries.filter((e) => e.disposition === 'exception').length);
  });
});

describe('the 11 targets → 9 published layers relation (what task 044 asserts)', () => {
  it('publishes exactly nine layers, L1 through L9', () => {
    expect(Object.keys(map.publishedLayers).sort()).toEqual([
      'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9',
    ]);
    expect(map.counts.publishedLayers).toBe(9);
  });

  it('declares exactly eleven targets', () => {
    expect(map.counts.targets).toBe(TARGETS.length);
  });

  it('L5 is the one layer served by two directories — contract and dispatch', () => {
    const twoDir = Object.entries(map.publishedLayers).filter(([, v]) => v.targets.length > 1);
    expect(twoDir.map(([id]) => id)).toEqual(['L5']);
    expect([...(map.publishedLayers.L5?.targets ?? [])].sort()).toEqual(['contract', 'dispatch']);
  });

  it('install is a declared non-layer peer, not a tenth layer', () => {
    expect(Object.keys(map.nonLayerPeers)).toContain('install');
    expect(map.nonLayerPeers.install?.length ?? 0).toBeGreaterThan(20);
    const layerTargets = Object.values(map.publishedLayers).flatMap((v) => v.targets);
    expect(layerTargets).not.toContain('install');
  });

  it('every target except install belongs to exactly one published layer', () => {
    const layerTargets = Object.values(map.publishedLayers).flatMap((v) => v.targets);
    expect([...layerTargets].sort()).toEqual(TARGETS.filter((t) => t !== 'install').slice().sort());
    expect(new Set(layerTargets).size).toBe(layerTargets.length);
  });

  it('nested adapter layer ids are not first-level map keys', () => {
    // Longest-prefix ids live on LAYER_ALLOWED_IMPORTS. Promoting them to
    // first-level map keys would break the "every map key is a live src/ dir"
    // assertion this file already makes.
    expect(Object.keys(map.directories)).not.toContain('adapters/cli');
    expect(Object.keys(map.directories)).not.toContain('adapters/mcp');
    expect(map.directories.adapters).toBeDefined();
  });

  it('every target a directory maps to is a target the layer table knows', () => {
    // Closes the loop: the per-directory half and the layer half cannot drift
    // into naming different things.
    const known = new Set([...Object.values(map.publishedLayers).flatMap((v) => v.targets), 'install']);
    for (const dir of liveDirs) {
      const entry = map.directories[dir] as Entry;
      if (entry.disposition !== 'mapped') continue;
      expect(known, `${dir} maps to '${entry.target}', absent from the layer table`).toContain(
        entry.target,
      );
    }
  });
});

// ─── The event store must not import the oracle ─────────────────────────────
//
// `events` is declared on `LAYER_ALLOWED_IMPORTS` with a broad `contract`
// allowance — store.ts already exercises it for `contract/shared/validation`
// — so the general layering census cannot express "the event store never
// reaches the oracle" without narrowing that whole row, which would also
// break the edges the store genuinely needs. This is the narrower rule the
// general census cannot state: no module under `events/` may resolve an
// import into `contract/oracle/`. It reuses the same lexer-backed edge scan
// the general census runs on, so a specifier hidden in a comment or a
// template cannot manufacture or hide an edge here either.
describe('EventsLayer_NeverImportsOracle', () => {
  it('no module under events/ resolves an import into contract/oracle/', async () => {
    const edges = await scanLayerEdges(SRC, lexModule);
    const violations = edges.filter(
      (e) => e.module.startsWith('events/') && e.targetModule.startsWith('contract/oracle/'),
    );
    expect(
      violations.map((v) => `${v.module} -> ${v.targetModule}`),
      'The oracle judges what the event store produces; an import running the ' +
        'other way would let the store depend on its own judge.',
    ).toEqual([]);
  });

  it('the scan is not vacuous: events/ actually has resolvable edges to inspect', async () => {
    // A scan root that resolved to nothing, or a lexer that never returned an
    // import, would make the assertion above pass by having no denominator.
    const edges = await scanLayerEdges(SRC, lexModule);
    const eventsEdges = edges.filter((e) => e.module.startsWith('events/'));
    expect(eventsEdges.length).toBeGreaterThan(0);
  });
});
