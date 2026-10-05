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
} from '../../../src/config/exarchos-config-schema.js';
import { resolveCatalogSources } from '../../../src/architecture/catalog-sources.js';

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
    const result = ExarchosConfigSchema.safeParse({ test: 'bun test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handoffLint).toBeUndefined();
    }
  });

  /** `hardfail` is a lowercase typo of `hardFail`. */
  it('schema_HandoffLintUnknownField_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({
      handoffLint: { hardfail: true },
    });
    expect(result.success).toBe(false);
  });

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

  /** A 0 ms interval makes the loop spin. */
  it('schema_CliFollowPollIntervalMs_RejectsZero', () => {
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
    const result = ExarchosConfigSchema.safeParse({
      cli: { followPollIntervalMs: 12.5 },
    });
    expect(result.success).toBe(false);
  });

  it('schema_CliBlockAbsent_Validates', () => {
    const result = ExarchosConfigSchema.safeParse({ test: 'bun test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cli).toBeUndefined();
    }
  });

  /** `followPollIntervalMS` is a case typo of `followPollIntervalMs`. */
  it('schema_CliUnknownField_Rejected', () => {
    const result = ExarchosConfigSchema.safeParse({
      cli: { followPollIntervalMS: 100 },
    });
    expect(result.success).toBe(false);
  });
});

/**
 * `invariants.devCatalog` is a deprecated input alias. The schema is strict and
 * `loadExarchosConfig` throws on an unknown key, so the schema must still accept the key.
 * The parse removes it, and `enabled` becomes `{ path: DEV_CATALOG_PATH, tier: 'dev' }`.
 * `collectConfigDeprecations` reports the key as a typed deprecation.
 *
 * `parseThenResolve` is the subject: the schema parse, then `resolveCatalogSources`.
 * `normalizeVerbatim` is the independent expectation, and it calls no production code.
 * It reads the raw `invariants:` block of the repository `.exarchos.yml`. A bare string
 * gets `tier: 'user'`, and an object gets `tier ?? 'user'`.
 */
