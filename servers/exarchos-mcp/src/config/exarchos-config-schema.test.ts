import { describe, it, expect } from 'vitest';
import { ExarchosConfigSchema } from './exarchos-config-schema.js';

describe('ExarchosConfigSchema', () => {
  it('schema_AllFieldsProvided_Validates', () => {
    const result = ExarchosConfigSchema.safeParse({
      test: 'bun test',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.test).toBe('bun test');
      expect(result.data.typecheck).toBe('tsc --noEmit');
      expect(result.data.install).toBe('bun install');
    }
  });

  it('schema_PartialFields_Validates_TestOnly', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'bun test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.test).toBe('bun test');
      expect(result.data.typecheck).toBeUndefined();
      expect(result.data.install).toBeUndefined();
      expect(result.data.typecheck).not.toBeNull();
      expect(result.data.install).not.toBeNull();
    }
  });

  it('schema_PartialFields_Validates_TypecheckOnly', () => {
    const result = ExarchosConfigSchema.safeParse({ typecheck: 'tsc --noEmit' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.typecheck).toBe('tsc --noEmit');
      expect(result.data.test).toBeUndefined();
      expect(result.data.install).toBeUndefined();
      expect(result.data.test).not.toBeNull();
      expect(result.data.install).not.toBeNull();
    }
  });

  it('schema_EmptyObject_Validates', () => {
    const result = ExarchosConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.test).toBeUndefined();
      expect(result.data.typecheck).toBeUndefined();
      expect(result.data.install).toBeUndefined();
    }
  });

  it('schema_TestUnsafeChars_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'rm -rf /; pytest' });
    expect(result.success).toBe(false);
  });

  it('schema_TestBackticks_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'pytest `whoami`' });
    expect(result.success).toBe(false);
  });

  it('schema_TestDollarSign_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'pytest $HOME' });
    expect(result.success).toBe(false);
  });

  it('schema_UnknownField_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'pytest', extra: 'foo' });
    expect(result.success).toBe(false);
  });

  it('schema_TypeMismatchedField_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 42 });
    expect(result.success).toBe(false);
  });

  it('schema_EmptyStringTest_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({ test: '' });
    expect(result.success).toBe(false);
  });

  // ─── #1244: handoffLint config block ───────────────────────────────────
  //
  // `handoffLint.hardFail` toggles whether `handleCheckpoint` blocks the
  // dispatch when the prose-lint finds AI-padded handoff text. Defaults
  // (field absent / hardFail absent) keep the soft-warning behaviour
  // unchanged for pre-#1244 callers.

  it('schema_HandoffLintHardFailTrue_Validates', () => {
    const result = ExarchosConfigSchema.safeParse({
      handoffLint: { hardFail: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handoffLint?.hardFail).toBe(true);
    }
  });

  it('schema_HandoffLintHardFailFalse_Validates', () => {
    const result = ExarchosConfigSchema.safeParse({
      handoffLint: { hardFail: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handoffLint?.hardFail).toBe(false);
    }
  });

  it('schema_HandoffLintAbsent_Validates', () => {
    // The handoffLint block is optional — pre-#1244 configs (without
    // any handoffLint key) must continue to validate.
    const result = ExarchosConfigSchema.safeParse({ test: 'bun test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handoffLint).toBeUndefined();
    }
  });

  it('schema_HandoffLintUnknownField_Rejected', () => {
    // `.strict()` on the nested schema rejects typos so an operator
    // that writes `handoffLint: { hardfail: true }` (lowercase) sees a
    // validation error instead of a silently-ignored field.
    const result = ExarchosConfigSchema.safeParse({
      handoffLint: { hardfail: true },
    });
    expect(result.success).toBe(false);
  });

  // ─── #1273 / T33: cli.followPollIntervalMs ─────────────────────────────
  //
  // The CLI `--follow` polling loop reads the dispatch-core
  // `EventSourcedTaskStore` at a fixed cadence to render each transition
  // to stdout. The default is 250ms (matches the dispatch design); the
  // config block lets an operator tune it for slow shells (e.g. CI logs
  // grow noisy at 250ms) or fast tests (override to 10ms).

  it('schema_CliFollowPollIntervalMs_Validates', () => {
    const result = ExarchosConfigSchema.safeParse({
      cli: { followPollIntervalMs: 100 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cli?.followPollIntervalMs).toBe(100);
    }
  });

  it('schema_CliFollowPollIntervalMs_AcceptsLargeValue', () => {
    const result = ExarchosConfigSchema.safeParse({
      cli: { followPollIntervalMs: 5000 },
    });
    expect(result.success).toBe(true);
  });

  it('schema_CliFollowPollIntervalMs_RejectsZero', () => {
    // A 0ms cadence would spin the loop; require a positive integer.
    const result = ExarchosConfigSchema.safeParse({
      cli: { followPollIntervalMs: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('schema_CliFollowPollIntervalMs_RejectsNegative', () => {
    const result = ExarchosConfigSchema.safeParse({
      cli: { followPollIntervalMs: -50 },
    });
    expect(result.success).toBe(false);
  });

  it('schema_CliFollowPollIntervalMs_RejectsNonInteger', () => {
    // Polling cadence is whole milliseconds — reject fractional inputs so
    // a typo like `0.25` (caller meant 250) surfaces as a validation error
    // instead of degrading to a sub-millisecond spin loop.
    const result = ExarchosConfigSchema.safeParse({
      cli: { followPollIntervalMs: 12.5 },
    });
    expect(result.success).toBe(false);
  });

  it('schema_CliBlockAbsent_Validates', () => {
    // The cli block is optional — pre-#1273 configs (without any cli key)
    // must continue to validate.
    const result = ExarchosConfigSchema.safeParse({ test: 'bun test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cli).toBeUndefined();
    }
  });

  it('schema_CliUnknownField_Rejected', () => {
    // `.strict()` on the nested schema rejects typos so an operator that
    // writes `cli: { followPollIntervalMS: 100 }` (case typo) sees a
    // validation error instead of a silently-ignored field.
    const result = ExarchosConfigSchema.safeParse({
      cli: { followPollIntervalMS: 100 },
    });
    expect(result.success).toBe(false);
  });
});

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
 *
 * (Moved from `src/architecture/invariants-config.test.ts` — PR #1459
 * CodeRabbit finding 3: tests targeting `exarchos-config-schema.ts`
 * belong in `src/config/` per the repo's co-located-tests convention.)
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
