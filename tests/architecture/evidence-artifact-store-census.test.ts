/**
 * One root for evidence artifacts, kept by a census rather than a comment.
 *
 * A `ContentAddressedStore` reference carries a digest and no root, so a
 * producer and a reader that construct the store two different ways are
 * indistinguishable, from the reference's own point of view, from a blob that
 * was never written — the two gate-evidence producers used to disagree on
 * the root this way, and this pass gave them one shared constructor. This
 * walks the shipped tree with the TypeScript parser for every value-level
 * use of `ContentAddressedStore` — resolved through the import graph, so an
 * alias or a barrel is the same class — and requires each one to be a named,
 * reasoned-about owner.
 *
 * The vacuity guard: a scan that stopped finding construction sites at all
 * would report zero violations and read as a clean tree. The scanned
 * population is corroborated against `git ls-files`, the site count is
 * asserted non-empty against a measured floor, and the seeded-module case
 * proves the walk actually reaches and names a real file on disk rather than
 * a row spliced into a value the test already controls.
 */

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanEvidenceStoreConstructions } from '../../tools/test-helpers/evidence-store-construction-census.js';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_DIR = path.join(REPO_ROOT, 'src');

/**
 * Every module allowed to construct a `ContentAddressedStore` directly, and
 * why. Anything else that constructs one is a second, disagreeing root.
 */
const OWNERS: readonly string[] = [
  // The sanctioned evidence-artifact constructor every admission producer
  // and reader binds through.
  'src/workflow/admission/evidence-artifact.ts',
  // A different subject entirely — run bundles, not admission evidence —
  // already root-owned by its own directory-name constant.
  'src/events/bundle/run-bundle-store.ts',
  // A throwaway `mkdtemp` root inside a self-contained witness. It reads and
  // writes nothing a durable-evidence check ever consults, so it names no
  // custody this census protects.
  'src/verbs/gates/gate-ownership-census.ts',
];

describe('EvidenceStoreConstructionCensus — one root for evidence artifacts', () => {
  it('Census_ScannedPopulation_IsNotVacuous', () => {
    const census = scanEvidenceStoreConstructions(REPO_ROOT, {
      sourceDir: SOURCE_DIR,
      owners: OWNERS,
    });
    expect(census.scannedModuleCount).toBeGreaterThan(300);

    const tracked = listTrackedFiles(REPO_ROOT, {
      exclude: (file) => !file.startsWith('src/') || file.endsWith('.test.ts'),
    });
    expect(tracked.length).toBeGreaterThan(0);
    // Second authority: a scanner that lost most of the tree would still
    // report a plausible-looking count on its own. Agreement with `git
    // ls-files` is what rules that out.
    expect(census.scannedModuleCount).toBe(tracked.length);
  }, 60_000);

  it('Census_EveryProductionConstruction_IsOwned', () => {
    const census = scanEvidenceStoreConstructions(REPO_ROOT, {
      sourceDir: SOURCE_DIR,
      owners: OWNERS,
    });
    // Denominator, asserted non-empty: a walk that found zero construction
    // sites at all would pass the next assertion vacuously. The three owners
    // above each construct the store at least once — the measured floor.
    expect(census.sites.length).toBeGreaterThanOrEqual(4);
    expect(
      census.unowned,
      'every construction outside the allowlist must bind through evidenceArtifactStore() instead',
    ).toEqual([]);
  }, 60_000);

  it('Census_BothEvidenceProducers_BindToTheRootConstant', () => {
    // The half a construction-site scan cannot see on its own: a producer
    // could call the shared helper AND still carry a stray literal root
    // somewhere else in the same file. Read the source directly.
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

  /**
   * A throwaway tree shaped like the real one: the class module at the path
   * the scanner resolves bindings against, a barrel re-exporting it, and one
   * seeded module per case. Returns the root; the caller removes it.
   */
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
      // The class module and the barrel are walked too; neither USES the class.
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
      await rm(root, { recursive: true });
    }
  });

  it('Census_AliasedImportThroughTheBarrel_SplitAcrossLines_IsStillAConstruction', async () => {
    // The three shapes a line pattern cannot see: the class under another
    // local name, reached through the barrel rather than its own module, and
    // a `new` whose parts sit on different lines.
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
      await rm(root, { recursive: true });
    }
  });

  it('Census_NamespaceImportAndSubclass_AreValueUsesToo', async () => {
    // A store can be built without ever spelling `new ContentAddressedStore`:
    // through a namespace member, or by subclassing. Both are doors.
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
      await rm(root, { recursive: true });
    }
  });

  it('Census_TextInStringsCommentsAndTypePositions_IsNotAUse', async () => {
    // The false positives a line pattern produces and the compiler does not:
    // the class name inside a string, inside a comment, and in a type-only
    // import used purely as an annotation. None of these can construct.
    const root = await seededTree({
      'seeded-text.ts': [
        "export const s = 'new ContentAddressedStore(root)';",
        '// new ContentAddressedStore(root)',
        '/* new ContentAddressedStore(root) */',
        '',
      ].join('\n'),
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
      expect(seeded.scannedModuleCount).toBe(4);
      expect(seeded.sites).toEqual([]);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
