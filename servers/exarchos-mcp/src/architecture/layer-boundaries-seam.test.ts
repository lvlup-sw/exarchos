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

describe('detectDeclarationSeamUsage', () => {
  it('detectDeclarationSeamUsage_ModuleImportingContractAndStore_ReportsBothSides', () => {
    const found = detectDeclarationSeamUsage(
      'describe/handler.ts',
      `import type { Declaration } from '../contract/declaration.js';
       import { TOOL_REGISTRY } from '../registry.js';
       import { z } from 'zod';`,
      TEST_RULE,
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
        `import { EventStore } from '../event-store/store.js';`,
        TEST_RULE,
      ),
    ).toBeUndefined();
  });

  it('detectDeclarationSeamUsage_RootLevelStoreImport_IsResolvedNotSkipped', () => {
    // The layering census above deliberately ignores root-file edges. This
    // census must NOT, or `registry.ts` — the largest declaration store — would
    // be invisible to it.
    const found = detectDeclarationSeamUsage(
      'contract/rogue.ts',
      `import type { Declaration } from './declaration.js';
       import { TOOL_REGISTRY } from '../registry.js';`,
      TEST_RULE,
    );

    expect(found?.storageImports.map((i) => i.storageModule)).toEqual(['registry.ts']);
    expect(detectLayerEdges('contract/rogue.ts', `import { X } from '../registry.js';`)).toEqual([]);
  });

  it('detectDeclarationSeamUsage_StoreNamedOnlyInACommentOrString_ReportsNoImport', () => {
    const found = detectDeclarationSeamUsage(
      'contract/prose.ts',
      `import type { Declaration } from './declaration.js';
       // import { TOOL_REGISTRY } from '../registry.js';
       const doc = "see '../registry.js'";
       export const x = doc;`,
      TEST_RULE,
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
      TEST_RULE,
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
    const result = await auditDeclarationSeam(SRC_ROOT);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('auditDeclarationSeam_LiveShippedSource_ResolvesANonEmptyConsumerAndStorePopulation', async () => {
    // The non-empty-denominator criterion, measured rather than asserted: if the
    // contract modules or the stores are moved/renamed, these drop to zero and
    // the census above fails instead of reading clean.
    const result = await auditDeclarationSeam(SRC_ROOT);

    expect(result.consumerCount).toBeGreaterThan(0);
    expect(result.resolvedStorageCount).toBe(DECLARATION_SEAM.storage.length);
    expect(result.resolvedStorageCount).toBeGreaterThan(0);
  });

  it('scanDeclarationSeam_LiveTree_FindsTheAccessorAndEveryDeclaredStore', async () => {
    const scan = await scanDeclarationSeam(SRC_ROOT);

    expect(scan.accessorPresent).toBe(true);
    expect(scan.storage.filter((s) => !s.resolved)).toEqual([]);
  });

  it('scanDeclarationSeam_LiveEnvelopeAndAccessor_ImportNoDeclarationStorage', async () => {
    // The property behind task 006's `subject` decision: the contract foundation
    // stays storage-free. A kind-indexed subject map would have had to name
    // `CompositeTool` / `CliActionHints`, forcing `contract/declaration.ts` to
    // import `registry.ts` — a store — which is what this pins shut.
    const scan = await scanDeclarationSeam(SRC_ROOT);

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
      await readFile(VIOLATOR_FIXTURE, 'utf8'),
    );
    expect(seeded, 'the seeded fixture must resolve as a seam participant').toBeDefined();
    if (seeded === undefined) return;

    expect(seeded.contractImports.length, 'the fixture must read as a CONSUMER').toBeGreaterThan(0);
    expect(seeded.storageImports.map((i) => i.storageModule)).toEqual(['event-store/schemas.ts']);

    const live = await scanDeclarationSeam(SRC_ROOT);
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
    const scan = await scanDeclarationSeam(SRC_ROOT);

    expect(scan.usages.map((u) => u.module)).not.toContain(VIOLATOR_MODULE);
  });
});
