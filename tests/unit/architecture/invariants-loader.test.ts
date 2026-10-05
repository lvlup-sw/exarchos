import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCoreInvariants,
  loadInvariants,
  loadInvariantIds,
  parseInvariantEntries,
  type InvariantEntry,
} from '../../../src/architecture/invariants-loader.js';
import { resolveCatalogSources } from '../../../src/architecture/catalog-sources.js';
import { scanFile } from '../../../src/architecture/vocabulary-lint.js';
import type { ExarchosConfigInput } from '../../../src/config/exarchos-config-schema.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');

/** Entry ids that the live catalog must hold. */
const REQUIRED_INVARIANT_IDS = [
  'INV-1',
  'INV-2',
  'INV-3',
  'INV-4',
  'INV-5a',
  'INV-5b',
  'INV-5c',
  'INV-5d',
  'INV-6',
  'INV-7',
  'INV-8',
  'INV-12',
  'INV-9',
  'INV-10',
  'INV-11',
  'INV-13',
  'INV-14',
  'INV-15',
] as const;

/** The exact entry count of the live catalog. */
const EXPECTED_CATALOG_SIZE = 21;

/**
 * Builds a config that registers each given catalog path for the `dev` tier.
 * The loader returns no entries for a file that the config does not register.
 * Most tests inject this config, so they do not depend on the `.exarchos.yml` of the repository.
 */
function registeredConfig(
  ...catalogPaths: string[]
): ExarchosConfigInput {
  return {
    invariants: {
      catalogs: catalogPaths.map((p) => ({ path: p, tier: 'dev' as const })),
    },
  };
}

const ENABLED_CONFIG = registeredConfig(INVARIANTS_DOC);

