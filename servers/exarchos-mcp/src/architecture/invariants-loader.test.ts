import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCoreInvariants,
  loadInvariants,
  type InvariantEntry,
} from './invariants-loader.js';

/**
 * Repo root resolution: invariants-loader.test.ts lives at
 *   servers/exarchos-mcp/src/architecture/invariants-loader.test.ts
 * Repo root is four directories up from this file.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, 'docs/architecture/invariants.md');

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
] as const;

const REQUIRED_DIMENSION_IDS = [
  'DIM-1',
  'DIM-2',
  'DIM-3',
  'DIM-4',
  'DIM-5',
  'DIM-6',
  'DIM-7',
  'DIM-8',
] as const;

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

    // All required INV-* and DIM-* must be present.
    for (const id of REQUIRED_INVARIANT_IDS) {
      expect(ids).toContain(id);
    }
    for (const id of REQUIRED_DIMENSION_IDS) {
      expect(ids).toContain(id);
    }

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
    // INV-5a references should point at the design-invariants skill reference file.
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
    for (const id of REQUIRED_DIMENSION_IDS) {
      expect(ids.has(id), `required dimension missing: ${id}`).toBe(true);
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

  it('Invariants_DimensionFieldRenames_AlignToAxiomCanonical', () => {
    // Axiom's canonical dimension names (axiom/skills/backend-quality/SKILL.md)
    // are Hygiene / Resilience / Prose Quality. The catalog must align so the
    // vocabulary-lint cross-walk between axiom and exarchos shares a single
    // taxonomy. Validates the audit's "name drift" findings for DIM-5/7/8.
    const entries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    const byId = new Map(entries.map((e) => [e.id, e] as const));

    const dim5 = byId.get('DIM-5');
    expect(dim5).toBeDefined();
    expect(dim5!.dimension).toBe('hygiene');

    const dim7 = byId.get('DIM-7');
    expect(dim7).toBeDefined();
    expect(dim7!.dimension).toBe('resilience');

    const dim8 = byId.get('DIM-8');
    expect(dim8).toBeDefined();
    expect(dim8!.dimension).toBe('prose-quality');
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
    // Per the 2026-05-18 audit per-row table, exactly four entries are
    // classified `cost-of-load: always-load`: INV-1, INV-2, INV-5a, INV-5b.
    // `scope: 'core'` must filter to that set; default and `scope: 'all'`
    // must return the full catalog (18 entries) for backward-compat.
    const coreEntries = loadInvariants(INVARIANTS_DOC, { scope: 'core' }, ENABLED_CONFIG);
    const coreIds = new Set(coreEntries.map((e) => e.id));
    expect(coreIds).toEqual(new Set(['INV-1', 'INV-2', 'INV-5a', 'INV-5b']));

    const allEntries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
    const defaultEntries = loadInvariants(INVARIANTS_DOC, undefined, ENABLED_CONFIG);
    expect(allEntries.length).toBe(18);
    expect(defaultEntries.length).toBe(18);
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
    // call boundary.
    const coreEntries = loadCoreInvariants(INVARIANTS_DOC, ENABLED_CONFIG);
    const coreIds = new Set(coreEntries.map((e) => e.id));
    expect(coreIds).toEqual(new Set(['INV-1', 'INV-2', 'INV-5a', 'INV-5b']));
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
    // `'enabled'` re-engages the existing scope filter. The full catalog
    // currently has 18 entries (v1 schema); `'core'` returns the four
    // `always-load` entries (INV-1, INV-2, INV-5a, INV-5b).
    const allEntries = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'all' },
      { invariants: { devCatalog: 'enabled' } },
    );
    expect(allEntries.length).toBe(18);

    const coreEntries = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'core' },
      { invariants: { devCatalog: 'enabled' } },
    );
    expect(new Set(coreEntries.map((e) => e.id))).toEqual(
      new Set(['INV-1', 'INV-2', 'INV-5a', 'INV-5b']),
    );
  });

  // ─── Wave C1: schema-version v2 + axis field ──────────────────────────
  //
  // v2 of the catalog bumps the frontmatter `schema-version` to 2 and
  // requires every entry to declare an `axis: substrate | authoring`
  // field. The axis is the primary discriminator the new scope filter
  // (Wave D1) intersects with `cost-of-load`.
  //
  // Spec: docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §3, §7.1

  it('Invariants_AfterSchemaV2Bump_EveryEntryHasAxisField', () => {
    // Read raw frontmatter to assert the schema-version bump.
    const source = fs.readFileSync(INVARIANTS_DOC, 'utf8');
    const frontmatterMatch = source.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch, 'invariants.md must have YAML frontmatter').not.toBeNull();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/^schema-version:\s*2\b/m);

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
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
