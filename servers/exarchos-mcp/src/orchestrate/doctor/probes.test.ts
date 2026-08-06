import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DispatchContext } from '../../core/dispatch.js';
import { buildProbes, resolveInvariantsCatalog } from './probes.js';
import { ReservedNamespaceError } from '../../architecture/catalog-merge.js';
import { rmrf } from '../../test-helpers/temp-dir.js';

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
});

describe('buildProbes invariants.resolve — cwd-relative root resolution (#1482)', () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  // Regression guard for the Seer HIGH finding: the invariants-catalog check
  // resolved `.exarchos.yml` relative to THIS MODULE, not the user's cwd. In
  // plugin mode the module lives under `~/.claude/plugins/...` (no
  // `.exarchos.yml` ancestor), so the check silently Skipped and never
  // validated the consumer's catalog. CI masked it because the module sits
  // inside this repo, which HAS a root `.exarchos.yml`.
  //
  // This test pins resolution to cwd: from a temp dir with no `.exarchos.yml`
  // ancestor the resolver must report not-configured. Under the bug,
  // module-relative resolution would find the in-repo config (which registers
  // a dev catalog) and report configured — so this fails RED on the bug, GREEN
  // on the fix.
  it('Resolve_CwdHasNoExarchosYmlAncestor_ReturnsNotConfigured', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-no-cfg-'));
    process.chdir(tmp);
    try {
      const probes = buildProbes(fakeContext());
      const result = await probes.invariants.resolve();
      expect(result.configured).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      // Leave `tmp` before removing it: on Windows the process CWD is locked,
      // so `rmrf(tmp)` while still chdir'd into it throws EPERM (the afterEach
      // chdir-back runs too late — after this finally).
      process.chdir(originalCwd);
      rmrf(tmp);
    }
  });

  // Regression for the Seer MEDIUM (#1482): `configured` must be
  // phase-INDEPENDENT. A user catalog declared in `.exarchos.yml` counts as
  // configured purely by being declared — even if it contributes zero entries
  // for any phase. The old projected-entry-count signal returned 0 here and
  // misreported a real configuration as "nothing to validate".
  it('Resolve_UserCatalogDeclared_ReportsConfiguredRegardlessOfEntries', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-user-cat-'));
    // A valid-but-empty user catalog: declared in config, loads without
    // warning, contributes zero entries (frontmatter declares an empty
    // `invariants:` array, which the loader requires).
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
      // Leave `tmp` before removing it: on Windows the process CWD is locked,
      // so `rmrf(tmp)` while still chdir'd into it throws EPERM (the afterEach
      // chdir-back runs too late — after this finally).
      process.chdir(originalCwd);
      rmrf(tmp);
    }
  });

  // P1 T5: a USER-tier catalog claiming a reserved id (`INV-*` / `SDLC-*`) must
  // surface a named advisory — the offending file AND id — without crashing the
  // check. `INV-*` belongs to the dev tier; a consumer source impersonating it
  // is a configuration error the operator needs pointed out, not a silent drop
  // and not a thrown ReservedNamespaceError that aborts the whole probe.
  it('DoctorInvariantsCatalog_UserSourceReservedId_EmitsAdvisory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-reserved-'));
    fs.writeFileSync(
      path.join(tmp, 'team-catalog.md'),
      [
        '---',
        'schema-version: 3',
        'invariants:',
        '  - id: INV-42', // reserved namespace — user tier may not claim it
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
      // Configured (a user catalog is declared) and degraded — never crashed.
      expect(result.configured).toBe(true);
      const advisory = result.warnings.find(
        (w) =>
          w.includes('team-catalog.md') &&
          w.includes('INV-42') &&
          w.includes('reserved'),
      );
      expect(advisory).toBeDefined();
    } finally {
      // Leave `tmp` before removing it: on Windows the process CWD is locked,
      // so `rmrf(tmp)` while still chdir'd into it throws EPERM (the afterEach
      // chdir-back runs too late — after this finally).
      process.chdir(originalCwd);
      rmrf(tmp);
    }
  });

  // P1 T5 (defense-in-depth): even if catalog resolution itself throws a
  // ReservedNamespaceError (e.g. a built-in layer regression that escapes the
  // resolver's own DR-9 pre-filter), the doctor probe must NOT crash — it folds
  // the error into a named advisory. Inject a throwing resolver to drive the
  // catch path directly.
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
      // Did not throw out of the probe; the error is a named advisory.
      expect(result.configured).toBe(true);
      const advisory = result.warnings.find((w) => w.includes('SDLC-77'));
      expect(advisory).toBeDefined();
    } finally {
      // Leave `tmp` before removing it: on Windows the process CWD is locked,
      // so `rmrf(tmp)` while still chdir'd into it throws EPERM (the afterEach
      // chdir-back runs too late — after this finally).
      process.chdir(originalCwd);
      rmrf(tmp);
    }
  });
});

