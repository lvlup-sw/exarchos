/**
 * A census keeps one root for evidence artifacts.
 *
 * A `ContentAddressedStore` reference holds a digest and no root. When a
 * producer and a reader construct the store with different roots, the reader
 * cannot tell the result from a blob that nobody wrote. This suite uses the
 * TypeScript parser to find each value-level use of the class in the shipped
 * tree, through aliases and barrels. Each use must be in a named owner.
 *
 * A scan that finds no construction site reports no violation. Thus the suite
 * compares the scanned population with `git ls-files`, asserts a minimum site
 * count, and seeds real modules on disk.
 */

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanEvidenceStoreConstructions } from '../../tools/test-helpers/evidence-store-construction-census.js';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_DIR = path.join(REPO_ROOT, 'src');

/**
 * The modules that can construct a `ContentAddressedStore` directly. A
 * construction in any other module is a second root that can disagree.
 */
const OWNERS: readonly string[] = [
  /** The constructor that each admission producer and reader uses for evidence artifacts. */
  'src/workflow/admission/evidence-artifact.ts',
  /** A different subject: run bundles. Its own directory-name constant owns its root. */
  'src/events/bundle/run-bundle-store.ts',
  /** A temporary `mkdtemp` root in a self-contained witness. No durable-evidence check reads it. */
  'src/verbs/gates/gate-ownership-census.ts',
];

/**
 * `seededTree` writes a temporary tree with the shape of the real one. It holds
 * the class module at the path that the scanner resolves bindings against, a
 * barrel that re-exports the class, and the given modules. The caller removes
 * the root that it returns.
 */
