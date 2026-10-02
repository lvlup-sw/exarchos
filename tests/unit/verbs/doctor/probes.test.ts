import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  buildProbes,
  DEFAULT_CHECK_BUDGET_MS,
  resolveInvariantsCatalog,
} from '../../../../src/verbs/doctor/probes.js';
import { ReservedNamespaceError } from '../../../../src/architecture/catalog-merge.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/** Minimal DispatchContext fake. Only fields buildProbes reads are set. */
function fakeContext(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    stateDir: '/tmp/state-dir',
    eventStore: { append: () => {} } as unknown as DispatchContext['eventStore'],
    enableTelemetry: false,
    ...overrides,
  };
}

describe('buildProbes', () => {
  it('BuildProbes_FromDispatchContext_ReturnsProbesWithDetectorBound', () => {
    const ctx = fakeContext();

    const probes = buildProbes(ctx);

    expect(typeof probes.detector).toBe('function');
  });

  it('BuildProbes_FromDispatchContext_ReturnsProbesWithEventStoreBound', () => {
    const marker = { append: () => {}, __marker: 'identity' };
    const ctx = fakeContext({ eventStore: marker as unknown as DispatchContext['eventStore'] });

    const probes = buildProbes(ctx);

    expect(probes.eventStore).toBe(marker);
  });

  it('BuildProbes_FromDispatchContext_ReturnsGitProbeWithWhichIsRepoAndVersion', () => {
    const ctx = fakeContext();

    const probes = buildProbes(ctx);

    expect(typeof probes.git.which).toBe('function');
    expect(typeof probes.git.isRepo).toBe('function');
    expect(typeof probes.git.version).toBe('function');
  });

  it('BuildProbes_FromDispatchContext_ReturnsSkillsAndPluginProbesBound', () => {
    const ctx = fakeContext();

    const probes = buildProbes(ctx);

    expect(typeof probes.skills.guardStatus).toBe('function');
    expect(typeof probes.plugin.installedVersion).toBe('function');
    expect(typeof probes.plugin.runningVersion).toBe('function');
  });

  it('BuildProbes_SqliteRunIntegrityCheck_DelegatesToEventStore', async () => {
    const sentinel = { ok: 'skipped' as const, reason: 'test-marker' };
    const recorded: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
    const fakeStore = {
      append: () => {},
      runIntegrityCheck: async (opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
        recorded.push(opts ?? {});
        return sentinel;
      },
    };
    const ctx = fakeContext({ eventStore: fakeStore as unknown as DispatchContext['eventStore'] });

    const probes = buildProbes(ctx);
    const result = await probes.sqlite.runIntegrityCheck({ timeoutMs: 777 });

    expect(result).toBe(sentinel);
    expect(recorded).toEqual([{ timeoutMs: 777 }]);
  });

  /**
   * The store has two integrity accessors. Each fake returns its own sentinel, so the test proves that the
   * probe reaches the bundle sweep and not the sqlite pragma.
   */
  it('BuildProbes_BundlesRunIntegrityCheck_DelegatesToTheBundleSweepNotTheSqlitePragma', async () => {
    const bundleSentinel = { ok: 'skipped' as const, reason: 'bundle-sweep-marker' };
    const sqliteSentinel = { ok: 'skipped' as const, reason: 'sqlite-pragma-marker' };
    const fakeStore = {
      append: () => {},
      runIntegrityCheck: vi.fn(async () => sqliteSentinel),
      runBundleIntegrityCheck: vi.fn(
        async (_opts?: { signal?: AbortSignal; timeoutMs?: number }) => bundleSentinel,
      ),
    };
    const ctx = fakeContext({ eventStore: fakeStore as unknown as DispatchContext['eventStore'] });

    const probes = buildProbes(ctx);
    const result = await probes.bundles.runIntegrityCheck({ timeoutMs: 555 });

    expect(result).toBe(bundleSentinel);
    expect(fakeStore.runBundleIntegrityCheck).toHaveBeenCalledTimes(1);
    expect(fakeStore.runBundleIntegrityCheck).toHaveBeenCalledWith({ timeoutMs: 555 });
    expect(fakeStore.runIntegrityCheck).not.toHaveBeenCalled();
  });

  /**
   * The bundle carries the per-check budget, so a bounded check can size its sweep under its ceiling.
   * The composer overrides the value per run. The factory value is the composer default.
   */
  it('BuildProbes_CarriesTheComposersDefaultCheckBudget', () => {
    const probes = buildProbes(fakeContext());
    expect(probes.checkBudgetMs).toBe(DEFAULT_CHECK_BUDGET_MS);
    expect(DEFAULT_CHECK_BUDGET_MS).toBeGreaterThan(0);
  });
});

