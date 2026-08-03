import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditLayerBoundaries,
  runLayerBoundaryCensus,
  detectLayerEdges,
  scanLayerEdges,
  resolveTarget,
  layerOf,
  isRootFile,
  LAYER_ALLOWED_IMPORTS,
  type LayerAllowance,
  type LayerEdge,
} from './layer-boundaries-seam.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('resolveTarget', () => {
  it('resolves a sibling-directory specifier to a .ts module', () => {
    expect(resolveTarget('workflow/foo.ts', '../event-store/store.js')).toBe('event-store/store.ts');
  });

  it('resolves a nested module specifier relative to its own directory', () => {
    expect(resolveTarget('orchestrate/doctor/probes.ts', '../../vcs/x.js')).toBe('vcs/x.ts');
  });

  it('returns undefined for a bare package / node builtin specifier', () => {
    expect(resolveTarget('a/b.ts', 'node:fs')).toBeUndefined();
    expect(resolveTarget('a/b.ts', 'vitest')).toBeUndefined();
  });

  it('returns undefined for a specifier that escapes the scan root', () => {
    expect(resolveTarget('a/b.ts', '../../../outside.js')).toBeUndefined();
  });
});

describe('layerOf / isRootFile', () => {
  it('reports the first path segment as the layer', () => {
    expect(layerOf('workflow/state-store.ts')).toBe('workflow');
    expect(layerOf('orchestrate/doctor/probes.ts')).toBe('orchestrate');
  });
  it('treats a root-level file as a root file', () => {
    expect(isRootFile('format.ts')).toBe(true);
    expect(isRootFile('workflow/x.ts')).toBe(false);
  });
});

describe('detectLayerEdges', () => {
  it('emits one cross-directory edge and ignores intra-layer + root-file imports', () => {
    const edges = detectLayerEdges(
      'workflow/foo.ts',
      `import { EventStore } from '../event-store/store.js';
       import { handleInit } from './tools.js';
       import { format } from '../format.js';
       import { z } from 'zod';`,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.targetLayer).toBe('event-store');
    expect(edges[0]?.targetModule).toBe('event-store/store.ts');
    expect(edges[0]?.sourceLayer).toBe('workflow');
  });

  it('does NOT count a specifier that only appears in a comment or string', () => {
    const edges = detectLayerEdges(
      'utils/leaf.ts',
      `// import { x } from '../workflow/y.js';\nconst s = "from '../workflow/z.js'"; export const y = 1;`,
    );
    expect(edges).toHaveLength(0);
  });

  it('emits nothing for a root-level source file', () => {
    expect(detectLayerEdges('format.ts', `import { x } from './workflow/y.js';`)).toEqual([]);
  });
});

describe('runLayerBoundaryCensus — verdict logic', () => {
  const allowances: LayerAllowance[] = [
    { layer: 'utils', allow: [], note: 'leaf' },
    { layer: 'runtime', allow: ['utils'], note: 'r' },
  ];

  it('flags a governed layer reaching a non-allowed directory as FORBIDDEN_IMPORT (names both ends)', () => {
    const edges: LayerEdge[] = [
      {
        module: 'utils/leaf.ts',
        sourceLayer: 'utils',
        targetModule: 'workflow/state-store.ts',
        targetLayer: 'workflow',
        specifier: '../workflow/state-store.js',
      },
    ];
    const result = runLayerBoundaryCensus(edges, allowances);
    expect(result.ok).toBe(false);
    const forbidden = result.diagnostics.find((d) => d.code === 'FORBIDDEN_IMPORT');
    expect(forbidden && 'module' in forbidden && forbidden.module).toBe('utils/leaf.ts');
    expect(forbidden && 'targetModule' in forbidden && forbidden.targetModule).toBe(
      'workflow/state-store.ts',
    );
  });

  it('does NOT flag an ungoverned source layer as FORBIDDEN', () => {
    const edges: LayerEdge[] = [
      // A live runtime->utils edge keeps the `runtime` allowance from going stale,
      // isolating the property under test: the ungoverned orchestrate->workflow
      // edge must produce NO FORBIDDEN_IMPORT.
      {
        module: 'runtime/res.ts',
        sourceLayer: 'runtime',
        targetModule: 'utils/x.ts',
        targetLayer: 'utils',
        specifier: '../utils/x.js',
      },
      {
        module: 'orchestrate/x.ts',
        sourceLayer: 'orchestrate',
        targetModule: 'workflow/y.ts',
        targetLayer: 'workflow',
        specifier: '../workflow/y.js',
      },
    ];
    const result = runLayerBoundaryCensus(edges, allowances);
    expect(result.diagnostics.some((d) => d.code === 'FORBIDDEN_IMPORT')).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('flags an allowance no live edge exercises as STALE_LAYER_ALLOWANCE', () => {
    // `runtime -> utils` is declared but there is no live runtime->utils edge.
    const result = runLayerBoundaryCensus([], allowances);
    expect(result.diagnostics.map((d) => d.code)).toContain('STALE_LAYER_ALLOWANCE');
    const stale = result.diagnostics.find((d) => d.code === 'STALE_LAYER_ALLOWANCE');
    expect(stale && 'layer' in stale && stale.layer).toBe('runtime');
  });

  it('passes when every governed edge is allowed and every allowance is live', () => {
    const edges: LayerEdge[] = [
      {
        module: 'runtime/res.ts',
        sourceLayer: 'runtime',
        targetModule: 'utils/x.ts',
        targetLayer: 'utils',
        specifier: '../utils/x.js',
      },
    ];
    expect(runLayerBoundaryCensus(edges, allowances).ok).toBe(true);
  });
});

describe('EXIT PROOF — live allowed-dependency layering', () => {
  it('(a) the live shipped source has ZERO forbidden imports and no stale allowance', async () => {
    const result = await auditLayerBoundaries(SRC_ROOT);
    // Surfacing the diagnostics array makes any regression self-describing.
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.edgeCount).toBeGreaterThan(0);
  });

  it('(b) a planted forbidden import from a governed leaf FAILS against the live edges', async () => {
    const edges = await scanLayerEdges(SRC_ROOT);
    const planted: LayerEdge = {
      module: 'utils/rogue.ts',
      sourceLayer: 'utils',
      targetModule: 'orchestrate/registry.ts',
      targetLayer: 'orchestrate',
      specifier: '../orchestrate/registry.js',
    };
    const result = runLayerBoundaryCensus([...edges, planted], LAYER_ALLOWED_IMPORTS);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === 'FORBIDDEN_IMPORT' && 'module' in d && d.module === 'utils/rogue.ts',
      ),
    ).toBe(true);
  });

  it('every declared allowance is exercised by at least one live edge (no phantom cover)', async () => {
    const edges = await scanLayerEdges(SRC_ROOT);
    for (const a of LAYER_ALLOWED_IMPORTS) {
      for (const target of a.allow) {
        expect(
          edges.some((e) => e.sourceLayer === a.layer && e.targetLayer === target),
          `allowance ${a.layer} -> ${target} has no live edge`,
        ).toBe(true);
      }
    }
  });
});
