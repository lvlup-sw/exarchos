import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
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
  ROOT_LAYER,
  declaredLayerIds,
  LAYER_ALLOWED_IMPORTS,
  auditDeclarationSeam,
  detectDeclarationSeamUsage,
  exportsDeclarationSymbol,
  runDeclarationSeamCensus,
  scanDeclarationSeam,
  DECLARATION_SEAM,
  type DeclarationSeamRule,
  type DeclarationSeamScan,
  type DeclarationSeamUsage,
  type LayerAllowance,
  type LayerEdge,
  scanSdkSeamBoundary,
  runSdkSeamBoundaryCensus,
  type SdkSeamBoundaryScan,
  detectSdkSeamUsage,
  SDK_SEAM_BOUNDARY,
  type SdkSeamUsage,
  auditSdkSeamBoundary,
} from '../../../src/architecture/layer-boundaries-seam.js';
import { lexModule } from '../../../tools/test-helpers/module-lexer.js';

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { classifySdkImport } from '../../../src/architecture/sdk-generation-seam.js';
import { parseModuleSpecifiers } from '../../../tools/test-helpers/module-specifier-parser.js';

/**
 * DR-30 authorities. Task 053's DR-26 sweep at the bottom of this file compares
 * two sources, neither derived from the other:
 *
 *   • `./sdk-generation-seam.ts` — the RULE. Which module is the owned seam
 *     (`SDK_SEAM_MODULE`, re-exported as `SDK_SEAM_BOUNDARY.seamModule`) and
 *     which package names constitute each generation (`classifySdkImport`).
 *   • `../../package.json` — the INSTALLED REALITY. Which SDK generations npm
 *     was actually asked to resolve.
 *
 * They can genuinely disagree, which is the point: a generation that is
 * installed but no longer reaches the seam means half the brand has rotted
 * while the bypass sweep still reads green, and a seam pointing at a module
 * that moved means the sweep is measuring nothing. Neither is derivable from
 * the other — `package.json` participates in no import graph.
 *
 * @oracle-sources: ../../../src/architecture/sdk-generation-seam.ts, ../../../package.json
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../src');

/** The repository root — `src` sits directly beneath it since the task-019 fold. */
const REPO_ROOT = join(SRC_ROOT, '..');

/**
 * Modules git tracks under `root`, counted independently of the walker.
 *
 * The second authority for the denominator: `git ls-files` knows nothing about
 * the scan's exclusions or its recursion, so agreement between the two is
 * evidence the walk reached the tree rather than a restatement of it.
 */