/**
 * Each test enters a temp dir and leaves it before the removal. Windows locks the cwd of the process, so `rmrf`
 * of the current dir throws EPERM. The `afterEach` hook runs too late to prevent that.
 */
describe('buildProbes invariants.resolve — cwd-relative root resolution (#1482)', () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  /**
   * The resolver must find `.exarchos.yml` from the cwd, not from this module. In plugin mode the module has no
   * `.exarchos.yml` ancestor. From a temp dir with no config, the resolver must report not configured.
   * A module-relative lookup finds the repo config and fails this test.
   */
  it('Resolve_CwdHasNoExarchosYmlAncestor_ReturnsNotConfigured', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-no-cfg-'));
    process.chdir(tmp);
    try {
      const probes = buildProbes(fakeContext());
      const result = await probes.invariants.resolve();
      expect(result.configured).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      rmrf(tmp);
    }
  });

  /**
   * The `configured` value does not depend on the phase. A declared user catalog counts as configured with zero entries.
   * The loader requires the empty `invariants:` array in the frontmatter.
   */
  it('Resolve_UserCatalogDeclared_ReportsConfiguredRegardlessOfEntries', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-user-cat-'));
    fs.writeFileSync(path.join(tmp, 'my-catalog.md'), '---\ninvariants: []\n---\n');
    fs.writeFileSync(
      path.join(tmp, '.exarchos.yml'),
      'invariants:\n  catalogs:\n    - ./my-catalog.md\n',
    );
    process.chdir(tmp);
    try {
      const probes = buildProbes(fakeContext());
      const result = await probes.invariants.resolve();
      expect(result.configured).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      rmrf(tmp);
    }
  });

  /**
   * A user catalog that claims a reserved id gets an advisory that names the file and the id.
   * The dev tier owns the reserved prefixes. The probe reports the error and does not crash.
   */
  it('DoctorInvariantsCatalog_UserSourceReservedId_EmitsAdvisory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-reserved-'));
    fs.writeFileSync(
      path.join(tmp, 'team-catalog.md'),
      [
        '---',
        'schema-version: 3',
        'invariants:',
        '  - id: INV-42',
        '    dimension: lint',
        '    axis: substrate',
        '    cost-of-load: always-load',
        '    applies-to:',
        '      - src/**',
        '    summary: A user source squatting a reserved id.',
        '    references: []',
        '---',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmp, '.exarchos.yml'),
      'invariants:\n  catalogs:\n    - ./team-catalog.md\n',
    );
    process.chdir(tmp);
    try {
      const probes = buildProbes(fakeContext());
      const result = await probes.invariants.resolve();
      expect(result.configured).toBe(true);
      const advisory = result.warnings.find(
        (w) =>
          w.includes('team-catalog.md') &&
          w.includes('INV-42') &&
          w.includes('reserved'),
      );
      expect(advisory).toBeDefined();
    } finally {
      process.chdir(originalCwd);
      rmrf(tmp);
    }
  });

  /**
   * When catalog resolution throws `ReservedNamespaceError`, the probe folds the error into a named advisory.
   * An injected resolver throws to reach the catch path directly.
   */
  it('DoctorInvariantsCatalog_ResolverThrowsReservedNamespace_FoldsToAdvisory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-throw-'));
    fs.writeFileSync(path.join(tmp, 'team-catalog.md'), '---\ninvariants: []\n---\n');
    fs.writeFileSync(
      path.join(tmp, '.exarchos.yml'),
      'invariants:\n  catalogs:\n    - ./team-catalog.md\n',
    );
    process.chdir(tmp);
    try {
      const result = await resolveInvariantsCatalog(undefined, () => {
        throw new ReservedNamespaceError('SDLC-77');
      });
      expect(result.configured).toBe(true);
      const advisory = result.warnings.find((w) => w.includes('SDLC-77'));
      expect(advisory).toBeDefined();
    } finally {
      process.chdir(originalCwd);
      rmrf(tmp);
    }
  });
});

