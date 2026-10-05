// The authoritative layer mapping. `tools/audit/layer-map.json` gives each
// directory under `src/` a target or a stated exception.
//
// The suite reads the scope from disk and never from the map. A map that omits
// a directory is consistent with itself and still wrong.
//
// The suite asserts the relation of 11 targets to 9 published layers as a
// relation and not as set equality. Two directories (`contract` and `dispatch`)
// serve L5, and `install` is a declared non-layer peer and not a tenth layer.
//
// @oracle-sources: ../../tools/audit/layer-map.json, live-src-directory-listing

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLayerEdges } from '../../src/architecture/layer-boundaries-seam.js';
import { lexModule } from '../../tools/test-helpers/module-lexer.js';
import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';

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

/** The directories of the live tree. The disk is the only authority on which directories exist. */
const liveDirs = readdirSync(SRC)
  .filter((d) => statSync(path.join(SRC, d)).isDirectory())
  .sort();

/** The 11 targets that a directory can map to. */
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
  /**
   * An empty listing makes each assertion below trivially true. The minimum of
   * 20 is below the measured count, so ordinary consolidation does not fail it.
   */
  it('the scan is not vacuous', () => {
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

  /** An exception with no reason is the same as an unmapped directory. */
  it('every exception states a destination AND a reason', () => {
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

  /**
   * Documents quote these counts, so the test measures them from the live tree.
   * A stale count gives the next reader a false premise.
   */
  it('the recorded counts match the live tree', () => {
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

  /**
   * The longest-prefix ids are on `LAYER_ALLOWED_IMPORTS`. As first-level map
   * keys, they break the assertion that each map key is a live directory under
   * `src/`.
   */
  it('nested adapter layer ids are not first-level map keys', () => {
    expect(Object.keys(map.directories)).not.toContain('adapters/cli');
    expect(Object.keys(map.directories)).not.toContain('adapters/mcp');
    expect(map.directories.adapters).toBeDefined();
  });

  /** The directory entries and the layer table must name the same targets. */
  it('every target a directory maps to is a target the layer table knows', () => {
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

/**
 * No module under `events/` resolves an import into `contract/oracle/`. The
 * `events` row of `LAYER_ALLOWED_IMPORTS` allows `contract` broadly, so the
 * general census cannot state this narrower rule. The tests use the same
 * lexer-backed edge scan as the census. Thus a specifier in a comment or a
 * template adds no edge and hides none.
 *
 * Both tests scan the real `src/` tree, and the first one pays for the cold
 * filesystem cache. Their timeout uses the win32 factor of the tier, because a
 * flat literal overrides that factor and gives Windows a smaller budget.
 */
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
  }, 20_000 * WIN32_SPAWN_HEADROOM);

  /** An empty scan root, or a lexer that returns no import, makes the test above pass with no denominator. */
  it('the scan is not vacuous: events/ actually has resolvable edges to inspect', async () => {
    const edges = await scanLayerEdges(SRC, lexModule);
    const eventsEdges = edges.filter((e) => e.module.startsWith('events/'));
    expect(eventsEdges.length).toBeGreaterThan(0);
  }, 20_000 * WIN32_SPAWN_HEADROOM);
});
