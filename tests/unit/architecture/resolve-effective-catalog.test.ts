import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEffectiveCatalog } from '../../../src/architecture/resolve-effective-catalog.js';
import type { ExarchosConfig } from '../../../src/config/exarchos-config-schema.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The dev catalog of the fixture: an ordinary `catalogs:` registration with `tier: 'dev'`.
 * Each test puts it last in its `catalogs:` list.
 */
const DEV_REGISTRATION = {
  path: '.exarchos/invariants.md',
  tier: 'dev' as const,
};

/**
 * Builds an isolated repo fixture with a dev catalog at `.exarchos/invariants.md` and a user catalog.
 * The user catalog holds two entries with ids outside the reserved namespaces. The caller must run `cleanup`.
 */
function makeRepoFixture(): {
  repoRoot: string;
  userCatalogPath: string;
  cleanup: () => void;
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-cat-'));
  const devCatalogDir = path.join(repoRoot, '.exarchos');
  fs.mkdirSync(devCatalogDir, { recursive: true });

  const devCatalog = [
    '---',
    'schema-version: 3',
    'invariants:',
    '  - id: INV-1',
    '    dimension: substrate-truth',
    '    axis: substrate',
    '    integrity-class: substrate',
    '    cost-of-load: always-load',
    '    applies-to:',
    '      - src/**',
    '    summary: Payload is the single source of truth.',
    '    references: []',
    '---',
    '# Dev catalog body',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(devCatalogDir, 'invariants.md'), devCatalog, 'utf8');

  const userCatalog = [
    '---',
    'schema-version: 3',
    'invariants:',
    '  - id: team-no-console',
    '    dimension: lint',
    '    axis: substrate',
    '    cost-of-load: always-load',
    '    applies-to:',
    '      - src/**',
    '    summary: No console.log in committed code.',
    '    references: []',
    '  - id: team-doc-style',
    '    dimension: docs',
    '    axis: authoring',
    '    cost-of-load: always-load',
    '    applies-to:',
    '      - docs/**',
    '    summary: Docs follow the house style.',
    '    references: []',
    '---',
    '# User catalog body',
    '',
  ].join('\n');
  const userCatalogPath = path.join(repoRoot, 'team-invariants.md');
  fs.writeFileSync(userCatalogPath, userCatalog, 'utf8');

  return {
    repoRoot,
    userCatalogPath,
    cleanup: () => rmrf(repoRoot),
  };
}