describe('EvidenceStoreConstructionCensus — one root for evidence artifacts', () => {
  /**
   * `git ls-files` is the second authority, because a scanner that loses most of
   * the tree still reports a plausible count. The comparison is bounded and not
   * equal, because an untracked file under `src/` makes the walk larger. The
   * allowance is one file and not a percentage, because a percentage lets an
   * exclusion regression pass. The limit on vanished modules separates one
   * transient file from a tree that disappears.
   */
  it('Census_ScannedPopulation_IsNotVacuous', async () => {
    const census = scanEvidenceStoreConstructions(REPO_ROOT, {
      sourceDir: SOURCE_DIR,
      owners: OWNERS,
    });
    expect(census.scannedModuleCount).toBeGreaterThan(300);

    const tracked = await listTrackedFiles(REPO_ROOT, {
      exclude: (file) => !file.startsWith('src/') || file.endsWith('.test.ts'),
    });
    expect(tracked.length).toBeGreaterThan(0);
    expect(census.scannedModuleCount).toBeGreaterThanOrEqual(tracked.length);
    expect(
      census.scannedModuleCount,
      'the walk reached more modules than the tree tracks in its scope, beyond the ' +
        "one probe file a sibling test writes — an exclusion stopped working",
    ).toBeLessThanOrEqual(tracked.length + 1);
    expect(
      census.vanishedModuleCount,
      'modules kept vanishing between the walk and the read — this is no longer ' +
        "one sibling test's probe file",
    ).toBeLessThanOrEqual(2);
  }, 60_000);

  /**
   * The site count is the denominator, because a walk that finds no construction
   * site passes the `unowned` assertion vacuously. Each owner constructs the
   * store at least one time.
   */
  it('Census_EveryProductionConstruction_IsOwned', () => {
    const census = scanEvidenceStoreConstructions(REPO_ROOT, {
      sourceDir: SOURCE_DIR,
      owners: OWNERS,
    });
    expect(census.sites.length).toBeGreaterThanOrEqual(4);
    expect(
      census.unowned,
      'every construction outside the allowlist must bind through evidenceArtifactStore() instead',
    ).toEqual([]);
  }, 60_000);

  /**
   * A construction-site scan does not see a literal root that sits in the same
   * file as a call of the shared helper. This test reads the source text.
   */
  it('Census_BothEvidenceProducers_BindToTheRootConstant', () => {
    for (const file of [
      'src/verbs/gates/durable-gate-producer.ts',
      'src/verbs/gates/gate-runner.ts',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, file).toContain('evidenceArtifactStore(');
      expect(source, file).not.toContain("'admission-evidence'");
      expect(source, file).not.toContain("'gate-evidence'");
    }
  });

  async function seededTree(modules: Readonly<Record<string, string>>): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'exarchos-evidence-census-'));
    const artifactsDir = path.join(root, 'src', 'storage', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      path.join(artifactsDir, 'content-addressed-store.ts'),
      'export class ContentAddressedStore {\n  constructor(readonly root: string) {}\n}\n',
      'utf8',
    );
    await writeFile(
      path.join(artifactsDir, 'index.ts'),
      "export { ContentAddressedStore } from './content-addressed-store.js';\n",
      'utf8',
    );
    for (const [rel, source] of Object.entries(modules)) {
      await writeFile(path.join(root, 'src', rel), source, 'utf8');
    }
    return root;
  }

  /** The scan also walks the class module and the barrel, so the module count is 3. */
  it('Census_SeededModuleOnDisk_IsWalkedAndNamed', async () => {
    const root = await seededTree({
      'seeded-evidence-store.ts': [
        "import { ContentAddressedStore } from './storage/artifacts/content-addressed-store.js';",
        "export const s = new ContentAddressedStore(join(stateDir, 'admission-evidence'));",
        '',
      ].join('\n'),
    });
    try {
      const sourceDir = path.join(root, 'src');
      const seeded = scanEvidenceStoreConstructions(root, { sourceDir, owners: [] });
      expect(seeded.scannedModuleCount).toBe(3);
      expect(seeded.unowned).toEqual([
        {
          file: 'src/seeded-evidence-store.ts',
          line: 2,
          text: "export const s = new ContentAddressedStore(join(stateDir, 'admission-evidence'));",
          kind: 'construct',
        },
      ]);
    } finally {
      await rmrfAsync(root);
    }
  });

  /**
   * A line pattern does not see these three shapes. They are an alias of the
   * class, an import through the barrel, and a `new` expression across lines.
   */
  it('Census_AliasedImportThroughTheBarrel_SplitAcrossLines_IsStillAConstruction', async () => {
    const root = await seededTree({
      'seeded-alias.ts': [
        "import { ContentAddressedStore as Store } from './storage/artifacts/index.js';",
        'export const s = new',
        '  Store(',
        '    root,',
        '  );',
        '',
      ].join('\n'),
    });
    try {
      const seeded = scanEvidenceStoreConstructions(root, {
        sourceDir: path.join(root, 'src'),
        owners: [],
      });
      expect(seeded.unowned.map((site) => [site.file, site.line, site.kind])).toEqual([
        ['src/seeded-alias.ts', 2, 'construct'],
      ]);
    } finally {
      await rmrfAsync(root);
    }
  });

  /** A namespace member and a subclass each build a store without the text `new ContentAddressedStore`. */
  it('Census_NamespaceImportAndSubclass_AreValueUsesToo', async () => {
    const root = await seededTree({
      'seeded-namespace.ts': [
        "import * as artifacts from './storage/artifacts/index.js';",
        'export const s = new artifacts.ContentAddressedStore(root);',
        '',
      ].join('\n'),
      'seeded-subclass.ts': [
        "import { ContentAddressedStore } from './storage/artifacts/content-addressed-store.js';",
        'export class EvidenceStore extends ContentAddressedStore {}',
        '',
      ].join('\n'),
    });
    try {
      const seeded = scanEvidenceStoreConstructions(root, {
        sourceDir: path.join(root, 'src'),
        owners: [],
      });
      expect(seeded.unowned.map((site) => [site.file, site.kind]).sort()).toEqual([
        ['src/seeded-namespace.ts', 'construct'],
        ['src/seeded-subclass.ts', 'reference'],
      ]);
    } finally {
      await rmrfAsync(root);
    }
  });

  /**
   * Each barrel imports the class and then exports the local name, plain or with
   * an alias. The caller of the aliased barrel names neither the class nor its
   * directory, so a text prefilter on either name skips that caller.
   */
  it('Census_ImportThenExportBarrel_AliasedOrNot_IsADoorToo', async () => {
    const root = await seededTree({
      'barrel-local.ts': [
        "import { ContentAddressedStore } from './storage/artifacts/content-addressed-store.js';",
        'export { ContentAddressedStore };',
        '',
      ].join('\n'),
      'barrel-alias.ts': [
        "import { ContentAddressedStore } from './storage/artifacts/index.js';",
        'export { ContentAddressedStore as Store };',
        '',
      ].join('\n'),
      'seeded-through-local.ts': [
        "import { ContentAddressedStore } from './barrel-local.js';",
        'export const s = new ContentAddressedStore(root);',
        '',
      ].join('\n'),
      'seeded-through-alias.ts': [
        "import { Store } from './barrel-alias.js';",
        'export const t = new Store(root);',
        '',
      ].join('\n'),
    });
    try {
      const seeded = scanEvidenceStoreConstructions(root, {
        sourceDir: path.join(root, 'src'),
        owners: [],
      });
      expect(seeded.unowned.map((site) => [site.file, site.kind]).sort()).toEqual([
        ['src/seeded-through-alias.ts', 'construct'],
        ['src/seeded-through-local.ts', 'construct'],
      ]);
    } finally {
      await rmrfAsync(root);
    }
  });

  const BARREL_CHAIN: Readonly<Record<string, string>> = {
    'b1.ts': "export * from './b2.js';\n",
    'b2.ts': "export * from './b1.js';\nexport * from './b3.js';\n",
    'b3.ts': "export * from './b4.js';\n",
    'b4.ts': "export { ContentAddressedStore } from './b5.js';\n",
    'b5.ts': "export { ContentAddressedStore } from './b6.js';\n",
    'b6.ts': "export { ContentAddressedStore } from './storage/artifacts/content-addressed-store.js';\n",
  };

  /**
   * `BARREL_CHAIN` has six hops, and two of them form a cycle. Each entry point
   * has its own tree and its own scan. In one shared tree, the shorter walk can
   * resolve `b3` first, and the longer walk then reuses that memoized answer.
   * Then a scanner with a depth bound still passes. The scanner does not sort
   * `readdirSync`, so the order of the two walks is not fixed.
   */
  it.each([
    { entry: 'b1.js', hops: 'six hops through the cycle' },
    { entry: 'b3.js', hops: 'four hops, past the cycle' },
  ])(
    'Census_LongBarrelChainThroughACycle_IsFollowedToTheClass ($hops)',
    async ({ entry }) => {
      const root = await seededTree({
        ...BARREL_CHAIN,
        'seeded-caller.ts': [
          `import { ContentAddressedStore } from './${entry}';`,
          'export const s = new ContentAddressedStore(root);',
          '',
        ].join('\n'),
      });
      try {
        const seeded = scanEvidenceStoreConstructions(root, {
          sourceDir: path.join(root, 'src'),
          owners: [],
        });
        expect(seeded.unowned.map((site) => [site.file, site.kind])).toEqual([
          ['src/seeded-caller.ts', 'construct'],
        ]);
      } finally {
        await rmrfAsync(root);
      }
    },
  );

  /**
   * The class name in a string, in a comment, or in a type annotation is not a
   * use. Each decoy module also binds the class as a value and constructs it one
   * time, because the scanner skips a module that binds nothing. That site
   * proves that the scanner read the module. It is the only site, which proves
   * that the scanner rejected the decoys.
   */
  it('Census_TextInStringsCommentsAndTypePositions_IsNotAUse', async () => {
    const root = await seededTree({
      'seeded-text.ts': [
        "import { ContentAddressedStore } from './storage/artifacts/content-addressed-store.js';",
        "export const decoy = 'new ContentAddressedStore(root)';",
        '// new ContentAddressedStore(root)',
        '/* new ContentAddressedStore(root) */',
        'export const s = new ContentAddressedStore(root);',
        '',
      ].join('\n'),
      'seeded-type-position.ts': [
        "import { ContentAddressedStore } from './storage/artifacts/content-addressed-store.js';",
        'export function bind(store: ContentAddressedStore): ContentAddressedStore {',
        '  return store;',
        '}',
        'export const s = new ContentAddressedStore(root);',
        '',
      ].join('\n'),
    });
    try {
      const seeded = scanEvidenceStoreConstructions(root, {
        sourceDir: path.join(root, 'src'),
        owners: [],
      });
      expect(seeded.scannedModuleCount).toBe(4);
      expect(seeded.sites.map((site) => [site.file, site.line, site.kind]).sort()).toEqual([
        ['src/seeded-text.ts', 5, 'construct'],
        ['src/seeded-type-position.ts', 5, 'construct'],
      ]);
    } finally {
      await rmrfAsync(root);
    }
  });

  /**
   * The only import is type-only, so the module binds no value and the scanner
   * skips the whole module. The test above covers type positions in a module
   * that binds the value.
   */
  it('Census_TypeOnlyImport_BindsNothingAtAll', async () => {
    const root = await seededTree({
      'seeded-type-only.ts': [
        "import type { ContentAddressedStore } from './storage/artifacts/content-addressed-store.js';",
        'export function bind(store: ContentAddressedStore): ContentAddressedStore {',
        '  return store;',
        '}',
        '',
      ].join('\n'),
    });
    try {
      const seeded = scanEvidenceStoreConstructions(root, {
        sourceDir: path.join(root, 'src'),
        owners: [],
      });
      expect(seeded.scannedModuleCount).toBe(3);
      expect(seeded.sites).toEqual([]);
    } finally {
      await rmrfAsync(root);
    }
  });

  /**
   * Two namespace forms that name neither the class at the use site nor its
   * directory at the import. `ns.Store` is the class with an alias inside a
   * namespace. `inner` is a namespace that a barrel re-exports and a named
   * import reaches. A scanner that resolves a namespace member against the
   * class name sees neither.
   */
  it('Census_NamespaceReExportedAndAliased_IsADoorToo', async () => {
    const root = await seededTree({
      'alias-barrel.ts': [
        "export { ContentAddressedStore as Store } from './storage/artifacts/content-addressed-store.js';",
        '',
      ].join('\n'),
      'namespace-barrel.ts': [
        "export * as inner from './storage/artifacts/index.js';",
        '',
      ].join('\n'),
      'seeded-namespace-alias.ts': [
        "import * as ns from './alias-barrel.js';",
        'export const s = new ns.Store(root);',
        '',
      ].join('\n'),
      'seeded-namespace-through-named.ts': [
        "import { inner } from './namespace-barrel.js';",
        'export const t = new inner.ContentAddressedStore(root);',
        '',
      ].join('\n'),
    });
    try {
      const seeded = scanEvidenceStoreConstructions(root, {
        sourceDir: path.join(root, 'src'),
        owners: [],
      });
      expect(seeded.unowned.map((site) => [site.file, site.kind]).sort()).toEqual([
        ['src/seeded-namespace-alias.ts', 'construct'],
        ['src/seeded-namespace-through-named.ts', 'construct'],
      ]);
    } finally {
      await rmrfAsync(root);
    }
  });
});