/**
 * DR-31 / T-43 — the doctor's `configured` signal is a REGISTRATION question.
 *
 * ## Why this block exists
 *
 * `resolveInvariantsCatalog` carried the FIFTH live read of the retired
 * boolean (`config.invariants.devCatalog === 'enabled'` + a disk-existence
 * probe on a privileged path, OR'd with a user-catalog count). It was a
 * production read that **no test observed**: every pre-existing fixture in
 * this file wrote `devCatalog: disabled` alongside a user catalog, so the
 * dev branch was dead in the suite and deleting it outright would have gone
 * unnoticed. That is the defect pattern T-31 was rejected twice for. These
 * tests are the missing observation.
 *
 * The signal is now one question asked through the single discovery authority
 * `resolveCatalogSources`: *is a catalog registered?* A `tier: dev`
 * registration and a `tier: user` registration count identically, and a
 * legacy `devCatalog:` config reaches the probe only after the schema has
 * desugared it into an ordinary registration.
 */
describe('resolveInvariantsCatalog — registration gating (DR-31 / T-43)', () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  /** Write a repo fixture with a valid-but-empty catalog + the given config. */
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

  it('DoctorInvariantsCatalog_DevTierRegistration_ReportsConfigured', async () => {
    // THE GUARD ON THE REPLACED READ. A `tier: dev` REGISTRATION — the exact
    // thing this repository's own `.exarchos.yml` now carries — must report
    // configured. Under the deleted implementation this config had no
    // `devCatalog` key at all, so `devConfigured` was false and `configured`
    // rested entirely on the user-catalog count. Neutering the registration
    // question in probes.ts reddens this.
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

  it('DoctorInvariantsCatalog_NoRegistration_ReportsNotConfigured', async () => {
    // SENSITIVITY FLOOR. `configured` must be able to be FALSE for a repo that
    // HAS an `.exarchos.yml` — otherwise the assertion above is satisfied by a
    // probe that returns `true` unconditionally. An empty `invariants:` block
    // registers nothing, so the doctor Skips.
    const tmp = fixture('invariants:\n  catalogs: []\n');
    try {
      const result = await resolveIn(tmp);
      expect(result.configured).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      rmrf(tmp);
    }
  });

  it('DoctorInvariantsCatalog_LegacyDevCatalogAlias_ReportsConfiguredAndWarns', async () => {
    // BACK-COMPAT + DEPRECATION EMISSION, end to end through the real
    // `loadExarchosConfig` → schema → probe path.
    //
    // A consumer who never migrated writes the alias and nothing else. Two
    // things must happen, and neither is asserted anywhere else:
    //   (1) they keep their catalog — the schema desugars the alias into
    //       `{ path: .exarchos/invariants.md, tier: dev }`, so the probe sees
    //       a registration and reports configured (post-T-42, before this
    //       task, they would have SILENTLY lost it);
    //   (2) they are TOLD — the typed deprecation surfaces as an operator
    //       warning naming both the key and the replacement edit.
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
      // The catalog itself resolved cleanly — the deprecation is the ONLY
      // warning, so this is not a load failure wearing a deprecation's coat.
      expect(result.warnings).toHaveLength(1);
    } finally {
      rmrf(tmp);
    }
  });

  it('DoctorInvariantsCatalog_CleanConfig_EmitsNoDeprecation', async () => {
    // POSITIVE CONTROL for the deprecation channel. "No deprecation" must be
    // a real verdict, not the absence of a code path: the fixture below is
    // byte-identical to the alias fixture above except for the config key, and
    // it must come back with zero warnings. Together the two tests show the
    // deprecation channel is both live and discriminating.
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
