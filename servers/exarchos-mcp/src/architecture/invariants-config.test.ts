import { describe, it, expect } from 'vitest';
import { ExarchosConfigSchema } from '../config/exarchos-config-schema.js';

/**
 * Invariants-catalog-v2 — Wave B1.
 *
 * `ExarchosConfig` must accept an optional `invariants.devCatalog` enum
 * flag so the invariants loader (Wave B2) can gate the catalog at the
 * `.exarchos.yml` layer. See:
 *
 *   docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §1.1 + §4.0 + §7.0
 *
 * Default semantics: the field is OPTIONAL on the schema. `undefined` is
 * equivalent to `'disabled'` at the loader (B2) — there is no schema-level
 * default so the loader can distinguish "operator never declared it" from
 * "operator explicitly opted out" if that ever matters.
 *
 * `parseExarchosConfig` here is `ExarchosConfigSchema.parse` — the canonical
 * validator. The function name in the spec / plan is `parseExarchosConfig`;
 * we use `safeParse` (the typed accessor) directly to keep the assertions
 * legible without a thin wrapper.
 */
describe('ExarchosConfigSchema — invariants.devCatalog (Wave B1)', () => {
  it('ExarchosConfig_AcceptsInvariantsDevCatalogEnabled_PreservesEnumValue', () => {
    const result = ExarchosConfigSchema.safeParse({
      invariants: { devCatalog: 'enabled' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invariants?.devCatalog).toBe('enabled');
    }
  });

  it('ExarchosConfig_AcceptsInvariantsDevCatalogDisabled_PreservesEnumValue', () => {
    const result = ExarchosConfigSchema.safeParse({
      invariants: { devCatalog: 'disabled' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invariants?.devCatalog).toBe('disabled');
    }
  });

  it('ExarchosConfig_RejectsInvalidDevCatalogValue', () => {
    // Enum is strict — typos like `'on'`, `'true'`, `'yes'` are rejected so
    // operators get a validation error rather than a silently-ignored field.
    const result = ExarchosConfigSchema.safeParse({
      invariants: { devCatalog: 'invalid' },
    });
    expect(result.success).toBe(false);
  });

  it('ExarchosConfig_EmptyObject_LeavesInvariantsUndefined', () => {
    // Default-disabled semantics: an operator who never declared the
    // `invariants:` block must get `undefined`, not a synthetic
    // `{ devCatalog: 'disabled' }` placeholder. The loader (B2) treats
    // `undefined === disabled` so a default value would only obscure intent.
    const result = ExarchosConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invariants).toBeUndefined();
    }
  });

  it('ExarchosConfig_InvariantsBlockWithoutDevCatalog_Validates', () => {
    // The `invariants:` block may exist without `devCatalog` set — e.g. for
    // forward-compatibility with future sub-keys. The block itself is
    // optional; `devCatalog` inside is also optional.
    const result = ExarchosConfigSchema.safeParse({
      invariants: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invariants).toBeDefined();
      expect(result.data.invariants?.devCatalog).toBeUndefined();
    }
  });

  it('ExarchosConfig_RejectsUnknownInvariantsField', () => {
    // `.strict()` on the nested schema rejects typos so an operator that
    // writes `invariants: { devcatalog: enabled }` (lowercase) sees a
    // validation error instead of a silently-ignored field.
    const result = ExarchosConfigSchema.safeParse({
      invariants: { devcatalog: 'enabled' },
    });
    expect(result.success).toBe(false);
  });
});
