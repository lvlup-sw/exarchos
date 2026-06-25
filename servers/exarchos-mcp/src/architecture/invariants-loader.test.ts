import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCoreInvariants,
  loadInvariants,
  parseInvariantEntries,
  type InvariantEntry,
} from './invariants-loader.js';
import { rmrf } from '../test-helpers/temp-dir.js';

/**
 * Repo root resolution: invariants-loader.test.ts lives at
 *   servers/exarchos-mcp/src/architecture/invariants-loader.test.ts
 * Repo root is four directories up from this file.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');

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
  // Wave C4 split-off entries (post-v2 catalog):
  'INV-7',
  'INV-8',
  // Wave C5 split-off entry:
  'INV-12',
  // Wave C6 new entry:
  'INV-9',
  // Wave C7 new entry:
  'INV-10',
  // Wave C8 new entry:
  'INV-11',
  // Wave C9 new entry:
  'INV-13',
  // Wave C10 new entry:
  'INV-14',
  // Wave C11 new entry:
  'INV-15',
] as const;

/**
 * The DIM-* axiom-dimension entries were excised in the axiom-excision
 * feature (#1477). The catalog now carries exactly 19 entries: 18 INV-*
 * (counting sub-disciplines INV-5a..d as four) plus `basileus-boundary`.
 * Zero DIM-* entries remain; zero `axiom_overlap` fields remain.
 */
const EXPECTED_CATALOG_SIZE = 19;

/**
 * Most tests in this file exercise catalog *contents*, not the Wave B2
 * gating mechanism. They pass this explicit `enabled` config as the
 * third argument so the test fixture is decoupled from the state of the
 * repo's actual `.exarchos.yml` (which Wave B3 declares the flag in).
 *
 * Tests that exercise the gating itself (`LoadInvariants_WhenDevCatalog*`
 * suite) pass their own config inline. The dependency-injection pattern
 * keeps the gating contract explicit at every call site.
 */
const ENABLED_CONFIG = { invariants: { devCatalog: 'enabled' as const } };