describe('resolveEffectiveCatalog', () => {
  let fixture: ReturnType<typeof makeRepoFixture>;

  beforeEach(() => {
    fixture = makeRepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  /** `team-no-console` is a user-layer entry with no floor, so the disable override removes it. */
  it('ResolveEffectiveCatalog_DevSdlcUser_ReturnsMergedProjectedPayload', () => {
    const config: ExarchosConfig = {
      invariants: {
        catalogs: [fixture.userCatalogPath, DEV_REGISTRATION],
        overrides: {
          'team-no-console': { enabled: false },
        },
      },
    };

    const { entries } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    const ids = entries.map((e) => e.id);

    expect(ids).toContain('INV-1');
    expect(ids).toContain('team-doc-style');
    expect(ids).not.toContain('team-no-console');
  });

  /** A user catalog that throws at load (unknown check kind) does not abort resolution. A warning names the file. */
  it('ResolveEffectiveCatalog_MalformedUserCatalog_DegradesWithWarning', () => {
    const badCatalogPath = path.join(fixture.repoRoot, 'invariants.user.yml');
    fs.writeFileSync(
      badCatalogPath,
      [
        '---',
        'schema-version: 3',
        'invariants:',
        '  - id: team-bad',
        '    dimension: lint',
        '    axis: substrate',
        '    cost-of-load: always-load',
        '    applies-to:',
        '      - src/**',
        '    summary: Malformed — unknown check kind.',
        '    references: []',
        '    enforcement:',
        '      mode: check',
        '      check:',
        '        kind: not-a-real-kind',
        "        pattern: 'x'",
        '---',
        '',
      ].join('\n'),
      'utf8',
    );

    const config: ExarchosConfig = {
      invariants: {
        catalogs: ['invariants.user.yml', DEV_REGISTRATION],
      },
    };

    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    expect(entries.map((e) => e.id)).toContain('INV-1');
    const warning = warnings.find((w) => w.includes('invariants.user.yml'));
    expect(warning).toBeDefined();
  });

  /**
   * A user catalog that claims an id in a reserved namespace does not make the resolution throw.
   * The resolver drops that entry with a warning. The valid sibling entry and the built-in layers still resolve.
   */
  it('ResolveEffectiveCatalog_ReservedNamespaceUserEntry_DegradesWithWarning', () => {
    const reservedCatalogPath = path.join(fixture.repoRoot, 'reserved.user.md');
    fs.writeFileSync(
      reservedCatalogPath,
      [
        '---',
        'schema-version: 3',
        'invariants:',
        '  - id: INV-99',
        '    dimension: lint',
        '    axis: substrate',
        '    cost-of-load: always-load',
        '    applies-to:',
        '      - src/**',
        '    summary: User entry squatting a reserved id.',
        '    references: []',
        '  - id: team-valid',
        '    dimension: lint',
        '    axis: substrate',
        '    cost-of-load: always-load',
        '    applies-to:',
        '      - src/**',
        '    summary: A legitimate user invariant.',
        '    references: []',
        '---',
        '',
      ].join('\n'),
      'utf8',
    );

    const config: ExarchosConfig = {
      invariants: {
        catalogs: ['reserved.user.md', DEV_REGISTRATION],
      },
    };

    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    const ids = entries.map((e) => e.id);
    expect(ids).toContain('INV-1');
    expect(ids).toContain('team-valid');
    expect(entries.filter((e) => e.id === 'INV-99')).toHaveLength(0);
    const warning = warnings.find(
      (w) => w.includes('INV-99') && w.includes('reserved'),
    );
    expect(warning).toBeDefined();
  });

  /** A configured catalog path that does not exist is usually a typo, so it must give a warning. */
  it('ResolveEffectiveCatalog_MissingUserCatalogPath_WarnsNotSilent', () => {
    const config: ExarchosConfig = {
      invariants: {
        catalogs: ['does/not/exist.md', DEV_REGISTRATION],
      },
    };

    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    expect(entries.map((e) => e.id)).toContain('INV-1');
    const warning = warnings.find(
      (w) => w.includes('does/not/exist.md') && w.includes('not found'),
    );
    expect(warning).toBeDefined();
  });

  /**
   * A malformed entry makes `loadInvariants` throw on the dev catalog. The resolution must not throw.
   * The dev layer degrades to empty with a warning, and the user layer still resolves.
   */
  it('ResolveEffectiveCatalog_MalformedDevCatalog_DegradesWithWarning', () => {
    const devCatalogDir = path.join(fixture.repoRoot, '.exarchos');
    fs.writeFileSync(
      path.join(devCatalogDir, 'invariants.md'),
      [
        '---',
        'schema-version: 3',
        'invariants:',
        '  - id: INV-1',
        '    dimension: substrate-truth',
        '    axis: substrate',
        '    integrity-class: substrate',
        '    cost-of-load: always-load',
        '    applies-to:',
        '      - src/**',
        '    summary: Payload is the single source of truth.',
        '    references: []',
        '    enforcement:',
        '      mode: check',
        '      check:',
        '        kind: not-a-real-kind',
        "        pattern: 'x'",
        '---',
        '# Malformed dev catalog',
        '',
      ].join('\n'),
      'utf8',
    );

    const config: ExarchosConfig = {
      invariants: {
        catalogs: [fixture.userCatalogPath, DEV_REGISTRATION],
      },
    };

    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    expect(entries.map((e) => e.id)).not.toContain('INV-1');
    expect(entries.map((e) => e.id)).toContain('team-doc-style');
    const warning = warnings.find(
      (w) => w.includes('invariants.md') && w.includes('Dev invariant catalog'),
    );
    expect(warning).toBeDefined();
  });

  /** With no dev registration the dev layer is empty. The shipped SDLC baseline still resolves, tagged `sdlc`. */
  it('ResolveEffectiveCatalog_DevCatalogDisabled_StillReturnsSdlcEntries', () => {
    const config: ExarchosConfig = {
      invariants: { devCatalog: 'disabled' },
    };
    const { entries } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'review',
      workflowType: 'feature',
    });
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain('INV-1');
    expect(ids).toContain('SDLC-1');
    expect(ids).toContain('SDLC-3');
    for (const e of entries.filter((x) => x.id.startsWith('SDLC-'))) {
      expect(e.integrityClass).toBe('sdlc');
    }
  });

  /**
   * A `discovery` workflow excludes the SDLC entries in two ways.
   * The `workflow-affinity` lists of the entries omit `discovery`, and `projectCatalog` drops each substrate entry.
   */
  it('ResolveEffectiveCatalog_WorkflowDiscovery_ExcludesAllSdlcEntries', () => {
    const { entries } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config: { invariants: { devCatalog: 'disabled' } },
      phase: 'review',
      workflowType: 'discovery',
    });
    expect(
      entries.filter((e) => e.id.startsWith('SDLC-')),
      `SDLC entries must be excluded for workflowType='discovery'`,
    ).toHaveLength(0);
  });

  it('ResolveEffectiveCatalog_Sdlc3SeverityOverrideAdvisory_ClampHonored', () => {
    const { entries } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config: {
        invariants: {
          devCatalog: 'disabled',
          overrides: { 'SDLC-3': { severity: 'advisory' } },
        },
      },
      phase: 'review',
      workflowType: 'feature',
    });
    const sdlc3 = entries.find((e) => e.id === 'SDLC-3');
    expect(sdlc3).toBeDefined();
    expect(sdlc3?.severity?.default).toBe('advisory');
  });

  it('resolveEffectiveCatalog_DevViaRegistration_LoadsDevLayer', () => {
    const config: ExarchosConfig = {
      invariants: {
        catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }],
      },
    };

    const { entries } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    expect(entries.map((e) => e.id)).toContain('INV-1');
  });

  /** A registered dev source with no file gives a warning and does not throw. The SDLC layer still resolves. */
  it('resolveEffectiveCatalog_MissingDevSource_DegradesWithWarning', () => {
    const config: ExarchosConfig = {
      invariants: {
        catalogs: [{ path: 'docs/architecture/does-not-exist.md', tier: 'dev' }],
      },
    };

    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'review',
      workflowType: 'feature',
    });

    expect(entries.map((e) => e.id)).toContain('SDLC-1');
    const warning = warnings.find((w) =>
      w.includes('docs/architecture/does-not-exist.md'),
    );
    expect(warning).toBeDefined();
  });

  /** The inline SDLC layer resolves with no registered catalog, and each entry has the `sdlc` class. */
  it('resolveEffectiveCatalog_SdlcLayer_Unaffected', () => {
    const { entries } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config: {},
      phase: 'review',
      workflowType: 'feature',
    });
    const sdlc = entries.filter((e) => e.id.startsWith('SDLC-'));
    expect(sdlc.length).toBeGreaterThan(0);
    for (const e of sdlc) {
      expect(e.integrityClass).toBe('sdlc');
    }
  });

  /**
   * Resolves the real repo catalog through an explicit dev registration, with the default `repoRoot`.
   * The expected ids are a hand-written list, because a snapshot cannot disagree with the code that produced it.
   * Each id must appear one time, so a duplicate registration or a double load fails.
   * The same file registered as `tier: 'user'` loses every reserved id, with a warning.
   * That shows that the dev tier, not the path, grants the reserved namespace.
   * The `devCatalog` key alone resolves no dev entry.
   */
  it('RepoConfig_ExplicitDevRegistration_ResolvesRealCatalog', () => {
    const devLayer = (config: ExarchosConfig): { ids: string[] } => {
      const { entries } = resolveEffectiveCatalog({
        config,
        phase: 'ideate',
        workflowType: 'feature',
      });
      const dev = entries
        .filter((e) => e.id.startsWith('INV-'))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { ids: dev.map((e) => e.id) };
    };

    const explicit = devLayer({
      invariants: {
        catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }],
      },
    });

    expect(explicit.ids.length).toBeGreaterThan(0);
    expect(new Set(explicit.ids).size).toBe(explicit.ids.length);

    expect(explicit.ids).toEqual([
      'INV-10',
      'INV-12',
      'INV-15',
      'INV-5b',
      'INV-5c',
      'INV-7',
      'INV-8',
      'INV-9',
    ]);

    const asUser = resolveEffectiveCatalog({
      config: {
        invariants: {
          catalogs: [{ path: '.exarchos/invariants.md', tier: 'user' }],
        },
      },
      phase: 'ideate',
      workflowType: 'feature',
    });
    expect(asUser.entries.filter((e) => e.id.startsWith('INV-'))).toEqual([]);
    expect(
      asUser.warnings.some((w) => w.includes('reserved')),
      'a user-tier registration of the dev catalog must warn, not silently drop',
    ).toBe(true);

    expect(devLayer({ invariants: { devCatalog: 'enabled' } }).ids).toEqual([]);
  });

  /**
   * The floor of the SDLC layer is `advisory`, so the resolver refuses a full disable.
   * The entry stays, and the resolver gives a warning.
   */
  it('ResolveEffectiveCatalog_Sdlc3EnabledFalse_RefusedByFloorAndWarns', () => {
    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config: {
        invariants: {
          devCatalog: 'disabled',
          overrides: { 'SDLC-3': { enabled: false } },
        },
      },
      phase: 'review',
      workflowType: 'feature',
    });
    expect(entries.map((e) => e.id)).toContain('SDLC-3');
    const warning = warnings.find((w) => w.includes('SDLC-3'));
    expect(warning).toBeDefined();
  });
});
