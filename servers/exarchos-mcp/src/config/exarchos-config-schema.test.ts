import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  ExarchosConfigSchema,
  InvariantsConfigSchema,
  collectConfigDeprecations,
  DEV_CATALOG_PATH,
  DEV_CATALOG_DEPRECATION_CODE,
} from './exarchos-config-schema.js';
import { resolveCatalogSources } from '../architecture/catalog-sources.js';

describe('ExarchosConfigSchema — toolchains (tier 3)', () => {
  it('accepts a user-declared toolchain with markers + commands', () => {
    const result = ExarchosConfigSchema.safeParse({
      toolchains: [
        { id: 'zig', markers: ['build.zig'], commands: { test: 'zig build test' } },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolchains?.[0]?.id).toBe('zig');
      expect(result.data.toolchains?.[0]?.commands.test).toBe('zig build test');
    }
  });

  it('accepts an extension-glob marker', () => {
    const result = ExarchosConfigSchema.safeParse({
      toolchains: [{ id: 'haskell', markers: ['*.cabal'], commands: { test: 'cabal test' } }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty markers array', () => {
    const result = ExarchosConfigSchema.safeParse({
      toolchains: [{ id: 'x', markers: [], commands: { test: 'x' } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a path-traversal marker', () => {
    const result = ExarchosConfigSchema.safeParse({
      toolchains: [{ id: 'x', markers: ['../../etc/passwd'], commands: { test: 'x' } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a command with shell metacharacters', () => {
    const result = ExarchosConfigSchema.safeParse({
      toolchains: [{ id: 'x', markers: ['x.toml'], commands: { test: 'rm -rf / ; echo pwned' } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key inside a toolchain entry (strict)', () => {
    const result = ExarchosConfigSchema.safeParse({
      toolchains: [{ id: 'x', markers: ['x.toml'], commands: {}, bogus: true }],
    });
    expect(result.success).toBe(false);
  });
});

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
 * Invariants-catalog config surface.
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
/**
 * DR-31 / T-43 — `invariants.devCatalog` retired as a deprecated ALIAS.
 *
 * ## What replaced what
 *
 * The key used to be a live, repo-only gate: `resolveCatalogSources` read the
 * boolean directly and synthesized a privileged catalog source from it (DR-31
 * site 2). T-42 deleted that branch. T-43 finishes the job at the config
 * boundary:
 *
 *   - the key is GONE from the parsed shape — `InvariantsConfigSchema`
 *     desugars it away, so no production reader can gate on the boolean (the
 *     doctor probe that did, `verbs/doctor/probes.ts`, became a compile
 *     error and now asks the registration question instead);
 *   - it is RETAINED on the INPUT shape as a deprecated alias, because the
 *     schema is `.strict()` and `loadExarchosConfig` THROWS on an unknown key
 *     — deleting it outright would hard-fail config load on upgrade for every
 *     consumer who ever wrote it;
 *   - `devCatalog: 'enabled'` desugars to exactly the registration it was
 *     always sugar for, `{ path: .exarchos/invariants.md, tier: dev }`, so an
 *     un-migrated consumer keeps the catalog they had instead of silently
 *     losing it;
 *   - `collectConfigDeprecations` reports it as a TYPED deprecation the doctor
 *     surfaces, so the operator learns the replacement edit.
 *
 * ## Oracle structure (DR-30) — two authorities, never a self-comparison
 *
 *   - **Authority 1 (subject):** the production parse+discovery pipeline —
 *     `ExarchosConfigSchema` → `resolveCatalogSources`.
 *   - **Authority 2 (expectation):** `normalizeVerbatim` below, a
 *     re-implementation of the documented normalization contract applied to
 *     the `catalogs:` list sliced verbatim out of the RAW `.exarchos.yml`
 *     text. It shares no code with the subject.
 */
describe('ExarchosConfigSchema — invariants.devCatalog retirement (DR-31 / T-43)', () => {
  const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
  );
  const REPO_CONFIG_PATH = path.join(REPO_ROOT, '.exarchos.yml');

  /** The RAW, unparsed `.exarchos.yml` document this repository ships. */
  function rawRepoDocument(): Record<string, unknown> {
    expect(
      fs.existsSync(REPO_CONFIG_PATH),
      `real repo config missing at ${REPO_CONFIG_PATH}`,
    ).toBe(true);
    const doc: unknown = parseYaml(fs.readFileSync(REPO_CONFIG_PATH, 'utf8'));
    expect(typeof doc === 'object' && doc !== null).toBe(true);
    return doc as Record<string, unknown>;
  }

  /** Raw `invariants:` block, mutated by `mutate`. Never re-uses parsed data. */
  function rawInvariantsBlock(
    mutate: (b: Record<string, unknown>) => void = () => {},
  ): Record<string, unknown> {
    const block = structuredClone(rawRepoDocument().invariants);
    expect(
      typeof block === 'object' && block !== null,
      'real .exarchos.yml declares no `invariants:` block — the subject of ' +
        'this oracle does not exist',
    ).toBe(true);
    const next = block as Record<string, unknown>;
    mutate(next);
    return next;
  }

  /**
   * AUTHORITY 2 — the documented normalization contract, re-implemented here:
   * bare string ⇒ `tier: 'user'`; object ⇒ `tier ?? 'user'`. No call into
   * `resolveCatalogSources`, no call into the schema.
   */
  function normalizeVerbatim(
    block: Record<string, unknown>,
  ): Array<{ path: string; tier: string }> {
    const raw = (block.catalogs ?? []) as Array<
      string | { path: string; tier?: string }
    >;
    return raw.map((r) =>
      typeof r === 'string'
        ? { path: r, tier: 'user' }
        : { path: r.path, tier: r.tier ?? 'user' },
    );
  }

  /** AUTHORITY 1 — parse an `invariants:` block, then discover its sources. */
  function parseThenResolve(
    block: Record<string, unknown>,
  ): Array<{ path: string; tier: string }> {
    const parsed = ExarchosConfigSchema.safeParse({ invariants: block });
    expect(
      parsed.success,
      'config failed the production schema: ' +
        (parsed.success ? '' : JSON.stringify(parsed.error.issues)),
    ).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    return resolveCatalogSources(parsed.data);
  }

  it('ExarchosConfig_DevCatalogRemoved_EffectiveCatalogUnchanged', () => {
    // THE DR-31 ACCEPTANCE PROPERTY, at the config boundary, on the REAL repo
    // config. Both metamorphic directions are asserted so this stays
    // load-bearing whichever way the committed file goes: T-43 deleted the key
    // from disk, so `withoutFlag` is what ships and `withFlag` is the
    // pre-T-43 file reconstructed.
    const withoutFlag = rawInvariantsBlock((b) => {
      delete b.devCatalog;
    });
    const withFlag = rawInvariantsBlock((b) => {
      b.devCatalog = 'enabled';
    });

    // NON-VACUITY 1: the metamorphic pair must genuinely differ, or the
    // equality below is a tautology over two identical inputs.
    expect(withFlag).not.toEqual(withoutFlag);
    expect(withFlag).toHaveProperty('devCatalog', 'enabled');
    expect(withoutFlag).not.toHaveProperty('devCatalog');

    // NON-VACUITY 2: the independent expectation is non-empty, so "unchanged"
    // cannot be satisfied by a pipeline that resolves nothing at all.
    const expected = normalizeVerbatim(withoutFlag);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected).toContainEqual({ path: DEV_CATALOG_PATH, tier: 'dev' });

    // The property: identical effective sources with and without the key, and
    // both agree with the independently-derived expectation.
    expect(parseThenResolve(withoutFlag)).toEqual(expected);
    expect(parseThenResolve(withFlag)).toEqual(expected);

    // NON-VACUITY 3 (POSITIVE CONTROL — the T-42 lesson). The three equalities
    // above are all "resolves the same" assertions; they would ALL still hold
    // if `parseThenResolve` were wired to something that never reads config.
    // Break the input and the resolution must collapse — proving the machinery
    // under the equalities actually ran and is config-sensitive.
    const noRegistration = rawInvariantsBlock((b) => {
      delete b.devCatalog;
      delete b.catalogs;
    });
    expect(parseThenResolve(noRegistration)).toEqual([]);
    expect(normalizeVerbatim(noRegistration)).toEqual([]);
  });

  it('ExarchosConfig_LegacyDevCatalogKey_EmitsTypedDeprecation', () => {
    // A consumer who never migrated: the alias and NOTHING else.
    const legacyDocument = { invariants: { devCatalog: 'enabled' } };

    const deprecations = collectConfigDeprecations(legacyDocument);
    expect(deprecations).toHaveLength(1);
    const [d] = deprecations;

    // TYPED, not prose: a surface can branch on `code` and render
    // `replacement` as a concrete edit without regex-matching the message.
    expect(d!.code).toBe(DEV_CATALOG_DEPRECATION_CODE);
    expect(d!.key).toBe('invariants.devCatalog');
    expect(d!.replacement).toEqual({ path: DEV_CATALOG_PATH, tier: 'dev' });
    expect(d!.message).toContain('deprecated');
    expect(d!.message).toContain(DEV_CATALOG_PATH);

    // AND THE DESUGARING IT ADVERTISES ACTUALLY HAPPENS. Cross-checking the
    // diagnostic against the transform is what stops the deprecation from
    // being a lie: the replacement it names must be the registration the
    // schema really produces, derived from the parse, not from the message.
    const parsed = ExarchosConfigSchema.safeParse(legacyDocument);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(resolveCatalogSources(parsed.data)).toEqual([d!.replacement]);

    // The key itself is gone from the parsed shape — nothing downstream can
    // gate on the boolean.
    expect(parsed.data.invariants).not.toHaveProperty('devCatalog');

    // POSITIVE CONTROL for the negative half: `collectConfigDeprecations`
    // returning `[]` must MEAN something. A config with no deprecated key is
    // clean, and — the point of T-43 — so is this repository's own committed
    // config. If the key ever creeps back into `.exarchos.yml`, this reddens.
    expect(collectConfigDeprecations({ invariants: { catalogs: [] } })).toEqual([]);
    expect(collectConfigDeprecations(rawRepoDocument())).toEqual([]);
  });

  it('ExarchosConfig_DevCatalogDisabled_DeprecatedWithNoRegistration', () => {
    // `disabled` was only ever the default restated, so it desugars to NOTHING
    // — but it is still a retired key, so it still reports, with a null
    // replacement (there is no registration to suggest).
    const doc = { invariants: { devCatalog: 'disabled' } };
    const [d] = collectConfigDeprecations(doc);
    expect(d!.code).toBe(DEV_CATALOG_DEPRECATION_CODE);
    expect(d!.replacement).toBeNull();

    const parsed = ExarchosConfigSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(resolveCatalogSources(parsed.data)).toEqual([]);
    expect(parsed.data.invariants).not.toHaveProperty('devCatalog');
  });

  it('ExarchosConfig_LegacyDevCatalogKey_AcceptedNotRejected', () => {
    // THE BACK-COMPAT CONTRACT, pinned so a flip is caught. The schema is
    // `.strict()` and `loadExarchosConfig` throws on validation failure, so
    // removing `devCatalog` from the schema outright would turn every
    // un-migrated `.exarchos.yml` into a hard config-load failure on upgrade.
    // The alias is retained precisely to prevent that. This test reddens if
    // the key is ever made unknown (rejected) OR if the alias is silently
    // widened to accept junk.
    expect(
      ExarchosConfigSchema.safeParse({ invariants: { devCatalog: 'enabled' } })
        .success,
    ).toBe(true);
    expect(
      ExarchosConfigSchema.safeParse({ invariants: { devCatalog: 'disabled' } })
        .success,
    ).toBe(true);

    // The discriminating half: a genuinely-unknown sibling key IS rejected, so
    // the acceptance above is the alias being honoured and not `.strict()`
    // having quietly gone slack.
    expect(
      ExarchosConfigSchema.safeParse({ invariants: { devCatalogue: 'enabled' } })
        .success,
    ).toBe(false);
  });

  it('ExarchosConfig_AliasAndExplicitRegistration_DedupeToOneDevSource', () => {
    // The shape this repo shipped BEFORE T-43: the alias AND the explicit
    // registration for the same path. The desugar carries over the retired
    // branch's `(path, tier: 'dev')` dedupe, so the catalog is registered
    // ONCE — a second copy would double-load it.
    const parsed = ExarchosConfigSchema.safeParse({
      invariants: {
        devCatalog: 'enabled',
        catalogs: [{ path: DEV_CATALOG_PATH, tier: 'dev' }],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(resolveCatalogSources(parsed.data)).toEqual([
      { path: DEV_CATALOG_PATH, tier: 'dev' },
    ]);
  });

  it('ExarchosConfig_AliasWithUnrelatedRegistrations_AppendsWithoutClobbering', () => {
    // The alias is ADDITIVE: a consumer's own registrations survive it, and
    // the desugared dev entry lands after them. Without this, the desugar
    // could pass the dedupe test above by simply replacing the list.
    const parsed = ExarchosConfigSchema.safeParse({
      invariants: {
        devCatalog: 'enabled',
        catalogs: ['team.md', { path: 'ops.md', tier: 'user' }],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(resolveCatalogSources(parsed.data)).toEqual([
      { path: 'team.md', tier: 'user' },
      { path: 'ops.md', tier: 'user' },
      { path: DEV_CATALOG_PATH, tier: 'dev' },
    ]);
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
    // An operator who never declared the `invariants:` block must get
    // `undefined`, not a synthetic placeholder block.
    const result = ExarchosConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invariants).toBeUndefined();
    }
  });

  it('ExarchosConfig_InvariantsBlockWithoutDevCatalog_Validates', () => {
    // The `invariants:` block may exist empty — the post-T-43 canonical shape
    // for a repo that has not registered anything yet.
    const result = ExarchosConfigSchema.safeParse({ invariants: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invariants).toBeDefined();
      expect(result.data.invariants).not.toHaveProperty('devCatalog');
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

// T-18 (DR-6) — additive `invariants` config keys: `catalogs`,
// `overrides`, `enforcement`. These extend the canonical
// `InvariantsConfigSchema` for user-authored catalog files, per-invariant
// severity/enabled tuning, and per-phase enforcement, while preserving
// the `.strict()` posture. (T-43: `devCatalog` is no longer among the
// preserved OUTPUT keys — it is a deprecated input-only alias, covered by
// the DR-31 block above.)
describe('InvariantsConfigSchema — additive keys (T-18 / DR-6)', () => {
  it('InvariantsConfigSchema_NewKeys_ParseAndStrictReject', () => {
    const ok = InvariantsConfigSchema.safeParse({
      devCatalog: 'enabled',
      catalogs: ['.exarchos/invariants.yml'],
      overrides: {
        'SDLC-3': { severity: 'advisory' },
        'SDLC-7': { enabled: false },
      },
      enforcement: { review: 'blocking' },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      // T-43: the alias is desugared away — absent from the output, and its
      // registration appended to the operator's own `catalogs:` list.
      expect(ok.data).not.toHaveProperty('devCatalog');
      expect(ok.data.catalogs).toEqual([
        '.exarchos/invariants.yml',
        { path: DEV_CATALOG_PATH, tier: 'dev' },
      ]);
      expect(ok.data.overrides?.['SDLC-3']?.severity).toBe('advisory');
      expect(ok.data.overrides?.['SDLC-7']?.enabled).toBe(false);
      expect(ok.data.enforcement?.review).toBe('blocking');
    }

    // Unknown top-level key under `invariants` is rejected by `.strict()`.
    const unknownTop = InvariantsConfigSchema.safeParse({
      devCatalog: 'enabled',
      bogus: true,
    });
    expect(unknownTop.success).toBe(false);

    // Unknown nested key inside an override is rejected by `.strict()`.
    const unknownNested = InvariantsConfigSchema.safeParse({
      overrides: { 'SDLC-3': { severity: 'advisory', bogus: true } },
    });
    expect(unknownNested.success).toBe(false);
  });
});

// invariants-catalog-wizard (P1, T1) — `catalogs` accepts tiered registration
// objects. The migration collapses the dev catalog onto the registered-catalog
// pattern, so a registration may carry an explicit `tier` (dev | user) in
// addition to the legacy bare-string form.
describe('InvariantsConfigSchema — tiered catalog registrations (T1)', () => {
  it('InvariantsConfigSchema_CatalogObject_ParsesPathAndTier', () => {
    // A `{ path, tier }` object and a bare string coexist in the same array.
    const result = InvariantsConfigSchema.safeParse({
      catalogs: [
        { path: '.exarchos/invariants.md', tier: 'dev' },
        '.exarchos/invariants.yml',
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.catalogs).toEqual([
        { path: '.exarchos/invariants.md', tier: 'dev' },
        '.exarchos/invariants.yml',
      ]);
    }

    // `tier` is optional on the object form (defaults to user downstream).
    const tierless = InvariantsConfigSchema.safeParse({
      catalogs: [{ path: 'team.yml' }],
    });
    expect(tierless.success).toBe(true);

    // Unknown keys on the object form are rejected by `.strict()`.
    const unknownKey = InvariantsConfigSchema.safeParse({
      catalogs: [{ path: 'team.yml', bogus: true }],
    });
    expect(unknownKey.success).toBe(false);
  });

  it('InvariantsConfigSchema_CatalogTier_RejectsUnknownTier', () => {
    const result = InvariantsConfigSchema.safeParse({
      catalogs: [{ path: 'team.yml', tier: 'bogus' }],
    });
    expect(result.success).toBe(false);
  });
});

// ─── verification-ladder slice 1, task 024: ownership manifest ──────────────
//
// The `ownership.firstParty` globs declare which trees in a repo are
// first-party (authored-here) source — the input the import-boundary lint
// (SIV-3 Layer A, task 027) and ownership-aware gates scope themselves to.
// Absent the key, the schema applies a documented default that covers the
// repo's own source trees (`src/**` + `servers/*/src/**`) so a config-free
// repo still gets a sane first-party scope rather than an empty one.
describe('ExarchosConfigSchema — ownership manifest (slice 1, task 024)', () => {
  it('ExarchosConfig_OwnershipGlobs_Parsed', () => {
    const result = ExarchosConfigSchema.safeParse({
      ownership: { firstParty: ['src/**', 'servers/**'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownership.firstParty).toEqual(['src/**', 'servers/**']);
    }
  });

  it('ExarchosConfig_OwnershipAbsent_DefaultsToRepoSrcTrees', () => {
    // Absent `ownership:` → documented default first-party scope. The default
    // is applied at parse time so every consumer reads a populated array
    // rather than re-deriving the fallback at each call site.
    const result = ExarchosConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownership.firstParty).toEqual([
        'src/**',
        'servers/*/src/**',
      ]);
    }
  });

  it('ExarchosConfig_OwnershipFirstPartyAbsent_DefaultsWithinBlock', () => {
    // Declaring an empty `ownership:` block (no `firstParty`) still yields the
    // documented default — the default lives on `firstParty`, not only on a
    // missing top-level block.
    const result = ExarchosConfigSchema.safeParse({ ownership: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownership.firstParty).toEqual([
        'src/**',
        'servers/*/src/**',
      ]);
    }
  });

  it('ExarchosConfig_OwnershipUnknownField_Rejected', () => {
    // `.strict()` on the nested block rejects typos so an operator who writes
    // `ownership: { firstparty: [...] }` (case typo) sees a validation error
    // rather than a silently-ignored field that defaults underneath it.
    const result = ExarchosConfigSchema.safeParse({
      ownership: { firstparty: ['src/**'] },
    });
    expect(result.success).toBe(false);
  });

  it('ExarchosConfig_OwnershipFirstPartyTypeMismatch_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({
      ownership: { firstParty: 'src/**' },
    });
    expect(result.success).toBe(false);
  });
});