describe('invariants-loader', () => {
  it('Invariants_StructuredFrontmatter_ParsesAllRequiredFields', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    expect(entries.length).toBeGreaterThan(0);

    const ids = entries.map((e) => e.id);

    // All required INV-* must be present.
    for (const id of REQUIRED_INVARIANT_IDS) {
      expect(ids).toContain(id);
    }

    // No DIM-* entries survive the axiom excision (#1477).
    expect(ids.filter((id) => id.startsWith('DIM-'))).toEqual([]);

    // Basileus boundary entry must be present.
    expect(ids).toContain('basileus-boundary');

    // Each entry must carry the required fields.
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

  it('Invariants_TypedEntries_HaveStableShape', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv5a = entries.find((e: InvariantEntry) => e.id === 'INV-5a');
    expect(inv5a).toBeDefined();
    expect(inv5a!.dimension.toLowerCase()).toContain('input');
    // INV-5a references should point at the relocated grounding-prose file
    // under docs/architecture/invariants/references/ (T-23 retired the skill).
    const hasInv5aRef = inv5a!.references.some((r) => r.includes('INV-5a'));
    expect(hasInv5aRef).toBe(true);
  });

  it('Invariants_AfterAudit_AllRequiredIdsStillPresentOrExplicitlyMigrated', () => {
    // Pins the contract that the audit (B1) preserves every required ID.
    // Future audit cycles that delete an entry must update REQUIRED_*_IDS
    // explicitly (with a comment) rather than silently letting this drift.
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const ids = new Set(entries.map((e) => e.id));
    for (const id of REQUIRED_INVARIANT_IDS) {
      expect(ids.has(id), `required invariant missing: ${id}`).toBe(true);
    }
    // DIM-* dimension pointers were excised (#1477) — none must remain.
    for (const id of entries.map((e) => e.id)) {
      expect(id.startsWith('DIM-'), `unexpected DIM-* entry: ${id}`).toBe(false);
    }
  });

  it('LoadInvariants_NoDimEntries_CatalogHas19', () => {
    // Axiom excision (#1477) removed all 8 DIM-* entries. The catalog is now
    // exactly 19 entries: 18 INV-* (INV-5a..d counted individually) plus the
    // single `basileus-boundary` cross-product entry.
    const entries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
    expect(entries.length).toBe(EXPECTED_CATALOG_SIZE);
    expect(entries.filter((e) => e.id.startsWith('DIM-'))).toEqual([]);
  });

  it('LoadInvariants_NoAxiomOverlapField_Parsed', () => {
    // The `axiom_overlap` field and its `axiomOverlap` typed accessor were
    // removed with the DIM-* machinery (#1477). No live entry declares it,
    // and the field is no longer surfaced on the typed shape.
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    for (const entry of entries) {
      expect(
        (entry as Record<string, unknown>).axiomOverlap,
        `entry ${entry.id} still carries an axiomOverlap accessor`,
      ).toBeUndefined();
    }
    // The raw frontmatter must also be free of the snake_case source field.
    for (const entry of entries) {
      expect(
        entry.raw.axiom_overlap,
        `entry ${entry.id} still carries a raw axiom_overlap field`,
      ).toBeUndefined();
    }
  });

  it('Invariants_AfterAudit_EveryKeptEntryHasAtLeastTwoReferencesInFrontmatter', () => {
    // Threshold is pragmatically >= 2: four thin-coverage entries
    // (DIM-4 / DIM-5 / DIM-7 / DIM-8) are explicit downgrade/stub framing
    // per the 2026-05-18 audit. A stricter >= 3 check belongs in a
    // follow-up once a `tier:` schema field is introduced.
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    for (const entry of entries) {
      expect(
        entry.references.length,
        `entry ${entry.id} has only ${entry.references.length} references; need >= 2`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('Invariants_BasileusBoundaryReferences_DoNotPointToSiblingRepoPaths', () => {
    // The audit found a broken pointer to `basileus/docs/adrs/...md` — a
    // sibling-repo path not present in this repository. References must
    // resolve in-repo so vocabulary-lint and link-checking tooling don't
    // false-fail. Basileus material stays addressable via memory pointers
    // and the cross-product memo, not in-frontmatter file refs.
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

  it('LoadInvariants_WithScopeCore_ReturnsOnlyAlwaysLoadEntries', () => {
    // The v2 catalog's always-load set: INV-1, INV-2, INV-5a, INV-5b
    // (v1-era) plus INV-7, INV-8 (C4 split) plus INV-11, INV-12, INV-15
    // (C8, C5, C11 new) plus INV-6 (C12 elevation).
    // `scope: 'core'` must include exactly the entries whose
    // `cost-of-load: always-load`; default and `scope: 'all'` return
    // the full catalog for backward-compat.
    const coreEntries = loadInvariants(INVARIANTS_DOC, { scope: 'core' }, ENABLED_CONFIG);
    const coreIds = new Set(coreEntries.map((e) => e.id));
    // Bracket via subset checks so this test stays stable as more
    // always-load entries land in subsequent C-tasks; per-entry presence
    // is asserted by the dedicated C-task tests.
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

  it('Invariants_EveryEntry_HasCostOfLoadField', () => {
    // Every catalog entry must declare a `cost-of-load` field per the
    // audit's contract. Missing field is a parse error (no silent default);
    // here we assert the populated catalog meets the typed contract.
    const validValues = new Set(['always-load', 'reference-only', 'archivable']);
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    for (const entry of entries) {
      expect(
        validValues.has(entry.costOfLoad),
        `entry ${entry.id} has invalid costOfLoad: ${String(entry.costOfLoad)}`,
      ).toBe(true);
    }
  });

  it('LoadInvariants_WithUnknownScope_ThrowsLoudly', () => {
    // Per design §5 DIM-2 (plan-review enrichment): unknown scopes are
    // a contract violation — the loader must throw, not silently fall back
    // to 'all'. The error message must name the offending scope and list
    // the valid options so the caller can self-correct.
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

  it('LoadCoreInvariants_ReturnsOnlyAlwaysLoadEntries', () => {
    // Documented convenience export: `loadCoreInvariants(path)` is equivalent
    // to `loadInvariants(path, { scope: 'core' })`. Exists so /ideate Phase 0
    // call sites can express intent at the import boundary rather than the
    // call boundary. The exact membership of the core set is asserted by
    // the per-entry C-task tests; this test pins the equivalence contract.
    const coreEntries = loadCoreInvariants(INVARIANTS_DOC, ENABLED_CONFIG);
    const coreIds = new Set(coreEntries.map((e) => e.id));
    expect(coreIds.has('INV-1')).toBe(true);
    expect(coreIds.has('INV-2')).toBe(true);
    expect(coreIds.has('INV-5a')).toBe(true);
    expect(coreIds.has('INV-5b')).toBe(true);
    // Equivalence with explicit scope arg.
    const explicit = loadInvariants(INVARIANTS_DOC, { scope: 'core' }, ENABLED_CONFIG);
    expect(coreEntries.map((e) => e.id)).toEqual(explicit.map((e) => e.id));
  });

  // ─── Wave B2: .exarchos.yml gating ─────────────────────────────────────
  //
  // The loader honours `invariants.devCatalog` from the supplied config.
  // When the flag is anything other than `'enabled'` (including absent /
  // empty / `'disabled'`), the loader returns `[]` regardless of the
  // `scope` filter — gating applies BEFORE scope. See:
  //
  //   docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §4.0
  //
  // The third positional argument is dependency-injectable for tests so
  // they don't need to author a temp `.exarchos.yml` fixture; production
  // call sites get the default `readInvariantsConfig()` reader.

  it('LoadInvariants_WhenDevCatalogDisabled_ReturnsEmpty', () => {
    // Explicit `'disabled'` — the canonical opt-out case.
    const entries = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'all' },
      { invariants: { devCatalog: 'disabled' } },
    );
    expect(entries).toEqual([]);

    // Scope must not bypass the gate: even `'core'` returns `[]` when
    // the flag is disabled.
    const coreEntries = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'core' },
      { invariants: { devCatalog: 'disabled' } },
    );
    expect(coreEntries).toEqual([]);
  });

  it('LoadInvariants_WhenConfigOmitsInvariants_ReturnsEmptyDefaultDisabled', () => {
    // Empty config — represents a consumer using Exarchos as a plugin in
    // a non-Exarchos project who never declared the block at all.
    const entries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, {});
    expect(entries).toEqual([]);
  });

  it('LoadInvariants_WhenInvariantsBlockEmpty_ReturnsEmptyDefaultDisabled', () => {
    // The `invariants:` key is declared but `devCatalog` is unset.
    // Equivalent to the empty-config case — default-disabled wins.
    const entries = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'all' },
      { invariants: {} },
    );
    expect(entries).toEqual([]);
  });

  it('LoadInvariants_WhenDevCatalogEnabled_ReturnsEntriesPerScope', () => {
    // `'enabled'` re-engages the existing scope filter. v2 catalog
    // membership grows across C4..C11; this test pins the contract that
    // `'core'` is non-empty when enabled, while v1-era always-load IDs
    // (INV-1, INV-2, INV-5a, INV-5b) remain present.
    const allEntries = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'all' },
      { invariants: { devCatalog: 'enabled' } },
    );
    expect(allEntries.length).toBeGreaterThanOrEqual(18);

    const coreEntries = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'core' },
      { invariants: { devCatalog: 'enabled' } },
    );
    const coreIds = new Set(coreEntries.map((e) => e.id));
    expect(coreIds.has('INV-1')).toBe(true);
    expect(coreIds.has('INV-2')).toBe(true);
    expect(coreIds.has('INV-5a')).toBe(true);
    expect(coreIds.has('INV-5b')).toBe(true);
  });

  // ─── Wave C1: schema-version v2 + axis field ──────────────────────────
  //
  // v2 of the catalog bumps the frontmatter `schema-version` to 2 and
  // requires every entry to declare an `axis: substrate | authoring`
  // field. The axis is the primary discriminator the new scope filter
  // (Wave D1) intersects with `cost-of-load`.
  //
  // Spec: docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §3, §7.1

  it('parseInvariantEntries_rawEntries_projectsTypedShapeWithV3Fields', () => {
    // The pure raw[]→typed projection reused by both the file loader and the
    // inline sdlc catalog (#1467). No file-IO, no devCatalog gate, no scope.
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

  it('parseInvariantEntries_nonObjectEntry_throwsIndexNamedError', () => {
    // A null/primitive element must fail with a clear, index-named loader error
    // rather than a generic TypeError deep in parseEntry. The dev/user layers
    // surface this as a DR-9 degradation warning naming the catalog.
    const bad = [
      { id: 'SDLC-1', dimension: 'a', axis: 'substrate', 'cost-of-load': 'always-load', 'applies-to': ['x'], summary: 's', references: ['r'] },
      null,
    ];
    expect(() => parseInvariantEntries(bad)).toThrow(/entry at index 1 must be an object/);
    expect(() => parseInvariantEntries(['just-a-string'])).toThrow(/entry at index 0 must be an object/);
  });

  it('Invariants_AfterSchemaV3Bump_EveryEntryHasAxisField', () => {
    // Read raw frontmatter to assert the schema-version bump (v3, issue #1466).
    const source = fs.readFileSync(INVARIANTS_DOC, 'utf8');
    const frontmatterMatch = source.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch, 'invariants.md must have YAML frontmatter').not.toBeNull();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/^schema-version:\s*3\b/m);

    // Every loaded entry must expose the typed `axis` field with one of
    // the two allowed values. Asserts the loader has promoted the new
    // field from `raw` to the typed shape.
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        entry.axis === 'substrate' || entry.axis === 'authoring',
        `entry ${entry.id} has invalid axis: ${String(entry.axis)}`,
      ).toBe(true);
    }
  });

  it('Invariants_AxisFieldMissing_ThrowsLoudlyWithEntryId', () => {
    // Schema-v2 contract: missing `axis` is a parse error (no silent
    // default). The error message must name the offending entry's id so
    // catalog editors can locate the omission.
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
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(
        /INV-MISSING-AXIS/,
      );
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(/axis/);
    } finally {
      rmrf(tmpDir);
    }
  });

  // ─── Wave C2: citations field (schema-v2) ─────────────────────────────
  //
  // Schema-v2 adds a `citations: string[]` field for external research
  // grounding. As of #1478 the ≥3-citations floor for substrate-axis entries
  // is ENFORCED (was previously a deferred ≥2-references-only pin). Two
  // documented exemptions remain:
  //   - INV-5d  — reference-only sub-discipline of INV-5; grounding lives on
  //               the parent INV-5a/5b/5c entries.
  //   - basileus-boundary — cross-product coordination entry whose grounding
  //               is the Exarchos↔Basileus coordination ADR, addressed via
  //               its references, not in-frontmatter citations.
  //
  // Spec: docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §3

  it('Invariants_EverySubstrateAxisEntry_HasAtLeastThreeCitations', () => {
    // ENFORCED floor (#1478): every substrate-axis invariant carries ≥3 real,
    // verifiable citations so the grounding gap cannot reopen silently. The
    // exempt set is documented above and must stay small + intentional.
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

  it('Invariants_SubstrateAxisEntries_AcceptCitationsField', () => {
    // Synthetic fixture with the new field. Loader must parse it into
    // the typed `citations: string[]` accessor without rejecting.
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
      const entries = loadInvariants(tmpFile, undefined, ENABLED_CONFIG);
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

  it('Invariants_OmittingCitationsField_ParsesWithUndefinedCitations', () => {
    // `citations` is optional — entries without it must still parse and
    // expose `undefined` (NOT `[]` — distinguish "not declared" from
    // "declared empty") on the typed accessor. We anchor this contract on
    // `basileus-boundary`, a stable cross-product entry that carries no
    // citations and isn't expected to. (The DIM-* axiom-pointer entries
    // that previously anchored this contract were excised in #1477.)
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const noCitations = entries.find((e) => e.id === 'basileus-boundary');
    expect(noCitations).toBeDefined();
    expect(noCitations!.citations).toBeUndefined();
  });

  // ─── Wave C3 (excised, #1477): axiom_overlap field removed ────────────
  //
  // Schema-v2 once carried an optional `axiom_overlap: DIM-N` field for
  // `/axiom:design` pairing-discovery. The axiom-excision feature (#1477)
  // removed the field, its `axiomOverlap` typed accessor, the format check,
  // and the referential-integrity check together with the DIM-* entries.
  // A fixture declaring `axiom_overlap` now parses successfully and simply
  // does NOT surface the field on the typed shape (the snake_case key is
  // tolerated as an unknown frontmatter field per the loader's `raw`
  // passthrough). See `LoadInvariants_NoAxiomOverlapField_Parsed` above for
  // the live-catalog absence guard.

  it('Invariants_AxiomOverlapField_ParsesButIsNotSurfaced', () => {
    // A fixture that still declares the legacy `axiom_overlap` snake-case
    // key must parse without error and without an `axiomOverlap` accessor —
    // the loader no longer has a parse path for it.
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
      const entries = loadInvariants(tmpFile, undefined, ENABLED_CONFIG);
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      expect((entry as Record<string, unknown>).axiomOverlap).toBeUndefined();
    } finally {
      rmrf(tmpDir);
    }
  });

  // ─── Wave C4: INV-1 split → INV-1 (narrowed) + INV-7 + INV-8 ──────────
  //
  // Spec §5.1: v1 INV-1 conflated three concerns (event-sourcing integrity,
  // substrate-serialization, idempotency-at-the-boundary). v2 narrows INV-1
  // to event-sourcing integrity only and promotes the other two to first-
  // class entries (INV-7 substrate-serialization, INV-8 idempotency).
  //
  // Spec: docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §5.1, §6

  it('Invariants_INV1Split_ProducesINV1NarrowedPlusINV7PlusINV8', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const byId = new Map(entries.map((e) => [e.id, e] as const));

    // INV-1 narrowed: summary must drop substrate-serialization + idempotency
    // claims; keeps event-as-design-authority + reducer-purity language.
    const inv1 = byId.get('INV-1');
    expect(inv1).toBeDefined();
    expect(inv1!.summary.toLowerCase()).not.toMatch(/idempotency/);
    expect(inv1!.summary.toLowerCase()).not.toMatch(/streamlockmanager/);
    expect(inv1!.summary.toLowerCase()).not.toMatch(/occ\b/);
    expect(inv1!.summary.toLowerCase()).not.toMatch(/sqlite/);

    // INV-7 substrate-serialization
    const inv7 = byId.get('INV-7');
    expect(inv7, 'INV-7 must exist post-split').toBeDefined();
    expect(inv7!.dimension).toBe('substrate-serialization');
    expect(inv7!.axis).toBe('substrate');
    expect(inv7!.costOfLoad).toBe('always-load');
    expect(inv7!.citations).toBeDefined();
    expect(inv7!.citations!.length).toBeGreaterThanOrEqual(3);
    expect(inv7!.citations!.join(' ')).toMatch(/ARIES/i);
    expect(inv7!.citations!.join(' ')).toMatch(/Bernstein/i);

    // INV-8 idempotency-at-the-boundary
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

  // ─── Wave C5: INV-5b split → INV-5b (narrowed) + INV-12 ───────────────
  //
  // Spec §5.1: v1 INV-5b conflated carrier-shape (next_actions field
  // presence, _meta, _perf, error envelope) with the affordance-as-perceived
  // concept. v2 narrows INV-5b to carrier-shape only and promotes the
  // affordance reading to INV-12 (next-actions-as-affordance).
  //
  // Spec: docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §5.1, §6

  it('Invariants_INV5bSplit_ProducesINV5bNarrowedPlusINV12', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const byId = new Map(entries.map((e) => [e.id, e] as const));

    // INV-5b narrowed: summary keeps carrier-shape rules — next_actions
    // field, _meta, _perf, error envelopes. It MUST still mention
    // structuredContent / next_actions since those are the carrier shape.
    const inv5b = byId.get('INV-5b');
    expect(inv5b).toBeDefined();
    expect(inv5b!.dimension).toBe('output-contract');

    // INV-12 next-actions-as-affordance
    const inv12 = byId.get('INV-12');
    expect(inv12, 'INV-12 must exist post-split').toBeDefined();
    expect(inv12!.dimension).toBe('next-actions-as-affordance');
    expect(inv12!.axis).toBe('substrate');
    expect(inv12!.costOfLoad).toBe('always-load');
    expect(inv12!.citations).toBeDefined();
    expect(inv12!.citations!.length).toBeGreaterThanOrEqual(3);
    // Per spec §6 INV-12: Norman 1999 + McGrenere/Ho 2000 are required.
    expect(inv12!.citations!.join(' ')).toMatch(/Norman/i);
    expect(inv12!.citations!.join(' ')).toMatch(/McGrenere/i);
  });

  // ─── Wave C6: add INV-9 hsm-as-state-machine ──────────────────────────
  //
  // Spec §5.2 + §6 INV-9 (post-A1 Harel backfill): every workflow type
  // ships a hierarchical state machine in topology.yaml; transitions
  // are guarded; the HSM is the sole authority for valid phase
  // sequencing.

  it('Invariants_INV9_ExistsWithHSMScope', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv9 = entries.find((e) => e.id === 'INV-9');
    expect(inv9, 'INV-9 must exist in v2 catalog').toBeDefined();
    expect(inv9!.dimension).toBe('hsm-as-state-machine');
    expect(inv9!.axis).toBe('substrate');
    expect(inv9!.costOfLoad).toBe('reference-only');
    expect(inv9!.citations).toBeDefined();
    expect(inv9!.citations!.length).toBeGreaterThanOrEqual(3);
    // Post-A1 Harel citation must be present.
    expect(inv9!.citations!.join(' ')).toMatch(/Harel/i);
  });

  // ─── Wave C7: add INV-10 liveness-event-protocol ──────────────────────
  //
  // Spec §5.2 + §6 INV-10: every long-running operation emits paired
  // executing_started + terminal events. v2.12 lifecycle verbs query
  // these generically — no per-feature lifecycle code.

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

  // ─── Wave C8: add INV-11 posture-declared-capabilities ────────────────
  //
  // Spec §5.1 + §6 INV-11: agents declare one of three postures
  // (read-only | task-isolated | shared-mutating); capability resolver
  // merges with the MCP initialize handshake (handshake-authoritative).
  // ≥4 citations including Miller *Robust Composition* + POLA + anip-protocol.

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

  // ─── Wave C9: add INV-13 process-manager-two-event-split ──────────────
  //
  // Spec §5.2 + §6 INV-13: handlers performing non-idempotent external
  // side effects emit *.requested + *.executed events; on retry the
  // requested event idempotency-collapses (INV-8); on crash recovery
  // the next invocation observes *.requested without *.executed and
  // runs an idempotent precheck.

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

  // ─── Wave C10: add INV-14 native-primitive-first-recovery ─────────────
  //
  // Spec §5.2 + §6 INV-14: prefer the operation's own recovery primitive
  // (git merge --abort), fall back to refuse-to-discard semantics
  // (git reset --keep), never destructive overwrite (git reset --hard).
  // Ships as catalog entry per A2 disposition (demote if rarely cited
  // after one release cycle).

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

  // ─── Wave C11: add INV-15 single-machine-frame ────────────────────────
  //
  // Spec §5.1 + §6 INV-15: Exarchos is single-machine event-sourced with
  // cooperative agents — concurrent, not distributed. No saga, no SAS,
  // no 2PC, no leader election. Compensation is local rewind.

  it('Invariants_INV15_ExistsWithSingleMachineFrameScope', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv15 = entries.find((e) => e.id === 'INV-15');
    expect(inv15, 'INV-15 must exist in v2 catalog').toBeDefined();
    expect(inv15!.dimension).toBe('single-machine-frame');
    expect(inv15!.axis).toBe('substrate');
    expect(inv15!.costOfLoad).toBe('always-load');
    expect(inv15!.citations).toBeDefined();
    expect(inv15!.citations!.length).toBeGreaterThanOrEqual(3);
    // Per spec §6: Microsoft SAS + Saga + Clemens Vasters (negative refs).
    expect(inv15!.citations!.join(' ')).toMatch(/Scheduler[- ]Agent[- ]Supervisor/i);
    expect(inv15!.citations!.join(' ')).toMatch(/Saga/i);
    expect(inv15!.citations!.join(' ')).toMatch(/Clemens Vasters/i);
  });

  // ─── Wave C12: sharpen INV-6 to primary workload-agnosticism ──────────
  //
  // Spec §5.1 + §6 INV-6 (sharpened): elevate INV-6 from a skill-grep
  // operational shell to the primary workload-agnosticism statement —
  // cost-of-load: always-load (was reference-only); summary asserts
  // "no assumption about which workload"; references the scripts/lint-inv6.mjs
  // projection; applies-to broader than skills-src + playbooks.

  it('Invariants_INV6Sharpened_PrimaryStatementNotGrepOnly', () => {
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const inv6 = entries.find((e) => e.id === 'INV-6');
    expect(inv6, 'INV-6 must exist').toBeDefined();
    // Elevated to always-load (was reference-only in v1).
    expect(inv6!.costOfLoad).toBe('always-load');
    // Primary workload-agnosticism statement language.
    expect(inv6!.summary.toLowerCase()).toMatch(/no assumption about which workload/);
    // Operational projection pointer preserved.
    expect(inv6!.summary).toMatch(/scripts\/lint-inv6\.mjs/);
    // applies-to is broader than v1's skills-src + playbooks.
    expect(inv6!.appliesTo).toContain('runtime-substrate');
    expect(inv6!.appliesTo).toContain('topology');
    // Per spec §6, ≥3 citations recommended.
    expect(inv6!.citations).toBeDefined();
    expect(inv6!.citations!.length).toBeGreaterThanOrEqual(3);
  });

  // ─── Wave D1: scope filter expansion ──────────────────────────────────
  //
  // Spec §4.1 + §4.2: the `scope` argument expands from `'core' | 'all'` to
  // `'core' | 'substrate' | 'authoring' | 'all'`. The semantics:
  //
  //   - `'core'`       → axis === 'substrate' AND cost-of-load === 'always-load'
  //                      (the /ideate Phase 0 working set — 10 entries in v2)
  //   - `'substrate'`  → axis === 'substrate' (all 26 entries: 10 always-load +
  //                      15 reference-only + 1 archivable)
  //   - `'authoring'`  → axis === 'authoring' (DIM-8 only — 1 entry in v2)
  //   - `'all'`        → every entry (27 entries in v2)
  //
  // Spec: docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §4.1, §4.2

  it('LoadInvariants_WithScopeCore_ReturnsSubstrateAndAlwaysLoad', () => {
    // 'core' is the tightest scope: axis=substrate AND cost-of-load=always-load.
    // Per spec §5.1 the v2 catalog has exactly 10 such entries:
    //   INV-1, INV-2, INV-5a, INV-5b, INV-6, INV-7, INV-8, INV-11, INV-12, INV-15.
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
    // Every entry must satisfy both predicates.
    for (const entry of core) {
      expect(entry.axis).toBe('substrate');
      expect(entry.costOfLoad).toBe('always-load');
    }
  });

  it('LoadInvariants_WithScopeSubstrate_ReturnsAllSubstrateAxisEntries', () => {
    // 'substrate' returns every entry on the substrate axis regardless of
    // cost-of-load. After the axiom excision (#1477) the catalog has 19
    // entries, all substrate-axis (the sole authoring entry DIM-8 was
    // removed with the rest of the DIM-* block). So substrate === all === 19.
    const substrate = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'substrate' as 'core' },
      ENABLED_CONFIG,
    );
    expect(substrate.length).toBe(EXPECTED_CATALOG_SIZE);
    for (const entry of substrate) {
      expect(entry.axis).toBe('substrate');
    }
    // No DIM-* entries remain.
    expect(substrate.filter((e) => e.id.startsWith('DIM-'))).toEqual([]);
  });

  it('LoadInvariants_WithScopeAuthoring_ReturnsAuthoringAxisOnly', () => {
    // 'authoring' returns every entry on the authoring axis. The sole
    // authoring entry (DIM-8) was excised with the axiom dimensions
    // (#1477), so the authoring scope is now empty.
    const authoring = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'authoring' as 'core' },
      ENABLED_CONFIG,
    );
    expect(authoring).toEqual([]);
  });

  it('LoadInvariants_WithScopeAll_ReturnsFullCatalog', () => {
    // 'all' returns the full 19-entry catalog (post axiom excision, #1477).
    // Default (no opts) must be equivalent for backwards compatibility with
    // v1 call sites.
    const all = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
    expect(all.length).toBe(EXPECTED_CATALOG_SIZE);
    const def = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    expect(def.map((e) => e.id)).toEqual(all.map((e) => e.id));
  });

  it('LoadInvariants_ScopeSubstratePlusAuthoring_EqualsAll', () => {
    // Partition invariant: substrate ∪ authoring = all (axis is a total
    // partition over the catalog — every entry declares exactly one axis).
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

  // ─── Wave D2: fail-loud on missing axis (regression vs v1 fixtures) ───
  //
  // Schema-v2 requires `axis` on every entry. A v1-shape fixture (no axis
  // field anywhere) must fail to parse with a descriptive message naming
  // the offending entry id and the schema-version requirement. Closes the
  // regression hole where a downgrade to v1 input would silently default.
  //
  // Spec: docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §3, §7.8

  it('LoadInvariants_V1FixtureWithMissingAxisField_ThrowsLoudly', () => {
    // A fixture matching v1's catalog structure: no `axis` field on any
    // entry. The loader must throw on the first entry encountered, naming
    // its id and citing the schema-version: 2 requirement.
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
      // Error message must name the offending entry id.
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(
        /INV-V1-SHAPE/,
      );
      // Error message must reference the `axis` field by name.
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(/axis/);
      // Error message must cite schema-version: 2 + the allowed values to
      // tell catalog editors how to fix the omission.
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(
        /schema-version: 2/,
      );
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(
        /substrate.*authoring|authoring.*substrate/,
      );
    } finally {
      rmrf(tmpDir);
    }
  });

  // ─── T-02 / T-03 (DR-1): loader accepts schema-version 2 AND 3 ────────
  //
  // The v3 catalog bumps `schema-version` to 3 and layers optional v3
  // affinity / enforcement / severity / integrity-class fields onto each
  // entry. The loader must accept both v2 and v3, surface declared v3
  // fields, and remain fully back-compatible with the live v2 catalog.
  //
  // Schema source of truth: ./invariant-schema.ts (InvariantEntryV3Schema).

  it('LoadInvariants_SchemaVersion3_Accepted', () => {
    // A version-3 catalog carrying the v3 optional fields must load and
    // surface them on the typed entry. Witnesses both halves of T-02:
    // the version guard widening (3 is accepted) and the v3 projection
    // (declared fields reach the returned entry).
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
      const entries = loadInvariants(tmpFile, undefined, ENABLED_CONFIG);
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      // v2 fields intact.
      expect(entry.id).toBe('INV-V3-FIELDS');
      expect(entry.axis).toBe('substrate');
      expect(entry.costOfLoad).toBe('always-load');
      // v3 fields surfaced through the typed accessors.
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

  it('LoadInvariants_SchemaVersion2_StillAccepted', () => {
    // A version-2 catalog with no v3 fields must still load (back-compat),
    // and its v3 accessors must resolve to undefined (not declared).
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
      const entries = loadInvariants(tmpFile, undefined, ENABLED_CONFIG);
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      expect(entry.id).toBe('INV-V2-PLAIN');
      // Every v3 accessor resolves to undefined when absent.
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

  it('LoadInvariants_UnsupportedSchemaVersion_ThrowsLoudly', () => {
    // The version guard accepts only 2 and 3. Anything else (here: 99)
    // is a loud parse error that names the offending value and the
    // supported set, so catalog editors can correct the frontmatter.
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
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(
        /schema-version/,
      );
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(/99/);
    } finally {
      rmrf(tmpDir);
    }
  });

  it('LoadInvariants_V2FixtureCatalog_ZeroV3FieldsUnderV3Loader', () => {
    // Back-compat contract (DR-1): a schema-version: 2 catalog with NO v3 keys
    // loads under the widened v3 loader with every v3 field undefined.
    //
    // NOTE: the LIVE docs/architecture/invariants.md is now schema-version: 3
    // and authors v3 fields (issue #1466 — see dev-catalog-content.test.ts).
    // This guard therefore pins the v2 back-compat contract against a synthetic
    // v2 fixture rather than the live file, so the contract stays asserted even
    // though the live catalog has graduated to v3.
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
      const entries = loadInvariants(tmpFile, undefined, ENABLED_CONFIG);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        // v2 required fields are well-formed.
        expect(typeof entry.id).toBe('string');
        expect(entry.id.length).toBeGreaterThan(0);
        expect(entry.axis === 'substrate' || entry.axis === 'authoring').toBe(true);
        expect(['always-load', 'reference-only', 'archivable']).toContain(entry.costOfLoad);
        expect(Array.isArray(entry.appliesTo)).toBe(true);
        expect(typeof entry.summary).toBe('string');
        // No v3 field is populated under the v2 catalog.
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

  it('InvariantsLoader_DuplicateIds_ThrowsWithIdInMessage', () => {
    // Construct a frontmatter fixture with two entries sharing the same id
    // (`INV-1`). The loader must reject this at load time so a silent
    // duplicate cannot shadow the legitimate entry.
    const fixture = `---
invariants:
  - id: INV-1
    dimension: event-sourcing integrity
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - servers/exarchos-mcp/src/event-store
    summary: First copy of INV-1.
    references:
      - docs/architecture/invariants.md
  - id: INV-1
    dimension: duplicate
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - servers/exarchos-mcp/src/event-store
    summary: Second copy of INV-1 — should be rejected.
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-dup-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    // Pass `ENABLED_CONFIG` (defined at the top of this file) so the
    // gating check (B2) doesn't short-circuit before we reach the
    // duplicate-ID parse logic. The tmpfile is under `/tmp/`, outside
    // any `.exarchos.yml` walk-up boundary, so the default reader would
    // otherwise return `{}` and gating would mask the duplicate-ID
    // rejection we're asserting here.
    try {
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(/INV-1/);
      expect(() => loadInvariants(tmpFile, undefined, ENABLED_CONFIG)).toThrow(
        /Duplicate invariant ID/,
      );
    } finally {
      rmrf(tmpDir);
    }
  });
});