/**
 * The doctor `configured` signal asks `resolveCatalogSources` one question: is a catalog registered?
 * A `tier: dev` registration and a `tier: user` registration count the same.
 * The schema turns a legacy `devCatalog:` config into a normal registration before the probe reads it.
 */
describe('resolveInvariantsCatalog — registration gating (DR-31 / T-43)', () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  function fixture(configYaml: string, catalogName = 'cat.md'): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-reg-'));
    fs.writeFileSync(path.join(tmp, catalogName), '---\ninvariants: []\n---\n');
    fs.writeFileSync(path.join(tmp, '.exarchos.yml'), configYaml);
    return tmp;
  }

  async function resolveIn(tmp: string) {
    process.chdir(tmp);
    try {
      return await resolveInvariantsCatalog();
    } finally {
      process.chdir(originalCwd);
    }
  }

  /**
   * A `tier: dev` registration, the form in the root `.exarchos.yml` of this repository, must report configured.
   * Remove the registration question from `probes.ts` and this test fails.
   */
  it('DoctorInvariantsCatalog_DevTierRegistration_ReportsConfigured', async () => {
    const tmp = fixture(
      'invariants:\n  catalogs:\n    - { path: ./cat.md, tier: dev }\n',
    );
    try {
      const result = await resolveIn(tmp);
      expect(result.configured).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      rmrf(tmp);
    }
  });

  /**
   * A repo with an `.exarchos.yml` must be able to report `configured: false`. Otherwise a probe that always
   * returns `true` passes the test above. An empty `catalogs` list registers nothing.
   */
  it('DoctorInvariantsCatalog_NoRegistration_ReportsNotConfigured', async () => {
    const tmp = fixture('invariants:\n  catalogs: []\n');
    try {
      const result = await resolveIn(tmp);
      expect(result.configured).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      rmrf(tmp);
    }
  });

  /**
   * The test runs the real `loadExarchosConfig`, schema, and probe path on a config with only the alias.
   * The schema turns the alias into `{ path: .exarchos/invariants.md, tier: dev }`, so the probe reports configured.
   * The deprecation reaches the operator as a warning that names the key and the replacement.
   * It is the only warning, so the catalog itself loaded without error.
   */
  it('DoctorInvariantsCatalog_LegacyDevCatalogAlias_ReportsConfiguredAndWarns', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-alias-'));
    fs.mkdirSync(path.join(tmp, '.exarchos'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.exarchos', 'invariants.md'),
      '---\ninvariants: []\n---\n',
    );
    fs.writeFileSync(path.join(tmp, '.exarchos.yml'), 'invariants:\n  devCatalog: enabled\n');
    try {
      const result = await resolveIn(tmp);
      expect(result.configured).toBe(true);
      const deprecation = result.warnings.find((w) =>
        w.includes('invariants.devCatalog'),
      );
      expect(deprecation).toBeDefined();
      expect(deprecation).toContain('.exarchos/invariants.md');
      expect(result.warnings).toHaveLength(1);
    } finally {
      rmrf(tmp);
    }
  });

  /**
   * A positive control for the deprecation channel. The fixture matches the alias fixture except for the config,
   * and it must give zero warnings. Together the two tests show that the channel is live and discriminates.
   */
  it('DoctorInvariantsCatalog_CleanConfig_EmitsNoDeprecation', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-clean-'));
    fs.mkdirSync(path.join(tmp, '.exarchos'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.exarchos', 'invariants.md'),
      '---\ninvariants: []\n---\n',
    );
    fs.writeFileSync(
      path.join(tmp, '.exarchos.yml'),
      'invariants:\n  catalogs:\n    - { path: .exarchos/invariants.md, tier: dev }\n',
    );
    try {
      const result = await resolveIn(tmp);
      expect(result.configured).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      rmrf(tmp);
    }
  });
});