describe('invariants-loader', () => {
  it('Invariants_StructuredFrontmatter_ParsesAllRequiredFields', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    expect(entries.length).toBeGreaterThan(0);

    const ids = entries.map((e) => e.id);

    for (const id of REQUIRED_INVARIANT_IDS) {
      expect(ids).toContain(id);
    }

    expect(ids.filter((id) => id.startsWith('DIM-'))).toEqual([]);

    expect(ids).toContain('basileus-boundary');

    for (const entry of entries) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.dimension).toBe('string');
      expect(Array.isArray(entry.appliesTo)).toBe(true);
      expect(entry.appliesTo.length).toBeGreaterThan(0);
      expect(typeof entry.summary).toBe('string');
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.references)).toBe(true);
      expect(entry.references.length).toBeGreaterThan(0);
    }
  });

  /** One reference of the input-ergonomics entry must hold the id of that entry in its path. */
  it('Invariants_TypedEntries_HaveStableShape', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv5a = entries.find((e: InvariantEntry) => e.id === 'INV-5a');
    expect(inv5a).toBeDefined();
    expect(inv5a!.dimension.toLowerCase()).toContain('input');
    const hasInv5aRef = inv5a!.references.some((r) => r.includes('INV-5a'));
    expect(hasInv5aRef).toBe(true);
  });

  /** A change that deletes a required entry must also update `REQUIRED_INVARIANT_IDS`. */
  it('Invariants_AfterAudit_AllRequiredIdsStillPresentOrExplicitlyMigrated', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const ids = new Set(entries.map((e) => e.id));
    for (const id of REQUIRED_INVARIANT_IDS) {
      expect(ids.has(id), `required invariant missing: ${id}`).toBe(true);
    }
    for (const id of entries.map((e) => e.id)) {
      expect(id.startsWith('DIM-'), `unexpected DIM-* entry: ${id}`).toBe(false);
    }
  });

  /** The count is exact, so a change that adds or deletes an entry must update `EXPECTED_CATALOG_SIZE`. */
  it('LoadInvariants_NoDimEntries_CatalogHas21', () => {
    const entries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
    expect(entries.length).toBe(EXPECTED_CATALOG_SIZE);
    expect(entries.filter((e) => e.id.startsWith('DIM-'))).toEqual([]);
  });

  /** No live entry declares `axiom_overlap` in its raw frontmatter, and no typed entry has an `axiomOverlap` property. */
  it('LoadInvariants_NoAxiomOverlapField_Parsed', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    for (const entry of entries) {
      expect(
        (entry as Record<string, unknown>).axiomOverlap,
        `entry ${entry.id} still carries an axiomOverlap accessor`,
      ).toBeUndefined();
    }
    for (const entry of entries) {
      expect(
        entry.raw.axiom_overlap,
        `entry ${entry.id} still carries a raw axiom_overlap field`,
      ).toBeUndefined();
    }
  });

  it('Invariants_AfterAudit_EveryKeptEntryHasAtLeastTwoReferencesInFrontmatter', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    for (const entry of entries) {
      expect(
        entry.references.length,
        `entry ${entry.id} has only ${entry.references.length} references; need >= 2`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  /** A `basileus/` path names a sibling repository, so it does not resolve in this repository. */
  it('Invariants_BasileusBoundaryReferences_DoNotPointToSiblingRepoPaths', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const bb = entries.find((e) => e.id === 'basileus-boundary');
    expect(bb).toBeDefined();
    for (const ref of bb!.references) {
      expect(
        ref.startsWith('basileus/'),
        `basileus-boundary references must not point at sibling-repo path: ${ref}`,
      ).toBe(false);
    }
  });

  /**
   * This test checks four core ids only. `LoadInvariants_WithScopeCore_ReturnsSubstrateAndAlwaysLoad` pins the exact set.
   * The default scope must return the same entries as `all`.
   */
  it('LoadInvariants_WithScopeCore_ReturnsOnlyAlwaysLoadEntries', () => {
    const coreEntries = loadInvariants(INVARIANTS_DOC, { scope: 'core' }, ENABLED_CONFIG);
    const coreIds = new Set(coreEntries.map((e) => e.id));
    expect(coreIds.has('INV-1')).toBe(true);
    expect(coreIds.has('INV-2')).toBe(true);
    expect(coreIds.has('INV-5a')).toBe(true);
    expect(coreIds.has('INV-5b')).toBe(true);

    const allEntries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
    const defaultEntries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    expect(allEntries.length).toBeGreaterThanOrEqual(18);
    expect(defaultEntries.length).toBe(allEntries.length);
    expect(defaultEntries.map((e) => e.id)).toEqual(allEntries.map((e) => e.id));
  });

  /**
   * A missing `cost-of-load` field is a parse error.
   * This test checks that each live entry has one of the three values.
   */
  it('Invariants_EveryEntry_HasCostOfLoadField', () => {
    const validValues = new Set(['always-load', 'reference-only', 'archivable']);
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    for (const entry of entries) {
      expect(
        validValues.has(entry.costOfLoad),
        `entry ${entry.id} has invalid costOfLoad: ${String(entry.costOfLoad)}`,
      ).toBe(true);
    }
  });

  /** The error must name the unknown scope and list the valid scopes. The loader must not fall back to `all`. */
  it('LoadInvariants_WithUnknownScope_ThrowsLoudly', () => {
    expect(() =>
      loadInvariants(
        INVARIANTS_DOC,
        { scope: 'invalid-scope' as unknown as 'core' },
        ENABLED_CONFIG,
      ),
    ).toThrow(/invalid-scope/);
    expect(() =>
      loadInvariants(
        INVARIANTS_DOC,
        { scope: 'invalid-scope' as unknown as 'core' },
        ENABLED_CONFIG,
      ),
    ).toThrow(/core/);
    expect(() =>
      loadInvariants(
        INVARIANTS_DOC,
        { scope: 'invalid-scope' as unknown as 'core' },
        ENABLED_CONFIG,
      ),
    ).toThrow(/all/);
  });

  /** `loadCoreInvariants` must return the same ids as `loadInvariants` with the `core` scope. */
  it('LoadCoreInvariants_ReturnsOnlyAlwaysLoadEntries', () => {
    const coreEntries = loadCoreInvariants(INVARIANTS_DOC, ENABLED_CONFIG);
    const coreIds = new Set(coreEntries.map((e) => e.id));
    expect(coreIds.has('INV-1')).toBe(true);
    expect(coreIds.has('INV-2')).toBe(true);
    expect(coreIds.has('INV-5a')).toBe(true);
    expect(coreIds.has('INV-5b')).toBe(true);
    const explicit = loadInvariants(INVARIANTS_DOC, { scope: 'core' }, ENABLED_CONFIG);
    expect(coreEntries.map((e) => e.id)).toEqual(explicit.map((e) => e.id));
  });

  /**
   * A config with a registration and no `devCatalog` key loads the catalog.
   * `resolveCatalogSources` is the second authority: it names the same file as a source.
   * When the config registers a different file, the loader returns no entries for this catalog.
   */
  it('InvariantsLoader_NoDevCatalogFlag_ResolvesViaCatalogSources', () => {
    const registered: ExarchosConfigInput = {
      invariants: {
        catalogs: [{ path: INVARIANTS_DOC, tier: 'dev' }],
      },
    };
    expect(
      JSON.stringify(registered),
      'this test is about the ABSENCE of the flag; a devCatalog key here ' +
        'would make it silently re-test the retired gate',
    ).not.toContain('devCatalog');

    const entries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, registered);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.id)).toContain('INV-1');

    const discovered = resolveCatalogSources(registered);
    expect(discovered).toEqual([{ path: INVARIANTS_DOC, tier: 'dev' }]);

    const elsewhere: ExarchosConfigInput = {
      invariants: {
        catalogs: [
          { path: path.join(REPO_ROOT, '.exarchos/some-other-catalog.md'), tier: 'dev' },
        ],
      },
    };
    expect(resolveCatalogSources(elsewhere).map((s) => s.path)).not.toContain(
      INVARIANTS_DOC,
    );
    expect(loadInvariants(INVARIANTS_DOC, { scope: 'all' }, elsewhere)).toEqual([]);
  });

  /**
   * A catalog that no registration names loads no entries. A loader with no registration check fails this test.
   * The cases are an empty config, an empty `invariants` block, a different registered file, and `devCatalog` alone.
   * The registration check runs before the scope filter, so the `core` scope is also empty.
   */
  it('LoadInvariants_WhenCatalogNotRegistered_ReturnsEmpty', () => {
    expect(loadInvariants(INVARIANTS_DOC, { scope: 'all' }, {})).toEqual([]);
    expect(
      loadInvariants(INVARIANTS_DOC, { scope: 'all' }, { invariants: {} }),
    ).toEqual([]);
    expect(
      loadInvariants(INVARIANTS_DOC, { scope: 'all' }, {
        invariants: { catalogs: [{ path: 'somewhere/else.md', tier: 'dev' }] },
      }),
    ).toEqual([]);
    expect(
      loadInvariants(INVARIANTS_DOC, { scope: 'all' }, {
        invariants: { devCatalog: 'enabled' },
      }),
    ).toEqual([]);

    expect(loadInvariants(INVARIANTS_DOC, { scope: 'core' }, {})).toEqual([]);
  });

  /**
   * A registered catalog loads the same entries when `devCatalog` is absent, `enabled` or `disabled`.
   * The shared result has a floor of 18 ids, because a loader that returns nothing also satisfies the equalities.
   * The three configs must differ, or the equalities prove nothing.
   */
  it('LoadInvariants_WhenRegistered_DevCatalogBooleanIsInert', () => {
    const base = [{ path: INVARIANTS_DOC, tier: 'dev' as const }];
    const absent: ExarchosConfigInput = { invariants: { catalogs: base } };
    const enabled: ExarchosConfigInput = {
      invariants: { devCatalog: 'enabled', catalogs: base },
    };
    const disabled: ExarchosConfigInput = {
      invariants: { devCatalog: 'disabled', catalogs: base },
    };
    expect(absent).not.toEqual(enabled);
    expect(enabled).not.toEqual(disabled);

    const ids = (config: ExarchosConfigInput): string[] =>
      loadInvariants(INVARIANTS_DOC, { scope: 'all' }, config).map((e) => e.id);

    expect(ids(absent).length).toBeGreaterThanOrEqual(18);
    expect(ids(enabled)).toEqual(ids(absent));
    expect(ids(disabled)).toEqual(ids(absent));

    const coreIds = loadInvariants(INVARIANTS_DOC, { scope: 'core' }, disabled).map(
      (e) => e.id,
    );
    expect(coreIds).toContain('INV-1');
  });

  /**
   * A relative registration resolves against `configRoot`.
   * Without `configRoot`, it matches a segment-aligned path suffix.
   * A wrong `configRoot` gives no match.
   * The registration `exarchos/invariants.md` is a character suffix of the target but not a segment suffix.
   * Thus it matches in neither mode.
   */
  it('LoadInvariants_RelativeRegistration_MatchesOnWholeSegmentsOnly', () => {
    const relative: ExarchosConfigInput = {
      invariants: { catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }] },
    };
    expect(
      loadInvariants(INVARIANTS_DOC, { scope: 'all', configRoot: REPO_ROOT }, relative)
        .length,
    ).toBeGreaterThan(0);
    expect(
      loadInvariants(INVARIANTS_DOC, { scope: 'all' }, relative).length,
    ).toBeGreaterThan(0);
    expect(
      loadInvariants(
        INVARIANTS_DOC,
        { scope: 'all', configRoot: path.join(REPO_ROOT, 'scripts') },
        relative,
      ),
    ).toEqual([]);
    const nearMiss: ExarchosConfigInput = {
      invariants: { catalogs: [{ path: 'exarchos/invariants.md', tier: 'dev' }] },
    };
    expect(loadInvariants(INVARIANTS_DOC, { scope: 'all' }, nearMiss)).toEqual([]);
    expect(
      loadInvariants(INVARIANTS_DOC, { scope: 'all', configRoot: REPO_ROOT }, nearMiss),
    ).toEqual([]);
  });

  /**
   * `vocabulary-lint.ts` gets the catalog ids from `loadInvariantIds`, with no injected config.
   * That call must resolve the catalog through the real `.exarchos.yml`.
   * It must return the same ids as the injected registration.
   * `scanFile` must then accept a known id and report an unknown id.
   */
  it('VocabularyLint_UnchangedFile_ResolvesSameIdSetThroughLoadInvariants', () => {
    const viaDisk = loadInvariantIds(INVARIANTS_DOC);
    const viaInjected = new Set(
      loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG).map(
        (e) => e.id,
      ),
    );
    expect(viaDisk.size).toBeGreaterThan(0);
    expect([...viaDisk].sort()).toEqual([...viaInjected].sort());

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-lint-dr31-'));
    try {
      const doc = path.join(tmpDir, 'note.md');
      fs.writeFileSync(doc, 'Refers to INV-1 and to INV-999.\n', 'utf8');
      const findings = scanFile(doc);
      const tokens = findings.map((f) => f.token);
      expect(tokens).toContain('INV-999');
      expect(tokens).not.toContain('INV-1');
    } finally {
      rmrf(tmpDir);
    }
  });

  /** `parseInvariantEntries` is a pure projection. It does no file I/O, registration check or scope filter. */
  it('parseInvariantEntries_rawEntries_projectsTypedShapeWithV3Fields', () => {
    const raw = [
      {
        id: 'SDLC-1',
        dimension: 'phase-observability',
        axis: 'substrate',
        'cost-of-load': 'always-load',
        'integrity-class': 'sdlc',
        'applies-to': ['workflow-lifecycle'],
        summary: 'Long-running ops are queryable.',
        references: ['docs/guides/authoring-invariants.md'],
        'workflow-affinity': ['feature', 'oneshot'],
        enforcement: { mode: 'audit', 'audit-prompt': 'Is every op queryable?' },
      },
    ];
    const entries = parseInvariantEntries(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('SDLC-1');
    expect(entries[0].integrityClass).toBe('sdlc');
    expect(entries[0].workflowAffinity).toEqual(['feature', 'oneshot']);
    expect(entries[0].enforcement?.mode).toBe('audit');
  });

  it('parseInvariantEntries_duplicateIds_throws', () => {
    const dup = [
      { id: 'SDLC-1', dimension: 'a', axis: 'substrate', 'cost-of-load': 'always-load', 'applies-to': ['x'], summary: 's', references: ['r'] },
      { id: 'SDLC-1', dimension: 'b', axis: 'substrate', 'cost-of-load': 'always-load', 'applies-to': ['x'], summary: 's', references: ['r'] },
    ];
    expect(() => parseInvariantEntries(dup)).toThrow(/Duplicate invariant ID: SDLC-1/);
  });

  /** A `null` or primitive element must fail with an error that names its index, not with a generic `TypeError`. */
  it('parseInvariantEntries_nonObjectEntry_throwsIndexNamedError', () => {
    const bad = [
      { id: 'SDLC-1', dimension: 'a', axis: 'substrate', 'cost-of-load': 'always-load', 'applies-to': ['x'], summary: 's', references: ['r'] },
      null,
    ];
    expect(() => parseInvariantEntries(bad)).toThrow(/entry at index 1 must be an object/);
    expect(() => parseInvariantEntries(['just-a-string'])).toThrow(/entry at index 0 must be an object/);
  });

  /**
   * The live catalog declares `schema-version: 3`.
   * Each loaded entry has a typed `axis` of `substrate` or `authoring`.
   */
  it('Invariants_AfterSchemaV3Bump_EveryEntryHasAxisField', () => {
    const source = fs.readFileSync(INVARIANTS_DOC, 'utf8');
    const frontmatterMatch = source.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch, 'invariants.md must have YAML frontmatter').not.toBeNull();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/^schema-version:\s*3\b/m);

    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        entry.axis === 'substrate' || entry.axis === 'authoring',
        `entry ${entry.id} has invalid axis: ${String(entry.axis)}`,
      ).toBe(true);
    }
  });

  /** A missing `axis` gets no default. The error must name the entry id and the field. */
  it('Invariants_AxisFieldMissing_ThrowsLoudlyWithEntryId', () => {
    const fixture = `---
schema-version: 2
invariants:
  - id: INV-MISSING-AXIS
    dimension: test-missing-axis
    cost-of-load: always-load
    applies-to:
      - test
    summary: This entry intentionally omits the axis field.
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-axis-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    try {
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(
        /INV-MISSING-AXIS/,
      );
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(/axis/);
    } finally {
      rmrf(tmpDir);
    }
  });

  /**
   * Each substrate-axis entry must hold at least three citations, except the two entries in `CITATION_EXEMPT`.
   * The action-discriminator entry is a reference-only sub-discipline, and its parent entries hold the grounding.
   * `basileus-boundary` takes its grounding from its references.
   */
  it('Invariants_EverySubstrateAxisEntry_HasAtLeastThreeCitations', () => {
    const CITATION_EXEMPT = new Set(['INV-5d', 'basileus-boundary']);
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const substrate = entries.filter(
      (e) => e.axis === 'substrate' && !CITATION_EXEMPT.has(e.id),
    );
    expect(substrate.length).toBeGreaterThan(0);
    for (const entry of substrate) {
      expect(
        entry.citations?.length ?? 0,
        `entry ${entry.id} has ${entry.citations?.length ?? 0} citations; substrate-axis entries need >= 3`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  /** The loader must project a declared `citations` list onto the typed entry. */
  it('Invariants_SubstrateAxisEntries_AcceptCitationsField', () => {
    const fixture = `---
schema-version: 2
invariants:
  - id: INV-TEST-CITATIONS
    dimension: test-citations
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - test
    summary: Entry with citations field.
    citations:
      - "Author, *Title* (Year): https://example.com/a"
      - "Author B, *Title B* (Year): https://example.com/b"
      - "Author C, *Title C* (Year): https://example.com/c"
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-citations-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    try {
      const entries = loadInvariants(tmpFile, undefined, registeredConfig(tmpFile));
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      expect(entry.citations).toBeDefined();
      expect(Array.isArray(entry.citations)).toBe(true);
      expect(entry.citations).toHaveLength(3);
      expect(entry.citations![0]).toMatch(/Author/);
    } finally {
      rmrf(tmpDir);
    }
  });

  /**
   * An absent `citations` field parses to `undefined` and not to `[]`, so "not declared" differs from "declared empty".
   * `basileus-boundary` declares no citations.
   */
  it('Invariants_OmittingCitationsField_ParsesWithUndefinedCitations', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const noCitations = entries.find((e) => e.id === 'basileus-boundary');
    expect(noCitations).toBeDefined();
    expect(noCitations!.citations).toBeUndefined();
  });

  /**
   * The loader has no parse path for the `axiom_overlap` key.
   * An entry that declares it loads, and the typed entry has no `axiomOverlap` property.
   */
  it('Invariants_AxiomOverlapField_ParsesButIsNotSurfaced', () => {
    const fixture = `---
schema-version: 2
invariants:
  - id: INV-LEGACY-OVERLAP
    dimension: test-legacy-overlap
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - test
    summary: Entry that still declares the retired axiom_overlap key.
    axiom_overlap: DIM-1
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-legacy-overlap-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    try {
      const entries = loadInvariants(tmpFile, undefined, registeredConfig(tmpFile));
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      expect((entry as Record<string, unknown>).axiomOverlap).toBeUndefined();
    } finally {
      rmrf(tmpDir);
    }
  });

  /**
   * The summary of the event-sourcing entry must not name idempotency or serialization concerns.
   * `substrate-serialization` and `idempotency-at-the-boundary` are separate always-load entries with citations.
   */
  it('Invariants_INV1Split_ProducesINV1NarrowedPlusINV7PlusINV8', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const byId = new Map(entries.map((e) => [e.id, e] as const));

    const inv1 = byId.get('INV-1');
    expect(inv1).toBeDefined();
    expect(inv1!.summary.toLowerCase()).not.toMatch(/idempotency/);
    expect(inv1!.summary.toLowerCase()).not.toMatch(/streamlockmanager/);
    expect(inv1!.summary.toLowerCase()).not.toMatch(/occ\b/);
    expect(inv1!.summary.toLowerCase()).not.toMatch(/sqlite/);

    const inv7 = byId.get('INV-7');
    expect(inv7, 'INV-7 must exist post-split').toBeDefined();
    expect(inv7!.dimension).toBe('substrate-serialization');
    expect(inv7!.axis).toBe('substrate');
    expect(inv7!.costOfLoad).toBe('always-load');
    expect(inv7!.citations).toBeDefined();
    expect(inv7!.citations!.length).toBeGreaterThanOrEqual(3);
    expect(inv7!.citations!.join(' ')).toMatch(/ARIES/i);
    expect(inv7!.citations!.join(' ')).toMatch(/Bernstein/i);

    const inv8 = byId.get('INV-8');
    expect(inv8, 'INV-8 must exist post-split').toBeDefined();
    expect(inv8!.dimension).toBe('idempotency-at-the-boundary');
    expect(inv8!.axis).toBe('substrate');
    expect(inv8!.costOfLoad).toBe('always-load');
    expect(inv8!.citations).toBeDefined();
    expect(inv8!.citations!.length).toBeGreaterThanOrEqual(3);
    expect(inv8!.citations!.join(' ')).toMatch(/Akka/i);
    expect(inv8!.citations!.join(' ')).toMatch(/Wolverine/i);
    expect(inv8!.citations!.join(' ')).toMatch(/Greg Young/i);
  });

  /**
   * The affordance reading of `next_actions` is a separate always-load entry, `next-actions-as-affordance`.
   * Its citations must name Norman and McGrenere.
   */
  it('Invariants_INV5bSplit_ProducesINV5bNarrowedPlusINV12', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const byId = new Map(entries.map((e) => [e.id, e] as const));

    const inv5b = byId.get('INV-5b');
    expect(inv5b).toBeDefined();
    expect(inv5b!.dimension).toBe('output-contract');

    const inv12 = byId.get('INV-12');
    expect(inv12, 'INV-12 must exist post-split').toBeDefined();
    expect(inv12!.dimension).toBe('next-actions-as-affordance');
    expect(inv12!.axis).toBe('substrate');
    expect(inv12!.costOfLoad).toBe('always-load');
    expect(inv12!.citations).toBeDefined();
    expect(inv12!.citations!.length).toBeGreaterThanOrEqual(3);
    expect(inv12!.citations!.join(' ')).toMatch(/Norman/i);
    expect(inv12!.citations!.join(' ')).toMatch(/McGrenere/i);
  });

  it('Invariants_INV9_ExistsWithHSMScope', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv9 = entries.find((e) => e.id === 'INV-9');
    expect(inv9, 'INV-9 must exist in v2 catalog').toBeDefined();
    expect(inv9!.dimension).toBe('hsm-as-state-machine');
    expect(inv9!.axis).toBe('substrate');
    expect(inv9!.costOfLoad).toBe('reference-only');
    expect(inv9!.citations).toBeDefined();
    expect(inv9!.citations!.length).toBeGreaterThanOrEqual(3);
    expect(inv9!.citations!.join(' ')).toMatch(/Harel/i);
  });

  it('Invariants_INV10_ExistsWithLivenessProtocolScope', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv10 = entries.find((e) => e.id === 'INV-10');
    expect(inv10, 'INV-10 must exist in v2 catalog').toBeDefined();
    expect(inv10!.dimension).toBe('liveness-event-protocol');
    expect(inv10!.axis).toBe('substrate');
    expect(inv10!.costOfLoad).toBe('reference-only');
    expect(inv10!.citations).toBeDefined();
    expect(inv10!.citations!.length).toBeGreaterThanOrEqual(3);
  });

  it('Invariants_INV11_ExistsWithPostureScope', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv11 = entries.find((e) => e.id === 'INV-11');
    expect(inv11, 'INV-11 must exist in v2 catalog').toBeDefined();
    expect(inv11!.dimension).toBe('posture-declared-capabilities');
    expect(inv11!.axis).toBe('substrate');
    expect(inv11!.costOfLoad).toBe('always-load');
    expect(inv11!.citations).toBeDefined();
    expect(inv11!.citations!.length).toBeGreaterThanOrEqual(4);
    expect(inv11!.citations!.join(' ')).toMatch(/Miller/i);
    expect(inv11!.citations!.join(' ')).toMatch(/POLA/i);
    expect(inv11!.citations!.join(' ')).toMatch(/anip-protocol/i);
  });

  it('Invariants_INV13_ExistsWithProcessManagerScope', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv13 = entries.find((e) => e.id === 'INV-13');
    expect(inv13, 'INV-13 must exist in v2 catalog').toBeDefined();
    expect(inv13!.dimension).toBe('process-manager-two-event-split');
    expect(inv13!.axis).toBe('substrate');
    expect(inv13!.costOfLoad).toBe('reference-only');
    expect(inv13!.citations).toBeDefined();
    expect(inv13!.citations!.length).toBeGreaterThanOrEqual(3);
    expect(inv13!.citations!.join(' ')).toMatch(/Akka/i);
    expect(inv13!.citations!.join(' ')).toMatch(/Wolverine/i);
    expect(inv13!.citations!.join(' ')).toMatch(/Greg Young/i);
  });

  it('Invariants_INV14_ExistsWithRecoveryPostureScope', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv14 = entries.find((e) => e.id === 'INV-14');
    expect(inv14, 'INV-14 must exist in v2 catalog').toBeDefined();
    expect(inv14!.dimension).toBe('native-primitive-first-recovery');
    expect(inv14!.axis).toBe('substrate');
    expect(inv14!.costOfLoad).toBe('reference-only');
    expect(inv14!.citations).toBeDefined();
    expect(inv14!.citations!.length).toBeGreaterThanOrEqual(3);
  });

  /** The Scheduler-Agent-Supervisor and Saga citations are negative references: the entry rejects both patterns. */
  it('Invariants_INV15_ExistsWithSingleMachineFrameScope', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv15 = entries.find((e) => e.id === 'INV-15');
    expect(inv15, 'INV-15 must exist in v2 catalog').toBeDefined();
    expect(inv15!.dimension).toBe('single-machine-frame');
    expect(inv15!.axis).toBe('substrate');
    expect(inv15!.costOfLoad).toBe('always-load');
    expect(inv15!.citations).toBeDefined();
    expect(inv15!.citations!.length).toBeGreaterThanOrEqual(3);
    expect(inv15!.citations!.join(' ')).toMatch(/Scheduler[- ]Agent[- ]Supervisor/i);
    expect(inv15!.citations!.join(' ')).toMatch(/Saga/i);
    expect(inv15!.citations!.join(' ')).toMatch(/Clemens Vasters/i);
  });

  /**
   * The workload-agnosticism entry is always-load.
   * Its summary must state the primary rule and name its lint script.
   */
  it('Invariants_INV6Sharpened_PrimaryStatementNotGrepOnly', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv6 = entries.find((e) => e.id === 'INV-6');
    expect(inv6, 'INV-6 must exist').toBeDefined();
    expect(inv6!.costOfLoad).toBe('always-load');
    expect(inv6!.summary.toLowerCase()).toMatch(/no assumption about which workload/);
    expect(inv6!.summary).toMatch(/tools\/audit\/gates\/lint-inv6\.mjs/);
    expect(inv6!.appliesTo).toContain('runtime-substrate');
    expect(inv6!.appliesTo).toContain('topology');
    expect(inv6!.citations).toBeDefined();
    expect(inv6!.citations!.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The `core` scope keeps an entry only when its axis is `substrate` and its `cost-of-load` is `always-load`.
   * The live catalog has ten such entries.
   */
  it('LoadInvariants_WithScopeCore_ReturnsSubstrateAndAlwaysLoad', () => {
    const core = loadInvariants(INVARIANTS_DOC, { scope: 'core' }, ENABLED_CONFIG);
    const ids = new Set(core.map((e) => e.id));
    const expected = new Set([
      'INV-1',
      'INV-2',
      'INV-5a',
      'INV-5b',
      'INV-6',
      'INV-7',
      'INV-8',
      'INV-11',
      'INV-12',
      'INV-15',
    ]);
    expect(core.length).toBe(expected.size);
    for (const id of expected) {
      expect(ids.has(id), `core scope missing ${id}`).toBe(true);
    }
    for (const entry of core) {
      expect(entry.axis).toBe('substrate');
      expect(entry.costOfLoad).toBe('always-load');
    }
  });

  /** Each live entry is on the substrate axis, so the `substrate` scope returns the full catalog. */
  it('LoadInvariants_WithScopeSubstrate_ReturnsAllSubstrateAxisEntries', () => {
    const substrate = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'substrate' as 'core' },
      ENABLED_CONFIG,
    );
    expect(substrate.length).toBe(EXPECTED_CATALOG_SIZE);
    for (const entry of substrate) {
      expect(entry.axis).toBe('substrate');
    }
    expect(substrate.filter((e) => e.id.startsWith('DIM-'))).toEqual([]);
  });

  /** The live catalog has no authoring-axis entry, so the `authoring` scope is empty. */
  it('LoadInvariants_WithScopeAuthoring_ReturnsAuthoringAxisOnly', () => {
    const authoring = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'authoring' as 'core' },
      ENABLED_CONFIG,
    );
    expect(authoring).toEqual([]);
  });

  /** The default scope must return the same ids as `all`. */
  it('LoadInvariants_WithScopeAll_ReturnsFullCatalog', () => {
    const all = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
    expect(all.length).toBe(EXPECTED_CATALOG_SIZE);
    const def = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    expect(def.map((e) => e.id)).toEqual(all.map((e) => e.id));
  });

  /** Each entry declares exactly one axis, so the `substrate` and `authoring` scopes partition the catalog. */
  it('LoadInvariants_ScopeSubstratePlusAuthoring_EqualsAll', () => {
    const all = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
    const substrate = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'substrate' as 'core' },
      ENABLED_CONFIG,
    );
    const authoring = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'authoring' as 'core' },
      ENABLED_CONFIG,
    );
    expect(substrate.length + authoring.length).toBe(all.length);
  });

  /**
   * An entry with no `axis` field gets no default.
   * The error names the entry id, the field, `schema-version: 2` and the allowed values.
   */
  it('LoadInvariants_V1FixtureWithMissingAxisField_ThrowsLoudly', () => {
    const fixture = `---
schema-version: 2
invariants:
  - id: INV-V1-SHAPE
    dimension: legacy-v1-entry
    cost-of-load: always-load
    applies-to:
      - test
    summary: A v1-shape entry with no axis field.
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-v1-axis-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    try {
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(
        /INV-V1-SHAPE/,
      );
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(/axis/);
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(
        /schema-version: 2/,
      );
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(
        /substrate.*authoring|authoring.*substrate/,
      );
    } finally {
      rmrf(tmpDir);
    }
  });

  /** A version-3 catalog must load, and each declared v3 field must reach the typed entry. */
  it('LoadInvariants_SchemaVersion3_Accepted', () => {
    const fixture = `---
schema-version: 3
invariants:
  - id: INV-V3-FIELDS
    dimension: test-v3-fields
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - test
    summary: Entry exercising the v3 optional fields.
    references:
      - docs/architecture/invariants.md
    phase-affinity:
      - review
      - plan
    workflow-affinity:
      - feature
    state-affinity:
      - drafting
    integrity-class: substrate
    severity:
      default: blocking
      by-workflow:
        debug: advisory
    enforcement:
      mode: check
      check:
        kind: grep
        pattern: "TODO"
        fileGlob: "**/*.ts"
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-v3-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    try {
      const entries = loadInvariants(tmpFile, undefined, registeredConfig(tmpFile));
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      expect(entry.id).toBe('INV-V3-FIELDS');
      expect(entry.axis).toBe('substrate');
      expect(entry.costOfLoad).toBe('always-load');
      expect(entry.phaseAffinity).toEqual(['review', 'plan']);
      expect(entry.workflowAffinity).toEqual(['feature']);
      expect(entry.stateAffinity).toEqual(['drafting']);
      expect(entry.integrityClass).toBe('substrate');
      expect(entry.severity).toBeDefined();
      expect(entry.severity!.default).toBe('blocking');
      expect(entry.severity!['by-workflow']?.debug).toBe('advisory');
      expect(entry.enforcement).toBeDefined();
      expect(entry.enforcement!.mode).toBe('check');
    } finally {
      rmrf(tmpDir);
    }
  });

  /** A version-2 catalog with no v3 field must load, and each v3 property must be `undefined`. */
  it('LoadInvariants_SchemaVersion2_StillAccepted', () => {
    const fixture = `---
schema-version: 2
invariants:
  - id: INV-V2-PLAIN
    dimension: test-v2-plain
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - test
    summary: A plain v2 entry, no v3 fields.
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-v2-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    try {
      const entries = loadInvariants(tmpFile, undefined, registeredConfig(tmpFile));
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      expect(entry.id).toBe('INV-V2-PLAIN');
      expect(entry.phaseAffinity).toBeUndefined();
      expect(entry.workflowAffinity).toBeUndefined();
      expect(entry.stateAffinity).toBeUndefined();
      expect(entry.integrityClass).toBeUndefined();
      expect(entry.severity).toBeUndefined();
      expect(entry.enforcement).toBeUndefined();
    } finally {
      rmrf(tmpDir);
    }
  });

  /**
   * A declared `schema-version` must be 2 or 3.
   * The error for a different version must name `schema-version` and the declared value.
   */
  it('LoadInvariants_UnsupportedSchemaVersion_ThrowsLoudly', () => {
    const fixture = `---
schema-version: 99
invariants:
  - id: INV-FUTURE
    dimension: test-future
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - test
    summary: Entry under an unsupported schema version.
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-badver-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    try {
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(
        /schema-version/,
      );
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(/99/);
    } finally {
      rmrf(tmpDir);
    }
  });

  /** The live catalog declares version 3, so this test pins the version-2 contract on a synthetic two-entry fixture. */
  it('LoadInvariants_V2FixtureCatalog_ZeroV3FieldsUnderV3Loader', () => {
    const v2Fixture = `---
schema-version: 2
invariants:
  - id: INV-1
    dimension: event-sourcing-integrity
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - event-store
    summary: A v2 entry that declares no v3 fields.
    references:
      - docs/architecture/invariants.md
  - id: DIM-8
    dimension: prose-quality
    axis: authoring
    cost-of-load: archivable
    applies-to:
      - documentation
    summary: A v2 authoring-axis entry.
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-v2-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, v2Fixture, 'utf8');
    try {
      const entries = loadInvariants(tmpFile, undefined, registeredConfig(tmpFile));
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(typeof entry.id).toBe('string');
        expect(entry.id.length).toBeGreaterThan(0);
        expect(entry.axis === 'substrate' || entry.axis === 'authoring').toBe(true);
        expect(['always-load', 'reference-only', 'archivable']).toContain(entry.costOfLoad);
        expect(Array.isArray(entry.appliesTo)).toBe(true);
        expect(typeof entry.summary).toBe('string');
        expect(entry.phaseAffinity).toBeUndefined();
        expect(entry.workflowAffinity).toBeUndefined();
        expect(entry.stateAffinity).toBeUndefined();
        expect(entry.integrityClass).toBeUndefined();
        expect(entry.severity).toBeUndefined();
        expect(entry.enforcement).toBeUndefined();
      }
    } finally {
      rmrf(tmpDir);
    }
  });

  /**
   * A duplicate id hides the earlier entry, so the loader must reject it at load time.
   * The config registers the temporary file.
   * Without that registration, the loader returns `[]` before it parses the entries.
   */
  it('InvariantsLoader_DuplicateIds_ThrowsWithIdInMessage', () => {
    const fixture = `---
invariants:
  - id: INV-1
    dimension: event-sourcing integrity
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - src/event-store
    summary: First copy of INV-1.
    references:
      - docs/architecture/invariants.md
  - id: INV-1
    dimension: duplicate
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - src/event-store
    summary: Second copy of INV-1 — should be rejected.
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-dup-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    try {
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(/INV-1/);
      expect(() => loadInvariants(tmpFile, undefined, registeredConfig(tmpFile))).toThrow(
        /Duplicate invariant ID/,
      );
    } finally {
      rmrf(tmpDir);
    }
  });
});
