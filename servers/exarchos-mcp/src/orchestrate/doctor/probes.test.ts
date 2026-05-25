import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DispatchContext } from '../../core/dispatch.js';
import { buildProbes, resolveInvariantsCatalog } from './probes.js';
import { ReservedNamespaceError } from '../../architecture/catalog-merge.js';

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
  // module-relative resolution would find the in-repo config (devCatalog
  // enabled) and report configured — so this fails RED on the bug, GREEN on
  // the fix.
  it('Resolve_CwdHasNoExarchosYmlAncestor_ReturnsNotConfigured', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-no-cfg-'));
    process.chdir(tmp);
    try {
      const probes = buildProbes(fakeContext());
      const result = await probes.invariants.resolve();
      expect(result.configured).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
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
      'invariants:\n  devCatalog: disabled\n  catalogs:\n    - ./my-catalog.md\n',
    );
    process.chdir(tmp);
    try {
      const probes = buildProbes(fakeContext());
      const result = await probes.invariants.resolve();
      expect(result.configured).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
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
      'invariants:\n  devCatalog: disabled\n  catalogs:\n    - ./team-catalog.md\n',
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
      fs.rmSync(tmp, { recursive: true, force: true });
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
      'invariants:\n  devCatalog: disabled\n  catalogs:\n    - ./team-catalog.md\n',
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
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