describe('ExarchosConfigSchema — invariants.devCatalog retirement (DR-31 / T-43)', () => {
  const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..');
  const REPO_CONFIG_PATH = path.join(REPO_ROOT, '.exarchos.yml');

  function rawRepoDocument(): Record<string, unknown> {
    expect(
      fs.existsSync(REPO_CONFIG_PATH),
      `real repo config missing at ${REPO_CONFIG_PATH}`,
    ).toBe(true);
    const doc: unknown = parseYaml(fs.readFileSync(REPO_CONFIG_PATH, 'utf8'));
    expect(typeof doc === 'object' && doc !== null).toBe(true);
    return doc as Record<string, unknown>;
  }

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

  /**
   * On the real repository config, the effective catalog sources are the same with and
   * without the key. Three controls prevent a vacuous pass. The two inputs differ. The
   * expectation is not empty. A block with no `catalogs` resolves to `[]`.
   */
  it('ExarchosConfig_DevCatalogRemoved_EffectiveCatalogUnchanged', () => {
    const withoutFlag = rawInvariantsBlock((b) => {
      delete b.devCatalog;
    });
    const withFlag = rawInvariantsBlock((b) => {
      b.devCatalog = 'enabled';
    });

    expect(withFlag).not.toEqual(withoutFlag);
    expect(withFlag).toHaveProperty('devCatalog', 'enabled');
    expect(withoutFlag).not.toHaveProperty('devCatalog');

    const expected = normalizeVerbatim(withoutFlag);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected).toContainEqual({ path: DEV_CATALOG_PATH, tier: 'dev' });

    expect(parseThenResolve(withoutFlag)).toEqual(expected);
    expect(parseThenResolve(withFlag)).toEqual(expected);

    const noRegistration = rawInvariantsBlock((b) => {
      delete b.devCatalog;
      delete b.catalogs;
    });
    expect(parseThenResolve(noRegistration)).toEqual([]);
    expect(normalizeVerbatim(noRegistration)).toEqual([]);
  });

  /**
   * The deprecation is typed: a consumer can branch on `code` and show `replacement`.
   * The replacement must equal the registration that the parse produces. The last two checks
   * give the empty result a meaning: a clean config and the repository config report nothing.
   */
  it('ExarchosConfig_LegacyDevCatalogKey_EmitsTypedDeprecation', () => {
    const legacyDocument = { invariants: { devCatalog: 'enabled' } };

    const deprecations = collectConfigDeprecations(legacyDocument);
    expect(deprecations).toHaveLength(1);
    const [d] = deprecations;

    expect(d!.code).toBe(DEV_CATALOG_DEPRECATION_CODE);
    expect(d!.key).toBe('invariants.devCatalog');
    expect(d!.replacement).toEqual({ path: DEV_CATALOG_PATH, tier: 'dev' });
    expect(d!.message).toContain('deprecated');
    expect(d!.message).toContain(DEV_CATALOG_PATH);

    const parsed = ExarchosConfigSchema.safeParse(legacyDocument);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(resolveCatalogSources(parsed.data)).toEqual([d!.replacement]);

    expect(parsed.data.invariants).not.toHaveProperty('devCatalog');

    expect(collectConfigDeprecations({ invariants: { catalogs: [] } })).toEqual([]);
    expect(collectConfigDeprecations(rawRepoDocument())).toEqual([]);
  });

  /** `disabled` adds no registration, but the key still reports, with a `null` replacement. */
  it('ExarchosConfig_DevCatalogDisabled_DeprecatedWithNoRegistration', () => {
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

  /**
   * The schema must accept the alias, or an old `.exarchos.yml` fails to load after an
   * upgrade. The misspelled sibling key `devCatalogue` must still fail, which shows that
   * the schema stays strict.
   */
  it('ExarchosConfig_LegacyDevCatalogKey_AcceptedNotRejected', () => {
    expect(
      ExarchosConfigSchema.safeParse({ invariants: { devCatalog: 'enabled' } })
        .success,
    ).toBe(true);
    expect(
      ExarchosConfigSchema.safeParse({ invariants: { devCatalog: 'disabled' } })
        .success,
    ).toBe(true);

    expect(
      ExarchosConfigSchema.safeParse({ invariants: { devCatalogue: 'enabled' } })
        .success,
    ).toBe(false);
  });

  /** The alias and an equal explicit registration give one source, not two. */
  it('ExarchosConfig_AliasAndExplicitRegistration_DedupeToOneDevSource', () => {
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

  /**
   * The alias appends after the other registrations. A conversion that replaces the list
   * passes the dedupe test, so this test covers that case.
   */
  it('ExarchosConfig_AliasWithUnrelatedRegistrations_AppendsWithoutClobbering', () => {
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
    const result = ExarchosConfigSchema.safeParse({
      invariants: { devCatalog: 'invalid' },
    });
    expect(result.success).toBe(false);
  });

  it('ExarchosConfig_EmptyObject_LeavesInvariantsUndefined', () => {
    const result = ExarchosConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invariants).toBeUndefined();
    }
  });

  it('ExarchosConfig_InvariantsBlockWithoutDevCatalog_Validates', () => {
    const result = ExarchosConfigSchema.safeParse({ invariants: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invariants).toBeDefined();
      expect(result.data.invariants).not.toHaveProperty('devCatalog');
    }
  });

  /** `devcatalog` is a lowercase typo of `devCatalog`. */
  it('ExarchosConfig_RejectsUnknownInvariantsField', () => {
    const result = ExarchosConfigSchema.safeParse({
      invariants: { devcatalog: 'enabled' },
    });
    expect(result.success).toBe(false);
  });
});

/**
 * The `catalogs`, `overrides` and `enforcement` keys of the strict `InvariantsConfigSchema`.
 * The parsed output holds no `devCatalog` key.
 */
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
      expect(ok.data).not.toHaveProperty('devCatalog');
      expect(ok.data.catalogs).toEqual([
        '.exarchos/invariants.yml',
        { path: DEV_CATALOG_PATH, tier: 'dev' },
      ]);
      expect(ok.data.overrides?.['SDLC-3']?.severity).toBe('advisory');
      expect(ok.data.overrides?.['SDLC-7']?.enabled).toBe(false);
      expect(ok.data.enforcement?.review).toBe('blocking');
    }

    const unknownTop = InvariantsConfigSchema.safeParse({
      devCatalog: 'enabled',
      bogus: true,
    });
    expect(unknownTop.success).toBe(false);

    const unknownNested = InvariantsConfigSchema.safeParse({
      overrides: { 'SDLC-3': { severity: 'advisory', bogus: true } },
    });
    expect(unknownNested.success).toBe(false);
  });
});

/**
 * A catalog registration is a bare string or a `{ path, tier }` object. `tier` is `dev` or
 * `user`, and it is optional.
 */
describe('InvariantsConfigSchema — tiered catalog registrations (T1)', () => {
  it('InvariantsConfigSchema_CatalogObject_ParsesPathAndTier', () => {
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

    const tierless = InvariantsConfigSchema.safeParse({
      catalogs: [{ path: 'team.yml' }],
    });
    expect(tierless.success).toBe(true);

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

/**
 * `ownership.firstParty` holds the globs of the first-party source trees. An absent key gets
 * a default that covers the repository source trees, so the scope is never empty.
 */
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
    const result = ExarchosConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownership.firstParty).toEqual([
        'src/**',
        'servers/*/src/**',
      ]);
    }
  });

  /** The default is on the `firstParty` field too, so an empty `ownership` block gets the same globs. */
  it('ExarchosConfig_OwnershipFirstPartyAbsent_DefaultsWithinBlock', () => {
    const result = ExarchosConfigSchema.safeParse({ ownership: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownership.firstParty).toEqual([
        'src/**',
        'servers/*/src/**',
      ]);
    }
  });

  /** `firstparty` is a case typo of `firstParty`. */
  it('ExarchosConfig_OwnershipUnknownField_Rejected', () => {
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
