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

import { existsSync, readFileSync } from 'node:fs';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { classifySdkImport } from '../../../src/architecture/sdk-generation-seam.js';
import { parseModuleSpecifiers } from '../../../tools/test-helpers/module-specifier-parser.js';

/**
 * The `src` directory. The SDK seam sweep in this file compares two sources.
 * Neither source derives from the other.
 * `sdk-generation-seam.ts` holds the rule: the seam module and the package names of each generation.
 * `package.json` holds the SDK generations that npm installs.
 *
 * @oracle-sources: ../../../src/architecture/sdk-generation-seam.ts, ../../../package.json
 */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../src');

/** The repository root. */
const REPO_ROOT = join(SRC_ROOT, '..');

/**
 * Counts the modules that git tracks under `root`, without the walker.
 * `git ls-files` knows nothing of the exclusions or the recursion of the scan.
 * As a result, agreement between the two counts shows that the walk reached the tree.
 */
async function countTrackedModules(root: string): Promise<number> {
  const out = await execFileAsync(
    'git',
    ['ls-files', '--', '*.ts', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'],
    { cwd: root },
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

  /**
   * With `adapters/mcp` declared, a module under it belongs to that layer and not to `adapters`.
   * An edge to a sibling adapter is then a cross-layer edge, which the census does not skip.
   * A module under no nested id falls back to the parent. The longest match wins in any declaration order.
   * A prefix that does not end at a path boundary does not claim the module.
   */
  it('LayerOf_ModuleUnderNestedLayerId_ResolvesToTheLongestMatch', () => {
    const ids = ['adapters', 'adapters/mcp', 'adapters/cli'];
    expect(layerOf('adapters/mcp/mcp.ts', ids)).toBe('adapters/mcp');
    expect(layerOf('adapters/cli/cli.ts', ids)).toBe('adapters/cli');
    expect(layerOf('adapters/channel/ndjson.ts', ids)).toBe('adapters');
    expect(layerOf('adapters/mcp/mcp.ts', [...ids].reverse())).toBe('adapters/mcp');
    expect(layerOf('adapters-legacy/x.ts', ids)).toBe('adapters-legacy');
  });

  it('treats a root-level file as a root file, and gives it the stated root layer', () => {
    expect(isRootFile('format.ts')).toBe(true);
    expect(isRootFile('workflow/x.ts')).toBe(false);
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

  /** A root-level file is an ordinary source layer. With no edges from it, no rule can govern a root file. */
  it('LayerCensus_RootFile_ContributesEdgesUnderTheStatedPolicy', () => {
    const edges = detectLayerEdges('registry.ts', `import { x } from './workflow/y.js';`, lexModule);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.sourceLayer).toBe(ROOT_LAYER);
    expect(edges[0]?.targetLayer).toBe('workflow');
    expect(edges[0]?.module).toBe('registry.ts');
  });

  /**
   * Under the first-segment model both ends resolve to `adapters`, and the intra-layer skip drops the edge.
   * The last assertion shows this: the same import gives no edge without the nested ids.
   * The message must name both modules, because a layer pair does not show which module made the import.
   */
  it('LayerCensus_McpImportingCli_ReportsForbiddenImportNamingBothEnds', () => {
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
    const [only] = forbidden;
    expect(only?.message).toContain('adapters/mcp/mcp.ts');
    expect(only?.message).toContain('adapters/cli/cli.ts');

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

  /** The `runtime -> utils` edge exercises the `runtime` allowance, so only the ungoverned edge is under test. */
  it('does NOT flag an ungoverned source layer as FORBIDDEN', () => {
    const edges: LayerEdge[] = [
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
  /** The diagnostics assertion runs first, so a regression prints each diagnostic. */
  it('(a) the live shipped source has ZERO forbidden imports and no stale allowance', async () => {
    const result = await auditLayerBoundaries(SRC_ROOT, lexModule);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.edgeCount).toBeGreaterThan(0);
  });

  /**
   * The scan uses the same declared ids that the census judges against.
   * With a nested id declared, a scan under a different id set makes the rows of that id look phantom.
   */
  it('(b) a planted forbidden import from a governed leaf FAILS against the live edges', async () => {
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

  /**
   * A green census does not show that each row can still reject.
   * The test seeds one violation for each declared rule. The census must fail and name the seeded module.
   * Each seeded target comes from the live layer set, so the seeded edge has the shape of a real edge.
   */
  it('LayerRule_SeededViolation_FailsAndNamesTheRule', async () => {
    const edges = await scanLayerEdges(SRC_ROOT, lexModule, declaredLayerIds());
    expect(LAYER_ALLOWED_IMPORTS.length).toBeGreaterThan(20);

    const everyLayer = new Set<string>();
    for (const e of edges) {
      everyLayer.add(e.sourceLayer);
      everyLayer.add(e.targetLayer);
    }

    for (const rule of LAYER_ALLOWED_IMPORTS) {
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

  /** An allowance that no live edge exercises governs nothing, so the census must fail on it. */
  it('LayerAllowance_PhantomCover_FailsAsStale', async () => {
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

  /**
   * A row that names an absent directory never forbids and never goes stale.
   * An empty `allow` has no unused target, and no module resolves to the id.
   * The seeded-violation tests plant synthetic files, so they pass without live coverage.
   * The test walks the tree, so a foundation leaf that imports nothing is still visible.
   */
  it('every declared layer id owns at least one scanned module', async () => {
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

  /** Root files stay in the edge set as `<root>`. A skip on `isRootFile` makes `registry.ts` ungovernable. */
  it('LayerCensus_LiveTree_CountsRootFilesAsTheStatedRootLayer', async () => {
    const edges = await scanLayerEdges(SRC_ROOT, lexModule, declaredLayerIds());
    const rootSources = edges.filter((e) => e.sourceLayer === ROOT_LAYER);
    const rootTargets = edges.filter((e) => e.targetLayer === ROOT_LAYER);
    expect(rootSources.length, 'no live edge leaves <root>').toBeGreaterThan(0);
    expect(rootTargets.length, 'no live edge reaches <root>').toBeGreaterThan(0);
    expect(
      edges.some((e) => e.module === 'registry.ts' || e.targetModule === 'registry.ts'),
      'registry.ts is absent from the live edge set',
    ).toBe(true);
    const seam = readFileSync(join(SRC_ROOT, 'architecture/layer-boundaries-seam.ts'), 'utf8');
    expect(seam).not.toMatch(/if\s*\(\s*isRootFile\s*\(/);
  });

  it('LayerAllowance_VacantFoundationIds_StayAbsentWhileThoseDirectoriesStayAbsent', () => {
    const vacant = ['lib', 'shared', 'schemas'] as const;
    for (const id of vacant) {
      const onDisk = existsSync(join(SRC_ROOT, id));
      const declared = LAYER_ALLOWED_IMPORTS.some((a) => a.layer === id);
      expect(declared, `${id} is declared as a layer while the directory is ${onDisk ? 'present' : 'absent'}`).toBe(
        onDisk,
      );
    }
  });

  it('LayerAllowance_AdaptersParent_IsChannelTransportOnly', () => {
    const parent = LAYER_ALLOWED_IMPORTS.find((a) => a.layer === 'adapters');
    expect(parent, 'the adapters parent row is missing').toBeDefined();
    expect(parent?.allow).toEqual(['events']);

    const mcp = LAYER_ALLOWED_IMPORTS.find((a) => a.layer === 'adapters/mcp');
    expect(mcp, 'the adapters/mcp row is missing').toBeDefined();
    expect(mcp?.allow).not.toContain('adapters/cli');

    const cli = LAYER_ALLOWED_IMPORTS.find((a) => a.layer === 'adapters/cli');
    expect(cli, 'the adapters/cli row is missing').toBeDefined();
    expect(cli?.allow).toContain('adapters/mcp');
  });

  it('LayerAllowance_EveryGovernedIdExceptRoot_IsPlaceableOnTheFirstLevelMap', () => {
    const map = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/audit/layer-map.json'), 'utf8')) as {
      directories: Record<string, unknown>;
    };
    for (const row of LAYER_ALLOWED_IMPORTS) {
      if (row.layer === ROOT_LAYER) continue;
      const first = row.layer.split('/')[0] ?? '';
      expect(
        map.directories[first],
        `${row.layer} is not placeable via first-level map key ${first}`,
      ).toBeDefined();
    }
    expect(Object.keys(map.directories)).not.toContain('adapters/cli');
    expect(Object.keys(map.directories)).not.toContain('adapters/mcp');
  });
});

/** The on-disk seeded consumer that bypasses the seam (the kill-probe subject). */
const VIOLATOR_FIXTURE = join(SRC_ROOT, 'architecture/__fixtures__/declaration-seam-violator.fixture.ts');
/** The path of the fixture relative to `src`. */
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

  /**
   * The synthetic rule names the root-level `registry.ts` as a store, so the detector must resolve a root-file import.
   * The layering census resolves the same edge. The two censuses stay separate for a different reason.
   * A layer allowance is unconditional, and the declaration rule fires only for a module that consumes declarations.
   * That condition keeps the population self-maintaining, and an allowance row cannot express it.
   */
  it('detectDeclarationSeamUsage_RootLevelStoreImport_IsResolvedNotSkipped', () => {
    const found = detectDeclarationSeamUsage(
      'contract/rogue.ts',
      `import type { Declaration } from './declaration.js';
       import { TOOL_REGISTRY } from '../registry.js';`,
      lexModule, TEST_RULE,
    );

    expect(found?.storageImports.map((i) => i.storageModule)).toEqual(['registry.ts']);

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

  /** A store can move while a comment still holds its name. A match on that comment resolves a store that is gone. */
  it('exportsDeclarationSymbol_SymbolOnlyMentionedInADocComment_ReturnsFalse', () => {
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

  /** A module that knows nothing about declarations is not a violation, so the census needs no grandfather list. */
  it('runDeclarationSeamCensus_NonConsumerImportingAStore_IsNotFlagged', () => {
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

  /** If the contract modules or the stores move, these counts drop and the census fails. */
  it('auditDeclarationSeam_LiveShippedSource_ResolvesANonEmptyConsumerAndStorePopulation', async () => {
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

  /** The `subject` of the envelope is a type parameter, so `contract/declaration.ts` needs no store import to type it. */
  it('scanDeclarationSeam_LiveEnvelopeAndAccessor_ImportNoDeclarationStorage', async () => {
    const scan = await scanDeclarationSeam(SRC_ROOT, lexModule);

    for (const module of DECLARATION_SEAM.contractModules) {
      const found = scan.usages.find((u) => u.module === module);
      expect(found?.storageImports ?? [], `${module} imports declaration storage`).toEqual([]);
    }
  });

  /**
   * Kill probe. The fixture is a real file: a declaration consumer that reads `EVENT_EMISSION_REGISTRY` around the seam.
   * The shipped detector reads the fixture, and the test adds the result to the live scan.
   */
  it('runDeclarationSeamCensus_SeededOnDiskConsumerReadingStorageDirectly_FailsAgainstTheLiveTree', async () => {
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

  /** A fixture inside the live scan makes the census fail on every run, so the scanner must exclude it. */
  it('scanDeclarationSeam_LiveTree_ExcludesTheSeededViolatorFixture', async () => {
    const scan = await scanDeclarationSeam(SRC_ROOT, lexModule);

    expect(scan.usages.map((u) => u.module)).not.toContain(VIOLATOR_MODULE);
  });
});

describe('DR-26 — SDK generation seam: a direct SDK import fails the rule', () => {
  /**
   * The kill fixture. The migrated tree holds no direct SDK import outside the exemptions, so the test seeds one.
   * Without the seed, zero violations look the same as a rule that cannot fire.
   * The test adds the seeded module to the live scan, so the rule runs as it does against this tree.
   * The message must name the seam module, so the reader knows what to import.
   */
  it('SdkSeam_DirectSdkImport_FailsSeamRule', async () => {
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
    expect(rejections[0]?.message).toContain(SDK_SEAM_BOUNDARY.seamModule);
  });

  /**
   * NEGATIVE TWIN 1: the rule measures the bypass, not any use of the SDK.
   * Without this arm, the kill fixture also passes against a rule that rejects every module in `adapters/`.
   */
  it('SdkSeam_SameModuleThroughTheSeam_Passes', async () => {
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

  /**
   * NEGATIVE TWIN 2: the rule reads the syntax tree, not the text.
   * A regex matcher counts a specifier in a comment, a string or a template literal as an import.
   */
  it('SdkSeam_SpecifierInCommentOrLiteral_IsNotABypass', () => {
    const decoys = [
      `// import { X } from '${v1Spec('types.js')}';`,
      `/* export * from '${v2Spec('core')}'; */`,
      `const FIXTURE = \`import { Y } from '${v1Spec('inMemory.js')}';\`;`,
      `const note = "see: import z from '${v2Spec('server')}'";`,
      'void FIXTURE; void note;',
    ].join('\n');

    expect(detectSdkSeamUsage(ROGUE_MODULE, decoys, parseModuleSpecifiers)).toBeUndefined();
  });

  /**
   * The scan derives the subject list from the tree, and its root is the repository root.
   * A scan rooted at `src` cannot see an SDK client under `tests/`.
   * The module count must exceed 80% of an independent `git ls-files` count, so a narrowed root fails.
   * The split uses the seam classification of the scan, so the seam path has one authority.
   *
   * The second authority is `package.json`. The generations that the scan finds must equal the installed generations.
   * A literal `['v1','v2']` compares the tree with itself and can never disagree.
   */
  it('SdkSeam_MigratedTree_ResolvesEverySiteThroughSeam', async () => {
    const scan = await scanSdkSeamBoundary(REPO_ROOT, parseModuleSpecifiers);

    const trackedModules = await countTrackedModules(REPO_ROOT);
    expect(
      scan.moduleCount,
      'the walk resolved far fewer modules than the repository tracks — scan root ' +
        'moved, an exclusion widened, or the walker broke',
    ).toBeGreaterThan(trackedModules * 0.8);
    expect(scan.seamModulePresent).toBe(true);

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
    expect(result.seamImportCount).toBeGreaterThan(0);

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

  /** The shipped entry point, which composes the scan and the census. */
  it('SdkSeam_AuditOverLiveTree_IsGreen', async () => {
    const result = await auditSdkSeamBoundary(REPO_ROOT, parseModuleSpecifiers);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/**
 * These cases run the census mechanics against synthetic scans. `SYNTHETIC_RULE` holds no exemptions.
 * Each shipped exemption names a module that a synthetic scan does not hold, so the stale check reports it.
 * The last case in this block asserts the shipped roster.
 */
describe('DR-26 — SDK seam rule: fail-closed teeth', () => {
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

  /** Positive control. Without it, a census that fails on everything also satisfies each rejection in this block. */
  it('SdkSeamRule_HealthyScan_IsGreen', () => {
    expect(runSdkSeamBoundaryCensus(healthy, SYNTHETIC_RULE).ok).toBe(true);
  });

  it('SdkSeamRule_ZeroModulesVisited_FailsClosed', () => {
    const result = runSdkSeamBoundaryCensus({ ...healthy, moduleCount: 0 });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('EMPTY_SDK_SEAM_DENOMINATOR');
  });

  /** A scanner that matches nothing reports no bypass and can report none. */
  it('SdkSeamRule_SeamImportsNothing_FailsClosed', () => {
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

  /**
   * An exemption suppresses the violation that it names.
   * An unexercised exemption fails, so it cannot cover a later violation.
   */
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
    const covered = runSdkSeamBoundaryCensus(
      { ...healthy, usages: [seamUsage, rogue] },
      rule,
      '2026-08-07',
    );
    expect(covered.ok).toBe(true);
    expect(covered.bypassModuleCount).toBe(0);

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

  /**
   * The roster is pinned, so a new exemption arrives as a reviewed diff.
   * Each entry is a test harness that needs the real transport, which the seam abstracts away.
   * No production module holds an exemption. An expired entry is debt on every run, so each entry must be live.
   */
  it('SdkSeamRule_ShippedExemptions_AreProcessHarnessesOnly_AndFullyGoverned', () => {
    expect(SDK_SEAM_BOUNDARY.exemptions.map((e) => e.module).sort()).toEqual([
      'tests/core/process/_helpers.ts',
      'tests/helpers/__helpers__/mock-mcp-server.mjs',
      'tests/helpers/mcp-client.ts',
    ]);

    for (const entry of SDK_SEAM_BOUNDARY.exemptions) {
      expect(entry.module).toMatch(/(^|\/)tests\//);
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.expires > new Date().toISOString().slice(0, 10)).toBe(true);
    }
  });
});

/**
 * This file holds three censuses, and a migration of the layering census alone can leave the other two stale.
 * A seam whose paths resolve to nothing must fail. These tests bind that check for both seams in one place.
 */
describe('Task 040a — neither seam may pass by matching nothing', () => {
  it('BothSeams_VacuityCheck_FailsOnAnEmptyRuleSet', () => {
    const declaration = runDeclarationSeamCensus(
      { usages: [], storage: [], accessorPresent: true },
      { contractModules: [], storage: [], sourceAdapters: [], accessorModule: 'contract/declaration-seam.ts' },
    );
    expect(declaration.ok, 'an empty declaration rule set must FAIL, not read clean').toBe(false);
    expect(declaration.diagnostics.map((d) => d.code)).toContain('EMPTY_SEAM_DENOMINATOR');

    const sdk = runSdkSeamBoundaryCensus(
      { usages: [], moduleCount: 0, seamModulePresent: true },
      { seamModule: SDK_SEAM_BOUNDARY.seamModule, exemptions: [] },
    );
    expect(sdk.ok, 'an empty SDK rule set must FAIL, not read clean').toBe(false);
    expect(sdk.diagnostics.map((d) => d.code)).toContain('EMPTY_SDK_SEAM_DENOMINATOR');
  });

  /**
   * The empty-denominator checks fire only at zero, so a denominator of one or two modules still passes them.
   * The floors on `consumerCount` and `moduleCount` make that shrinkage fail.
   */
  it('BothSeams_OnTheLiveTree_HaveNonEmptyDenominators', async () => {
    const declaration = await auditDeclarationSeam(SRC_ROOT, lexModule);
    expect(declaration.ok).toBe(true);
    expect(declaration.consumerCount).toBeGreaterThan(1);
    expect(declaration.resolvedStorageCount).toBeGreaterThan(0);

    const sdk = await scanSdkSeamBoundary(REPO_ROOT, parseModuleSpecifiers);
    expect(sdk.moduleCount).toBeGreaterThan(100);
    expect(sdk.usages.length).toBeGreaterThan(0);
    expect(sdk.seamModulePresent).toBe(true);
  });

  /**
   * The three censuses live in one module, so a change to the layering census can reach the two seams.
   * Each declared store must still be a real module that exports its store symbol.
   */
  it('BothSeams_DeclaredPaths_StillResolveAfterTheLayeringChange', async () => {
    expect(DECLARATION_SEAM.storage.length).toBeGreaterThan(0);
    expect(DECLARATION_SEAM.contractModules.length).toBeGreaterThan(0);
    expect(SDK_SEAM_BOUNDARY.seamModule.length).toBeGreaterThan(0);

    const scan = await scanDeclarationSeam(SRC_ROOT, lexModule);
    for (const store of DECLARATION_SEAM.storage) {
      const resolved = scan.storage.find((s) => s.module === store.module);
      expect(resolved, `declared store ${store.module} vanished from the scan`).toBeDefined();
      expect(resolved?.resolved, `declared store ${store.module} no longer resolves`).toBe(true);
    }
  });
});

describe('source hygiene', () => {
  /**
   * A literal NUL byte makes ripgrep treat the module as binary and skip it.
   * The `\0` escape gives the same runtime separator and keeps the file visible to a text-mode audit.
   */
  it('LayerBoundariesSeam_Source_ContainsNoRawNulBytes', () => {
    const file = join(SRC_ROOT, 'architecture/layer-boundaries-seam.ts');
    const bytes = readFileSync(file);
    expect(bytes.includes(0), 'a raw NUL hides this file from ripgrep').toBe(false);
    expect(bytes.toString('utf8')).toContain('${target}\\0${specifier}');
  });
});