function countTrackedModules(root: string): number {
  const out = execFileSync(
    'git',
    ['ls-files', '--', '*.ts', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'],
    { cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('/dist/') && !line.startsWith('dist/'))
    .length;
}

describe('resolveTarget', () => {
  it('resolves a sibling-directory specifier to a .ts module', () => {
    expect(resolveTarget('workflow/foo.ts', '../events/store.js')).toBe('events/store.ts');
  });

  it('resolves a nested module specifier relative to its own directory', () => {
    expect(resolveTarget('verbs/doctor/probes.ts', '../../vcs/x.js')).toBe('vcs/x.ts');
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
  it('reports the first path segment as the layer when no row claims the module', () => {
    expect(layerOf('workflow/state-store.ts')).toBe('workflow');
    expect(layerOf('verbs/doctor/probes.ts')).toBe('verbs');
  });

  it('LayerOf_ModuleUnderNestedLayerId_ResolvesToTheLongestMatch', () => {
    // Task 040. The whole point of the model change: with `adapters/mcp`
    // declared, a module under it belongs to THAT layer and not to `adapters`,
    // so an edge to a sibling adapter is a cross-layer edge instead of an
    // intra-layer one the census silently drops.
    const ids = ['adapters', 'adapters/mcp', 'adapters/cli'];
    expect(layerOf('adapters/mcp/mcp.ts', ids)).toBe('adapters/mcp');
    expect(layerOf('adapters/cli/cli.ts', ids)).toBe('adapters/cli');
    // A module under the parent but under no nested id falls back to the parent.
    expect(layerOf('adapters/channel/ndjson.ts', ids)).toBe('adapters');
    // Declaration order must not decide the winner — longest match does.
    expect(layerOf('adapters/mcp/mcp.ts', [...ids].reverse())).toBe('adapters/mcp');
    // A prefix that is not a PATH-BOUNDARY prefix must not claim the module.
    expect(layerOf('adapters-legacy/x.ts', ids)).toBe('adapters-legacy');
  });

  it('treats a root-level file as a root file, and gives it the stated root layer', () => {
    expect(isRootFile('format.ts')).toBe(true);
    expect(isRootFile('workflow/x.ts')).toBe(false);
    // The exclusion became a STATED policy — the root surface has a name now.
    expect(layerOf('registry.ts')).toBe(ROOT_LAYER);
  });

  it('LayerOf_ExactLayerId_AndLiveDeclaredIds_ResolveTheSameNestedLayer', () => {
    expect(layerOf('adapters/mcp', ['adapters', 'adapters/mcp'])).toBe('adapters/mcp');
    expect(layerOf('adapters/mcp/mcp.ts', declaredLayerIds())).toBe('adapters/mcp');
    expect(layerOf('registry/tools.ts', declaredLayerIds())).toBe('registry');
    expect(layerOf('registry.ts', declaredLayerIds())).toBe(ROOT_LAYER);
  });
});

describe('detectLayerEdges', () => {
  it('emits a cross-directory edge, ignores intra-layer, and counts the root surface', () => {
    const edges = detectLayerEdges(
      'workflow/foo.ts',
      `import { EventStore } from '../events/store.js';
       import { handleInit } from './tools.js';
       import { format } from '../format.js';
       import { z } from 'zod';`, lexModule,
    );
    // `./tools.js` is intra-layer and `zod` is third-party; `../format.js` is
    // the root surface, which task 040 promoted from "excluded" to "a layer".
    expect(edges.map((e) => e.targetLayer).sort()).toEqual([ROOT_LAYER, 'events']);
    const toEvents = edges.find((e) => e.targetLayer === 'events');
    expect(toEvents?.targetModule).toBe('events/store.ts');
    expect(toEvents?.sourceLayer).toBe('workflow');
  });

  it('does NOT count a specifier that only appears in a comment or string', () => {
    const edges = detectLayerEdges(
      'utils/leaf.ts',
      `// import { x } from '../workflow/y.js';\nconst s = "from '../workflow/z.js'"; export const y = 1;`, lexModule,
    );
    expect(edges).toHaveLength(0);
  });

  it('LayerCensus_RootFile_ContributesEdgesUnderTheStatedPolicy', () => {
    // Task 040. This used to assert `[]` — a root-level file emitted nothing,
    // which is why `registry.ts` (the largest module in the tree) could not be
    // governed by any rule. It is now an ordinary source layer.
    const edges = detectLayerEdges('registry.ts', `import { x } from './workflow/y.js';`, lexModule);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.sourceLayer).toBe(ROOT_LAYER);
    expect(edges[0]?.targetLayer).toBe('workflow');
    expect(edges[0]?.module).toBe('registry.ts');
  });

  it('LayerCensus_McpImportingCli_ReportsForbiddenImportNamingBothEnds', () => {
    // Task 040's acceptance condition. This was STRUCTURALLY IMPOSSIBLE before
    // the model change: both ends resolve to `adapters`, so the edge died on
    // the intra-layer skip and no allowance could reject it.
    const ids = ['adapters/mcp', 'adapters/cli'];
    const edges = detectLayerEdges(
      'adapters/mcp/mcp.ts',
      `import { runCli } from '../cli/cli.js';`,
      lexModule,
      ids,
    );
    expect(edges).toHaveLength(1);

    const verdict = runLayerBoundaryCensus(edges, [
      { layer: 'adapters/mcp', allow: [], note: 'the MCP adapter must not reach a sibling adapter' },
    ]);
    expect(verdict.ok).toBe(false);

    const forbidden = verdict.diagnostics.filter((d) => d.code === 'FORBIDDEN_IMPORT');
    expect(forbidden).toHaveLength(1);
    // "naming both ends" is the requirement — a verdict that reports only a
    // layer pair cannot be acted on without re-deriving which module did it.
    const [only] = forbidden;
    expect(only?.message).toContain('adapters/mcp/mcp.ts');
    expect(only?.message).toContain('adapters/cli/cli.ts');

    // The same shape, unfiltered, over the FIRST-SEGMENT model: proof the test
    // above is not passing for some reason unrelated to the nested ids.
    expect(detectLayerEdges('adapters/mcp/mcp.ts', `import { runCli } from '../cli/cli.js';`, lexModule)).toEqual([]);
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
      // isolating the property under test: the ungoverned verbs->workflow
      // edge must produce NO FORBIDDEN_IMPORT.
      {
        module: 'runtime/res.ts',
        sourceLayer: 'runtime',
        targetModule: 'utils/x.ts',
        targetLayer: 'utils',
        specifier: '../utils/x.js',
      },
      {
        module: 'verbs/x.ts',
        sourceLayer: 'verbs',
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
    const result = await auditLayerBoundaries(SRC_ROOT, lexModule);
    // Surfacing the diagnostics array makes any regression self-describing.
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.edgeCount).toBeGreaterThan(0);
  });

  it('(b) a planted forbidden import from a governed leaf FAILS against the live edges', async () => {
    // Scanned with the SAME declared ids the census judges against. Resolving
    // the tree under one id set and judging it under another agrees only while
    // every id is a single path segment — the moment a nested id is declared,
    // its rows would look phantom here for a reason that has nothing to do with
    // the tree.
    const edges = await scanLayerEdges(SRC_ROOT, lexModule, declaredLayerIds());
    const planted: LayerEdge = {
      module: 'utils/rogue.ts',
      sourceLayer: 'utils',
      targetModule: 'verbs/registry.ts',
      targetLayer: 'verbs',
      specifier: '../verbs/registry.js',
    };
    const result = runLayerBoundaryCensus([...edges, planted], LAYER_ALLOWED_IMPORTS);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === 'FORBIDDEN_IMPORT' && 'module' in d && d.module === 'utils/rogue.ts',
      ),
    ).toBe(true);
  });

  it('LayerRule_SeededViolation_FailsAndNamesTheRule', async () => {
    // Task 041 promoted the whole core into the governed set. A table of 30
    // rows is worth exactly as much as its teeth, and "the census is green"
    // says nothing about whether any INDIVIDUAL row can still reject. So seed
    // one violation per declared rule and require the census to fail naming
    // that rule — a row that cannot reject is a row that governs nothing.
    const edges = await scanLayerEdges(SRC_ROOT, lexModule, declaredLayerIds());
    expect(LAYER_ALLOWED_IMPORTS.length).toBeGreaterThan(20);

    const everyLayer = new Set<string>();
    for (const e of edges) {
      everyLayer.add(e.sourceLayer);
      everyLayer.add(e.targetLayer);
    }

    for (const rule of LAYER_ALLOWED_IMPORTS) {
      // A target this rule does NOT allow, drawn from the live layer set so the
      // seeded edge is shaped like a real one rather than a fiction.
      const disallowed = [...everyLayer]
        .sort()
        .find((l) => l !== rule.layer && !rule.allow.includes(l));
      expect(disallowed, `every layer is allowed for "${rule.layer}" — the row cannot reject`).toBeDefined();

      const planted: LayerEdge = {
        module: `${rule.layer}/__seeded__.ts`,
        sourceLayer: rule.layer,
        targetModule: `${disallowed}/target.ts`,
        targetLayer: disallowed!,
        specifier: `../${disallowed}/target.js`,
      };

      const verdict = runLayerBoundaryCensus([...edges, planted], LAYER_ALLOWED_IMPORTS);
      expect(verdict.ok, `rule "${rule.layer}" did not reject a forbidden edge`).toBe(false);
      expect(
        verdict.diagnostics.some(
          (d) =>
            d.code === 'FORBIDDEN_IMPORT' &&
            'module' in d &&
            d.module === `${rule.layer}/__seeded__.ts`,
        ),
        `rule "${rule.layer}" failed without naming the offending module`,
      ).toBe(true);
    }
  });

  it('LayerAllowance_PhantomCover_FailsAsStale', async () => {
    // The other tooth, on the live edge set: an allowance nothing exercises is
    // cover that governs nothing, and it must fail rather than sit there. This
    // matters more after task 041 than before — 18 new rows are 18 new chances
    // to leave a target behind when an edge is deleted.
    const edges = await scanLayerEdges(SRC_ROOT, lexModule, declaredLayerIds());
    const phantom: LayerAllowance = {
      layer: 'utils',
      allow: ['__no_such_layer__'],
      note: 'seeded phantom cover',
    };

    const verdict = runLayerBoundaryCensus(edges, [...LAYER_ALLOWED_IMPORTS, phantom]);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.diagnostics.some(
        (d) => d.code === 'STALE_LAYER_ALLOWANCE' && 'target' in d && d.target === '__no_such_layer__',
      ),
    ).toBe(true);
  });

  it('every declared allowance is exercised by at least one live edge (no phantom cover)', async () => {
    const edges = await scanLayerEdges(SRC_ROOT, lexModule, declaredLayerIds());
    for (const a of LAYER_ALLOWED_IMPORTS) {
      for (const target of a.allow) {
        expect(
          edges.some((e) => e.sourceLayer === a.layer && e.targetLayer === target),
          `allowance ${a.layer} -> ${target} has no live edge`,
        ).toBe(true);
      }
    }
  });

  it('every declared layer id owns at least one scanned module', async () => {
    // A row naming a directory that does not exist never forbids and never
    // goes stale: empty `allow` has no unused target, and no module resolves
    // to the id. Seeded-violation tests plant synthetic files, so they pass
    // without live coverage. Walk the tree so a foundation leaf that imports
    // nothing is still visible.
    const { readdir } = await import('node:fs/promises');
    const { join, relative } = await import('node:path');
    const ids = declaredLayerIds();
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          out.push(...(await walk(full)));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          out.push(relative(SRC_ROOT, full).split('\\').join('/'));
        }
      }
      return out;
    };
    const owned = new Set((await walk(SRC_ROOT)).map((m) => layerOf(m, ids)));
    const vacant = LAYER_ALLOWED_IMPORTS.map((a) => a.layer).filter((id) => !owned.has(id));
    expect(vacant, 'LAYER_ALLOWED_IMPORTS rows that own no scanned module').toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DR-1 — the declaration-seam census
// ════════════════════════════════════════════════════════════════════════════

/** The on-disk seeded consumer that bypasses the seam (the kill-probe subject). */
const VIOLATOR_FIXTURE = join(SRC_ROOT, 'architecture/__fixtures__/declaration-seam-violator.fixture.ts');
/** The module path the fixture would occupy if it were shipped source. */
const VIOLATOR_MODULE = 'architecture/__fixtures__/declaration-seam-violator.fixture.ts';

/** A minimal synthetic rule, so the unit tests do not depend on the live one. */
const TEST_RULE: DeclarationSeamRule = {
  accessor: 'contract/declaration-seam.ts',
  contractModules: ['contract/declaration.ts', 'contract/declaration-seam.ts'],
  storage: [{ module: 'registry.ts', symbol: 'TOOL_REGISTRY', note: 'actions + cli verbs' }],
  sourceAdapters: [],
};

const scanOf = (
  usages: readonly DeclarationSeamUsage[],
  overrides: Partial<DeclarationSeamScan> = {},
): DeclarationSeamScan => ({
  usages,
  storage: [{ module: 'registry.ts', symbol: 'TOOL_REGISTRY', resolved: true }],
  accessorPresent: true,
  ...overrides,
});

const usage = (
  module: string,
  contractImports: readonly string[],
  storageImports: readonly { storageModule: string; specifier: string }[],
): DeclarationSeamUsage => ({ module, contractImports, storageImports });
const MCP_SCOPE = '@modelcontextprotocol';
const v1Spec = (subpath: string): string => `${MCP_SCOPE}/sdk/${subpath}`;
const v2Spec = (pkg: string): string => `${MCP_SCOPE}/${pkg}`;

/** The module the kill fixture pretends to be — a plausible, non-seam path. */
const ROGUE_MODULE = 'adapters/rogue-transport.ts';

describe('detectDeclarationSeamUsage', () => {
  it('detectDeclarationSeamUsage_ModuleImportingContractAndStore_ReportsBothSides', () => {
    const found = detectDeclarationSeamUsage(
      'describe/handler.ts',
      `import type { Declaration } from '../contract/declaration.js';
       import { TOOL_REGISTRY } from '../registry.js';
       import { z } from 'zod';`,
      lexModule, TEST_RULE,
    );

    expect(found?.contractImports).toEqual(['../contract/declaration.js']);
    expect(found?.storageImports).toEqual([
      { storageModule: 'registry.ts', specifier: '../registry.js' },
    ]);
  });

  it('detectDeclarationSeamUsage_ModuleTouchingNeitherSide_ReturnsUndefined', () => {
    expect(
      detectDeclarationSeamUsage(
        'workflow/tools.ts',
        `import { EventStore } from '../events/store.js';`,
        lexModule, TEST_RULE,
      ),
    ).toBeUndefined();
  });

  it('detectDeclarationSeamUsage_RootLevelStoreImport_IsResolvedNotSkipped', () => {
    // `registry.ts` is the largest declaration store and a ROOT-LEVEL file, so
    // this census has to resolve root-file imports or miss its biggest subject.
    const found = detectDeclarationSeamUsage(
      'contract/rogue.ts',
      `import type { Declaration } from './declaration.js';
       import { TOOL_REGISTRY } from '../registry.js';`,
      lexModule, TEST_RULE,
    );

    expect(found?.storageImports.map((i) => i.storageModule)).toEqual(['registry.ts']);

    // This used to assert the layering census saw NOTHING here — the contrast
    // that justified keeping the two censuses apart. Task 040 removed the
    // root-file exclusion, so both now resolve the same edge, and the reason
    // they stay separate is no longer mechanical: a layer allowance is
    // unconditional, while DR-1's rule fires only for a module that is already
    // a declaration CONSUMER. That condition is what makes the population
    // self-maintaining, and it is not expressible as an allowance row.
    const layerEdges = detectLayerEdges(
      'contract/rogue.ts',
      `import { X } from '../registry.js';`,
      lexModule,
    );
    expect(layerEdges.map((e) => e.targetLayer)).toEqual([ROOT_LAYER]);
  });

  it('detectDeclarationSeamUsage_StoreNamedOnlyInACommentOrString_ReportsNoImport', () => {
    const found = detectDeclarationSeamUsage(
      'contract/prose.ts',
      `import type { Declaration } from './declaration.js';
       // import { TOOL_REGISTRY } from '../registry.js';
       const doc = "see '../registry.js'";
       export const x = doc;`,
      lexModule, TEST_RULE,
    );

    expect(found?.contractImports).toHaveLength(1);
    expect(found?.storageImports).toEqual([]);
  });

  it('detectDeclarationSeamUsage_RepeatedStoreImport_IsCountedOnce', () => {
    const found = detectDeclarationSeamUsage(
      'contract/rogue.ts',
      `import type { Declaration } from './declaration.js';
       import { TOOL_REGISTRY } from '../registry.js';
       import { CompositeTool } from '../registry.js';`,
      lexModule, TEST_RULE,
    );

    expect(found?.storageImports).toHaveLength(1);
  });
});

describe('exportsDeclarationSymbol', () => {
  it('exportsDeclarationSymbol_SourceExportingTheBinding_ReturnsTrue', () => {
    expect(
      exportsDeclarationSymbol('export const TOOL_REGISTRY: readonly CompositeTool[] = [];', 'TOOL_REGISTRY'),
    ).toBe(true);
  });

  it('exportsDeclarationSymbol_SymbolOnlyMentionedInADocComment_ReturnsFalse', () => {
    // The failure this guards: a store that MOVED while its name lingered in
    // prose would otherwise keep resolving and the census would stay vacuous.
    expect(
      exportsDeclarationSymbol(' * export const TOOL_REGISTRY is defined elsewhere.', 'TOOL_REGISTRY'),
    ).toBe(false);
  });

  it('exportsDeclarationSymbol_SymbolAbsentEntirely_ReturnsFalse', () => {
    expect(exportsDeclarationSymbol('export const SOMETHING_ELSE = 1;', 'TOOL_REGISTRY')).toBe(false);
  });
});

describe('runDeclarationSeamCensus — verdict logic', () => {
  it('runDeclarationSeamCensus_ConsumerImportingAStore_ReportsDirectStorageRead', () => {
    const result = runDeclarationSeamCensus(
      scanOf([
        usage('contract/rogue.ts', ['./declaration.js'], [
          { storageModule: 'registry.ts', specifier: '../registry.js' },
        ]),
      ]),
      TEST_RULE,
    );

    expect(result.ok).toBe(false);
    const finding = result.diagnostics.find((d) => d.code === 'DIRECT_STORAGE_READ');
    expect(finding && 'module' in finding && finding.module).toBe('contract/rogue.ts');
    expect(finding && 'storageModule' in finding && finding.storageModule).toBe('registry.ts');
  });

  it('runDeclarationSeamCensus_NonConsumerImportingAStore_IsNotFlagged', () => {
    // An un-migrated module that knows nothing about declarations is not a
    // violation — that is the whole reason this census needs no grandfather list.
    const result = runDeclarationSeamCensus(
      scanOf([
        usage('contract/declaration-seam.ts', ['./declaration.js'], []),
        usage('workflow/playbooks.ts', [], [
          { storageModule: 'registry.ts', specifier: '../registry.js' },
        ]),
      ]),
      TEST_RULE,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.consumerCount).toBe(1);
  });

  it('runDeclarationSeamCensus_DeclaredSourceAdapter_IsExemptFromTheNoStorageRule', () => {
    const withAdapter: DeclarationSeamRule = {
      ...TEST_RULE,
      sourceAdapters: [{ module: 'contract/lift.ts', note: 'lifts TOOL_REGISTRY into envelopes' }],
    };
    const result = runDeclarationSeamCensus(
      scanOf([
        usage('contract/lift.ts', ['./declaration.js'], [
          { storageModule: 'registry.ts', specifier: '../registry.js' },
        ]),
      ]),
      withAdapter,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('runDeclarationSeamCensus_DeclaredAdapterImportingNoStore_ReportsStaleSourceAdapter', () => {
    const withAdapter: DeclarationSeamRule = {
      ...TEST_RULE,
      sourceAdapters: [{ module: 'contract/lift.ts', note: 'lifts TOOL_REGISTRY into envelopes' }],
    };
    const result = runDeclarationSeamCensus(
      scanOf([usage('contract/lift.ts', ['./declaration.js'], [])]),
      withAdapter,
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('STALE_SOURCE_ADAPTER');
  });

  it('runDeclarationSeamCensus_ZeroResolvedConsumers_FailsOnTheEmptyDenominator', () => {
    const result = runDeclarationSeamCensus(scanOf([]), TEST_RULE);

    expect(result.consumerCount).toBe(0);
    expect(result.ok).toBe(false);
    const finding = result.diagnostics.find((d) => d.code === 'EMPTY_SEAM_DENOMINATOR');
    expect(finding && 'population' in finding && finding.population).toBe('consumers');
  });

  it('runDeclarationSeamCensus_ZeroDeclaredStores_FailsOnTheEmptyDenominator', () => {
    const noStores: DeclarationSeamRule = { ...TEST_RULE, storage: [] };
    const result = runDeclarationSeamCensus(
      { usages: [usage('contract/declaration-seam.ts', ['./declaration.js'], [])], storage: [], accessorPresent: true },
      noStores,
    );

    expect(result.ok).toBe(false);
    const finding = result.diagnostics.find((d) => d.code === 'EMPTY_SEAM_DENOMINATOR');
    expect(finding && 'population' in finding && finding.population).toBe('storage-sites');
  });

  it('runDeclarationSeamCensus_DeclaredStoreThatNoLongerResolves_FailsRatherThanReadingClean', () => {
    const result = runDeclarationSeamCensus(
      scanOf([usage('contract/declaration-seam.ts', ['./declaration.js'], [])], {
        storage: [{ module: 'registry.ts', symbol: 'TOOL_REGISTRY', resolved: false }],
      }),
      TEST_RULE,
    );

    expect(result.ok).toBe(false);
    expect(result.resolvedStorageCount).toBe(0);
    expect(result.diagnostics.map((d) => d.code)).toContain('UNRESOLVED_DECLARATION_STORAGE');
  });

  it('runDeclarationSeamCensus_AbsentAccessor_ReportsSeamAccessorMissing', () => {
    const result = runDeclarationSeamCensus(
      scanOf([usage('contract/declaration.ts', ['./declaration.js'], [])], {
        accessorPresent: false,
      }),
      TEST_RULE,
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('SEAM_ACCESSOR_MISSING');
  });

  it('runDeclarationSeamCensus_ConsumersCleanAndDenominatorsNonEmpty_Passes', () => {
    const result = runDeclarationSeamCensus(
      scanOf([usage('contract/declaration-seam.ts', ['./declaration.js'], [])]),
      TEST_RULE,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.consumerCount).toBe(1);
    expect(result.resolvedStorageCount).toBe(1);
  });
});

describe('EXIT PROOF — the live declaration seam (DR-1)', () => {
  it('auditDeclarationSeam_LiveShippedSource_ReportsNoDiagnostics', async () => {
    const result = await auditDeclarationSeam(SRC_ROOT, lexModule);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('auditDeclarationSeam_LiveShippedSource_ResolvesANonEmptyConsumerAndStorePopulation', async () => {
    // The non-empty-denominator criterion, measured rather than asserted: if the
    // contract modules or the stores are moved/renamed, these drop to zero and
    // the census above fails instead of reading clean.
    const result = await auditDeclarationSeam(SRC_ROOT, lexModule);

    expect(result.consumerCount).toBeGreaterThan(0);
    expect(result.resolvedStorageCount).toBe(DECLARATION_SEAM.storage.length);
    expect(result.resolvedStorageCount).toBeGreaterThan(0);
  });

  it('scanDeclarationSeam_LiveTree_FindsTheAccessorAndEveryDeclaredStore', async () => {
    const scan = await scanDeclarationSeam(SRC_ROOT, lexModule);

    expect(scan.accessorPresent).toBe(true);
    expect(scan.storage.filter((s) => !s.resolved)).toEqual([]);
  });

  it('scanDeclarationSeam_LiveEnvelopeAndAccessor_ImportNoDeclarationStorage', async () => {
    // The property behind task 006's `subject` decision: the contract foundation
    // stays storage-free. A kind-indexed subject map would have had to name
    // `CompositeTool` / `CliActionHints`, forcing `contract/declaration.ts` to
    // import `registry.ts` — a store — which is what this pins shut.
    const scan = await scanDeclarationSeam(SRC_ROOT, lexModule);

    for (const module of DECLARATION_SEAM.contractModules) {
      const found = scan.usages.find((u) => u.module === module);
      expect(found?.storageImports ?? [], `${module} imports declaration storage`).toEqual([]);
    }
  });

  it('runDeclarationSeamCensus_SeededOnDiskConsumerReadingStorageDirectly_FailsAgainstTheLiveTree', async () => {
    // KILL PROBE. A real file on disk — a declaration consumer that bypasses the
    // seam and reads `EVENT_EMISSION_REGISTRY` — is run through the SHIPPED
    // detector and planted into the LIVE scan. A seam rule with no failing
    // subject has not been shown to work; this is that subject.
    const seeded = detectDeclarationSeamUsage(
      VIOLATOR_MODULE,
      await readFile(VIOLATOR_FIXTURE, 'utf8'), lexModule,
    );
    expect(seeded, 'the seeded fixture must resolve as a seam participant').toBeDefined();
    if (seeded === undefined) return;

    expect(seeded.contractImports.length, 'the fixture must read as a CONSUMER').toBeGreaterThan(0);
    expect(seeded.storageImports.map((i) => i.storageModule)).toEqual(['events/schemas.ts']);

    const live = await scanDeclarationSeam(SRC_ROOT, lexModule);
    const result = runDeclarationSeamCensus({ ...live, usages: [...live.usages, seeded] });

    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === 'DIRECT_STORAGE_READ' && 'module' in d && d.module === VIOLATOR_MODULE,
      ),
    ).toBe(true);
  });

  it('scanDeclarationSeam_LiveTree_ExcludesTheSeededViolatorFixture', async () => {
    // The probe would be worthless if its own subject leaked into the live scan
    // (the census would then be red for everyone).
    const scan = await scanDeclarationSeam(SRC_ROOT, lexModule);

    expect(scan.usages.map((u) => u.module)).not.toContain(VIOLATOR_MODULE);
  });
});

describe('DR-26 — SDK generation seam: a direct SDK import fails the rule', () => {
  it('SdkSeam_DirectSdkImport_FailsSeamRule', async () => {
    // ── THE KILL FIXTURE ────────────────────────────────────────────────────
    // A guard with no failing subject has not been shown to work. On
    // introduction this rule had 42 real failing subjects across 22 files;
    // task 053 migrated every one, so the falsifier is re-seeded here and must
    // stay reproducible forever — otherwise "zero violations" over a fully
    // migrated tree is indistinguishable from a rule that cannot fire.
    const rogueSource = [
      `import { McpServer } from '${v1Spec('server/mcp.js')}';`,
      `import { StdioServerTransport } from '${v1Spec('server/stdio.js')}';`,
      '',
      'export function boot(): McpServer {',
      "  const s = new McpServer({ name: 'rogue', version: '0.0.0' });",
      '  void new StdioServerTransport();',
      '  return s;',
      '}',
    ].join('\n');

    const seeded = detectSdkSeamUsage(ROGUE_MODULE, rogueSource, parseModuleSpecifiers);
    expect(seeded, 'the seeded fixture must resolve as an SDK importer').toBeDefined();
    if (seeded === undefined) return;
    expect(seeded.isSeam, 'the fixture is NOT the owned seam').toBe(false);
    expect(seeded.imports.map((i) => i.generation)).toEqual(['v1', 'v1']);

    // Injected into the LIVE scan, exactly as DR-1's violator probe is: the
    // claim is that the rule as it actually runs against this tree would have
    // rejected the module, not that a hand-built scan can be made to fail.
    const live = await scanSdkSeamBoundary(REPO_ROOT, parseModuleSpecifiers);
    const result = runSdkSeamBoundaryCensus({
      ...live,
      usages: [...live.usages, seeded],
    });

    expect(result.ok).toBe(false);
    expect(result.bypassModuleCount).toBe(1);
    const rejections = result.diagnostics.filter(
      (d) => d.code === 'DIRECT_SDK_IMPORT' && 'module' in d && d.module === ROGUE_MODULE,
    );
    expect(
      rejections.length,
      'every direct SDK import in the seeded module must be named, not just the first',
    ).toBe(2);
    // The message has to say what to do, or the guard is a riddle.
    expect(rejections[0]?.message).toContain(SDK_SEAM_BOUNDARY.seamModule);
  });

  it('SdkSeam_SameModuleThroughTheSeam_Passes', async () => {
    // NEGATIVE TWIN #1 — the rule measures the BYPASS, not "this module has
    // anything to do with the SDK". Without this arm the kill fixture above
    // would also pass against a rule that rejected every module in `adapters/`.
    const throughSeam = [
      "import { createV1McpServer, createV1StdioServerTransport } from '../contract/sdk/seam.js';",
      '',
      'export function boot(): ReturnType<typeof createV1McpServer> {',
      "  const s = createV1McpServer({ name: 'ok', version: '0.0.0' });",
      '  void createV1StdioServerTransport();',
      '  return s;',
      '}',
    ].join('\n');

    expect(detectSdkSeamUsage(ROGUE_MODULE, throughSeam, parseModuleSpecifiers)).toBeUndefined();

    const live = await scanSdkSeamBoundary(REPO_ROOT, parseModuleSpecifiers);
    expect(runSdkSeamBoundaryCensus(live).ok).toBe(true);
  });

  it('SdkSeam_SpecifierInCommentOrLiteral_IsNotABypass', () => {
    // NEGATIVE TWIN #2 — the rule reads the syntax tree, not the text. This is
    // the defect task 062 removed one boundary over (a template-literal
    // specifier counted as an import and floored DR-26's denominator ten above
    // zero); re-asserted here because this census inherits the same policy
    // module and would inherit the same defect if the parse were swapped for a
    // regex.
    const decoys = [
      `// import { X } from '${v1Spec('types.js')}';`,
      `/* export * from '${v2Spec('core')}'; */`,
      `const FIXTURE = \`import { Y } from '${v1Spec('inMemory.js')}';\`;`,
      `const note = "see: import z from '${v2Spec('server')}'";`,
      'void FIXTURE; void note;',
    ].join('\n');

    expect(detectSdkSeamUsage(ROGUE_MODULE, decoys, parseModuleSpecifiers)).toBeUndefined();
  });

  it('SdkSeam_MigratedTree_ResolvesEverySiteThroughSeam', async () => {
    // ── TOTALITY, over a DERIVED population ─────────────────────────────────
    // The subject list is walked out of the tree, never enumerated here: a list
    // written into a test is a second authority that goes stale the moment a
    // module moves, which is the defect class this program exists to close.
    // SCANNED AT THE REPO ROOT. The claim is about the repository — "the SOLE
    // importer of either generation" — so it has to be measured over the
    // repository. Rooted at `src` it read green while a live
    // v1 client sat in the root package's `test/fixtures/` with a dozen importers,
    // and a v2 client bypassed the seam in the MCP package's own `test/process/`.
    // Neither was exempt; both were out of frame. A guard's scan root is part of
    // its claim.
    const scan = await scanSdkSeamBoundary(REPO_ROOT, parseModuleSpecifiers);

    // NON-EMPTY DENOMINATOR, DERIVED rather than floored. A bare `> 50` cannot
    // fail here: `src` alone holds ~1545 modules, so a scan
    // that lost 96% of the tree still cleared it — the same loose-floor shape that
    // let a src-only walk pass for a package-wide claim. Pinning against an
    // independently counted population means a narrowed root fails instead.
    const trackedModules = countTrackedModules(REPO_ROOT);
    expect(
      scan.moduleCount,
      'the walk resolved far fewer modules than the repository tracks — scan root ' +
        'moved, an exclusion widened, or the walker broke',
    ).toBeGreaterThan(trackedModules * 0.8);
    expect(scan.seamModulePresent).toBe(true);

    // Split by the scan's OWN seam classification rather than by re-deriving the
    // path: at repo-root scope every module is repo-root-relative, so the bare
    // `seamModule` name would not match and re-spelling it here would plant a
    // second authority for where the seam lives.
    const seamImporters = scan.usages.filter((u) => u.isSeam).map((u) => u.module);
    const bypassImporters = scan.usages.filter((u) => !u.isSeam).map((u) => u.module).sort();

    expect(seamImporters, 'exactly one module is the owned seam').toHaveLength(1);
    expect(seamImporters[0]).toMatch(/(^|\/)sdk\/seam\.ts$/);

    expect(
      bypassImporters,
      'EVERY module importing an MCP SDK package must be the owned seam or carry a ' +
        'dated, owned, expiring exemption. Any other name here is a module that ' +
        'reaches a generation directly, which is what DR-26 forbids and what task ' +
        '053 migrated 42 sites across 22 files to eliminate.',
    ).toEqual([...SDK_SEAM_BOUNDARY.exemptions.map((e) => e.module)].sort());

    const result = runSdkSeamBoundaryCensus(scan);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.bypassModuleCount).toBe(0);
    // The seam is a REAL subject, not a name that resolves to nothing.
    expect(result.seamImportCount).toBeGreaterThan(0);

    // ── THE SECOND AUTHORITY ────────────────────────────────────────────────
    // Every generation npm was asked to INSTALL must still reach the seam. The
    // expected set is read from `package.json` rather than written as
    // `['v1','v2']`: a literal would make this a comparison of the tree with
    // itself, and DR-30 is right that such a comparison can never disagree.
    // Read this way the two sides are independent — dropping `sdk` from
    // `dependencies`, or letting the seam's v2 re-exports rot away, each shows
    // up here as a disagreement instead of a silent pass.
    const seamGenerations = new Set(
      scan.usages.flatMap((u) => u.imports.map((i) => i.generation)),
    );
    const pkgRaw: unknown = JSON.parse(readFileSync(join(SRC_ROOT, '..', 'package.json'), 'utf8'));
    const deps: Record<string, unknown> =
      typeof pkgRaw === 'object' && pkgRaw !== null && 'dependencies' in pkgRaw
        ? Object(Reflect.get(pkgRaw, 'dependencies'))
        : {};
    const installedGenerations = new Set(
      Object.keys(deps)
        .map((name) => classifySdkImport(name))
        .filter((generation) => generation !== undefined),
    );
    expect(
      installedGenerations.size,
      'no @modelcontextprotocol dependency resolved — the second authority is empty',
    ).toBeGreaterThan(0);
    expect([...seamGenerations].sort()).toEqual([...installedGenerations].sort());
  });

  it('SdkSeam_AuditOverLiveTree_IsGreen', async () => {
    // The shipped entry point, end to end — `scanSdkSeamBoundary` +
    // `runSdkSeamBoundaryCensus` composed exactly as a caller would use them.
    const result = await auditSdkSeamBoundary(REPO_ROOT, parseModuleSpecifiers);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('DR-26 — SDK seam rule: fail-closed teeth', () => {
  // These cases exercise the CENSUS MECHANICS against synthetic scans, so they
  // carry their own rule with no exemptions. Reading the shipped roster here
  // would couple every mechanic assertion to the live licence list: each shipped
  // exemption names a module absent from a synthetic scan, which the STALE tooth
  // correctly reports — the tooth firing, not the mechanic breaking. The shipped
  // roster has its own assertion at the end of this block.
  const SYNTHETIC_RULE: SdkSeamBoundaryRule = {
    seamModule: SDK_SEAM_BOUNDARY.seamModule,
    exemptions: [],
  };
  const seamUsage: SdkSeamUsage = {
    module: SDK_SEAM_BOUNDARY.seamModule,
    isSeam: true,
    imports: [
      { specifier: v1Spec('server/mcp.js'), generation: 'v1', line: 1 },
      { specifier: v2Spec('server'), generation: 'v2', line: 2 },
    ],
  };
  const healthy: SdkSeamBoundaryScan = {
    usages: [seamUsage],
    moduleCount: 400,
    seamModulePresent: true,
  };
  const rogue: SdkSeamUsage = {
    module: ROGUE_MODULE,
    isSeam: false,
    imports: [{ specifier: v1Spec('types.js'), generation: 'v1', line: 3 }],
  };

  it('SdkSeamRule_HealthyScan_IsGreen', () => {
    // POSITIVE CONTROL. Without it, every rejection below would be consistent
    // with a census that fails on everything.
    expect(runSdkSeamBoundaryCensus(healthy, SYNTHETIC_RULE).ok).toBe(true);
  });

  it('SdkSeamRule_ZeroModulesVisited_FailsClosed', () => {
    const result = runSdkSeamBoundaryCensus({ ...healthy, moduleCount: 0 });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('EMPTY_SDK_SEAM_DENOMINATOR');
  });

  it('SdkSeamRule_SeamImportsNothing_FailsClosed', () => {
    // The scanner stopped matching: no bypass is reported and none could be.
    const result = runSdkSeamBoundaryCensus({ ...healthy, usages: [] });
    expect(result.ok).toBe(false);
    const empty = result.diagnostics.filter((d) => d.code === 'EMPTY_SDK_SEAM_DENOMINATOR');
    expect(empty.some((d) => 'population' in d && d.population === 'seam-imports')).toBe(true);
  });

  it('SdkSeamRule_SeamModuleMissing_FailsClosed', () => {
    const result = runSdkSeamBoundaryCensus({
      usages: [],
      moduleCount: 400,
      seamModulePresent: false,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('SDK_SEAM_MODULE_ABSENT');
  });

  it('SdkSeamRule_ExemptModule_IsNotAViolationButMustBeLive', () => {
    const rule = {
      seamModule: SDK_SEAM_BOUNDARY.seamModule,
      exemptions: [
        {
          module: ROGUE_MODULE,
          owner: 'exarchos',
          expires: '2099-01-01',
          reason: 'unit-test fixture',
        },
      ],
    };
    // An exemption suppresses the violation it names...
    const covered = runSdkSeamBoundaryCensus(
      { ...healthy, usages: [seamUsage, rogue] },
      rule,
      '2026-08-07',
    );
    expect(covered.ok).toBe(true);
    expect(covered.bypassModuleCount).toBe(0);

    // ...and becomes a failure itself the moment nothing exercises it, so an
    // exemption cannot decay into cover for a violation that arrives later.
    const stale = runSdkSeamBoundaryCensus(healthy, rule, '2026-08-07');
    expect(stale.ok).toBe(false);
    expect(stale.diagnostics.map((d) => d.code)).toContain('STALE_SDK_SEAM_EXEMPTION');
  });

  it('SdkSeamRule_ExpiredExemption_FailsClosed', () => {
    const result = runSdkSeamBoundaryCensus(
      { ...healthy, usages: [seamUsage, rogue] },
      {
        seamModule: SDK_SEAM_BOUNDARY.seamModule,
        exemptions: [
          {
            module: ROGUE_MODULE,
            owner: 'exarchos',
            expires: '2026-01-01',
            reason: 'unit-test fixture',
          },
        ],
      },
      '2026-08-07',
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('EXPIRED_SDK_SEAM_EXEMPTION');
  });

  it('SdkSeamRule_ShippedExemptions_AreProcessHarnessesOnly_AndFullyGoverned', () => {
    // Was `toEqual([])`. That assertion did its job — widening the audit to the
    // repository surfaced three process-level test harnesses that drive a real
    // server over stdio, and licensing them had to arrive as a reviewed diff
    // rather than a quiet edit. It is replaced, not deleted: the roster is still
    // pinned, and every entry must still be fully governed.
    //
    // The PRODUCTION tree licenses none of these — that is the claim task 053
    // earned and this keeps. Each entry is a test harness that needs the real
    // transport, which is exactly what the seam abstracts away.
    expect(SDK_SEAM_BOUNDARY.exemptions.map((e) => e.module).sort()).toEqual([
      'tests/core/process/_helpers.ts',
      'tests/helpers/__helpers__/mock-mcp-server.mjs',
      'tests/helpers/mcp-client.ts',
    ]);

    for (const entry of SDK_SEAM_BOUNDARY.exemptions) {
      // No production module may be licensed — the moment one appears here the
      // exemption list has stopped being a test-harness carve-out.
      expect(entry.module).toMatch(/(^|\/)tests\//);
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // An already-expired entry would be shipped debt the EXPIRED tooth reports
      // on every run; the roster must be live when it lands.
      expect(entry.expires > new Date().toISOString().slice(0, 10)).toBe(true);
    }
  });
});

// ─── Task 040a — the two censuses that ride along with the layering one ──────
//
// This file carries THREE censuses. Work scoped to the layering table has twice
// come close to migrating it alone, which would leave the other two pointing at
// module paths that no longer exist — and a seam whose paths resolve to nothing
// does not fail, it reports clean. Each census owns vacuity teeth for exactly
// that, and each is unit-tested above. What was missing is the assertion that
// binds them: a check that BOTH still refuse an empty rule set, in one place, so
// dropping either one during a migration is a red test rather than a silence.

describe('Task 040a — neither seam may pass by matching nothing', () => {
  it('BothSeams_VacuityCheck_FailsOnAnEmptyRuleSet', () => {
    // Declaration seam: no consumers resolved and no stores declared.
    const declaration = runDeclarationSeamCensus(
      { usages: [], storage: [], accessorPresent: true },
      { contractModules: [], storage: [], sourceAdapters: [], accessorModule: 'contract/declaration-seam.ts' },
    );
    expect(declaration.ok, 'an empty declaration rule set must FAIL, not read clean').toBe(false);
    expect(declaration.diagnostics.map((d) => d.code)).toContain('EMPTY_SEAM_DENOMINATOR');

    // SDK seam: nothing visited and nothing importing the seam.
    const sdk = runSdkSeamBoundaryCensus(
      { usages: [], moduleCount: 0, seamModulePresent: true },
      { seamModule: SDK_SEAM_BOUNDARY.seamModule, exemptions: [] },
    );
    expect(sdk.ok, 'an empty SDK rule set must FAIL, not read clean').toBe(false);
    expect(sdk.diagnostics.map((d) => d.code)).toContain('EMPTY_SDK_SEAM_DENOMINATOR');
  });

  it('BothSeams_OnTheLiveTree_HaveNonEmptyDenominators', async () => {
    // The converse, and the half that actually rots: the teeth above only bite
    // when a denominator reaches ZERO. If the live denominators drifted down to
    // one or two modules both censuses would still be "non-empty" and would
    // govern almost nothing. Characterised as a floor so shrinkage is visible
    // rather than merely survivable.
    const declaration = await auditDeclarationSeam(SRC_ROOT, lexModule);
    expect(declaration.ok).toBe(true);
    expect(declaration.consumerCount).toBeGreaterThan(1);
    expect(declaration.resolvedStorageCount).toBeGreaterThan(0);

    const sdk = await scanSdkSeamBoundary(REPO_ROOT, parseModuleSpecifiers);
    expect(sdk.moduleCount).toBeGreaterThan(100);
    expect(sdk.usages.length).toBeGreaterThan(0);
    expect(sdk.seamModulePresent).toBe(true);
  });

  it('BothSeams_DeclaredPaths_StillResolveAfterTheLayeringChange', async () => {
    // Task 040 changed `layerOf` and removed the root-file exclusion. Those
    // belong to the layering census, but all three censuses live in one module
    // and read one scan, so "the layering change was self-contained" is a claim
    // worth an instrument rather than a reading of the diff.
    expect(DECLARATION_SEAM.storage.length).toBeGreaterThan(0);
    expect(DECLARATION_SEAM.contractModules.length).toBeGreaterThan(0);
    expect(SDK_SEAM_BOUNDARY.seamModule.length).toBeGreaterThan(0);

    // Every declared store must still be a real module exporting the symbol
    // that makes it a store — the UNRESOLVED tooth, asserted directly rather
    // than inferred from a green verdict.
    const scan = await scanDeclarationSeam(SRC_ROOT, lexModule);
    for (const store of DECLARATION_SEAM.storage) {
      const resolved = scan.storage.find((s) => s.module === store.module);
      expect(resolved, `declared store ${store.module} vanished from the scan`).toBeDefined();
      expect(resolved?.resolved, `declared store ${store.module} no longer resolves`).toBe(true);
    }
  });
});

describe('source hygiene', () => {
  it('LayerBoundariesSeam_Source_ContainsNoRawNulBytes', () => {
    // A literal NUL in this module made ripgrep treat it as binary and skip
    // it. The runtime separator is the `\0` escape, which is the same value
    // without hiding the file from text-mode audit.
    const file = join(SRC_ROOT, 'architecture/layer-boundaries-seam.ts');
    const bytes = readFileSync(file);
    expect(bytes.includes(0), 'a raw NUL hides this file from ripgrep').toBe(false);
    expect(bytes.toString('utf8')).toContain('${target}\\0${specifier}');
  });
});
