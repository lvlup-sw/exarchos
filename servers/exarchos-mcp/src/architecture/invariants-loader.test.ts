import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInvariants, type InvariantEntry } from './invariants-loader.js';

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

describe('invariants-loader', () => {
  it('Invariants_StructuredFrontmatter_ParsesAllRequiredFields', () => {
    const entries = loadInvariants(INVARIANTS_DOC);
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
    const entries = loadInvariants(INVARIANTS_DOC);
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
    const entries = loadInvariants(INVARIANTS_DOC);
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
    const entries = loadInvariants(INVARIANTS_DOC);
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
    const entries = loadInvariants(INVARIANTS_DOC);
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
    const entries = loadInvariants(INVARIANTS_DOC);
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
    const coreEntries = loadInvariants(INVARIANTS_DOC, { scope: 'core' });
    const coreIds = new Set(coreEntries.map((e) => e.id));
    expect(coreIds).toEqual(new Set(['INV-1', 'INV-2', 'INV-5a', 'INV-5b']));

    const allEntries = loadInvariants(INVARIANTS_DOC, { scope: 'all' });
    const defaultEntries = loadInvariants(INVARIANTS_DOC);
    expect(allEntries.length).toBe(18);
    expect(defaultEntries.length).toBe(18);
    expect(defaultEntries.map((e) => e.id)).toEqual(allEntries.map((e) => e.id));
  });

  it('Invariants_EveryEntry_HasCostOfLoadField', () => {
    // Every catalog entry must declare a `cost-of-load` field per the
    // audit's contract. Missing field is a parse error (no silent default);
    // here we assert the populated catalog meets the typed contract.
    const validValues = new Set(['always-load', 'reference-only', 'archivable']);
    const entries = loadInvariants(INVARIANTS_DOC);
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
      loadInvariants(INVARIANTS_DOC, { scope: 'invalid-scope' as unknown as 'core' }),
    ).toThrow(/invalid-scope/);
    expect(() =>
      loadInvariants(INVARIANTS_DOC, { scope: 'invalid-scope' as unknown as 'core' }),
    ).toThrow(/core/);
    expect(() =>
      loadInvariants(INVARIANTS_DOC, { scope: 'invalid-scope' as unknown as 'core' }),
    ).toThrow(/all/);
  });

  it('InvariantsLoader_DuplicateIds_ThrowsWithIdInMessage', () => {
    // Construct a frontmatter fixture with two entries sharing the same id
    // (`INV-1`). The loader must reject this at load time so a silent
    // duplicate cannot shadow the legitimate entry.
    const fixture = `---
invariants:
  - id: INV-1
    dimension: event-sourcing integrity
    cost-of-load: always-load
    applies-to:
      - servers/exarchos-mcp/src/event-store
    summary: First copy of INV-1.
    references:
      - docs/architecture/invariants.md
  - id: INV-1
    dimension: duplicate
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
    try {
      expect(() => loadInvariants(tmpFile)).toThrow(/INV-1/);
      expect(() => loadInvariants(tmpFile)).toThrow(/Duplicate invariant ID/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
