import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEffectiveCatalog } from './resolve-effective-catalog.js';
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';

/**
 * Build an isolated repo fixture with a dev invariants catalog at
 * `.exarchos/invariants.md` and a user-authored catalog. Returns the
 * temp repo root; caller is responsible for cleanup.
 */
function makeRepoFixture(): {
  repoRoot: string;
  userCatalogPath: string;
  cleanup: () => void;
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-cat-'));
  // Dev catalog now lives at `.exarchos/invariants.md` (relocated in T19).
  const devCatalogDir = path.join(repoRoot, '.exarchos');
  fs.mkdirSync(devCatalogDir, { recursive: true });

  // Dev catalog (built-in). schema-version 3 so phase/workflow affinity and
  // integrity-class fields are honoured.
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

  // User catalog (consumer-authored). A non-reserved id, sdlc-removable
  // semantics handled by the merge layer (tagged `user`, no floor).
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
    cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }),
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

  it('ResolveEffectiveCatalog_DevSdlcUser_ReturnsMergedProjectedPayload', () => {
    const config: ExarchosConfig = {
      invariants: {
        devCatalog: 'enabled',
        catalogs: [fixture.userCatalogPath],
        // `team-no-console` is a user-layer entry (no floor) → a disable
        // override is honored and the entry is dropped from the payload.
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

    // Dev-layer substrate invariant is present (devCatalog enabled).
    expect(ids).toContain('INV-1');
    // User-layer entry that was NOT disabled remains.
    expect(ids).toContain('team-doc-style');
    // A disabled-with-permission (user floor = none) entry is absent.
    expect(ids).not.toContain('team-no-console');
  });

  it('ResolveEffectiveCatalog_MalformedUserCatalog_DegradesWithWarning', () => {
    // A user catalog that throws at load (unknown check kind) must NOT abort
    // resolution: the dev layer survives and a warning names the failed file.
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
        devCatalog: 'enabled',
        catalogs: ['invariants.user.yml'],
      },
    };

    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    // Dev layer still resolved (degraded, not aborted).
    expect(entries.map((e) => e.id)).toContain('INV-1');
    // Warning names the failed user catalog.
    const warning = warnings.find((w) => w.includes('invariants.user.yml'));
    expect(warning).toBeDefined();
  });

  it('ResolveEffectiveCatalog_ReservedNamespaceUserEntry_DegradesWithWarning', () => {
    // A user catalog claiming a reserved id (`INV-*` / `SDLC-*`) must NOT crash
    // the whole resolution via mergeCatalogs' ReservedNamespaceError. The
    // offending entry is dropped with a warning; the catalog's valid entries
    // and the built-in layers still resolve (DR-9 entry-granular degradation).
    const reservedCatalogPath = path.join(fixture.repoRoot, 'reserved.user.md');
    fs.writeFileSync(
      reservedCatalogPath,
      [
        '---',
        'schema-version: 3',
        'invariants:',
        '  - id: INV-99', // reserved namespace — must be rejected
        '    dimension: lint',
        '    axis: substrate',
        '    cost-of-load: always-load',
        '    applies-to:',
        '      - src/**',
        '    summary: User entry squatting a reserved id.',
        '    references: []',
        '  - id: team-valid', // valid sibling — must survive
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
        devCatalog: 'enabled',
        catalogs: ['reserved.user.md'],
      },
    };

    // Must not throw.
    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    const ids = entries.map((e) => e.id);
    // The built-in dev INV-1 (not a user squat) and the valid user entry survive.
    expect(ids).toContain('INV-1');
    expect(ids).toContain('team-valid');
    // The reserved-id user squat was dropped, not surfaced as a built-in.
    expect(entries.filter((e) => e.id === 'INV-99')).toHaveLength(0);
    // A warning names the offending id.
    const warning = warnings.find(
      (w) => w.includes('INV-99') && w.includes('reserved'),
    );
    expect(warning).toBeDefined();
  });

  it('ResolveEffectiveCatalog_MissingUserCatalogPath_WarnsNotSilent', () => {
    // A configured-but-missing catalog path is almost always a typo/rename. It
    // must surface a warning rather than silently disabling intended checks.
    const config: ExarchosConfig = {
      invariants: {
        devCatalog: 'enabled',
        catalogs: ['does/not/exist.md'],
      },
    };

    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    // Built-in layer unaffected.
    expect(entries.map((e) => e.id)).toContain('INV-1');
    // Warning names the missing path and says it was skipped.
    const warning = warnings.find(
      (w) => w.includes('does/not/exist.md') && w.includes('not found'),
    );
    expect(warning).toBeDefined();
  });

  it('ResolveEffectiveCatalog_MalformedDevCatalog_DegradesWithWarning', () => {
    // The dev catalog is first-party, but a malformed v3 entry makes
    // loadInvariants throw. That must NOT crash the gate (the gate has no
    // try/catch around resolveEffectiveCatalog): the dev layer degrades to
    // empty with a visible warning, and the other layers still resolve (INV-1).
    // The fixture's dev catalog lives at `.exarchos/invariants.md` (T19); we
    // overwrite it with a malformed body.
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
        '        kind: not-a-real-kind', // invalid → loadInvariants throws
        "        pattern: 'x'",
        '---',
        '# Malformed dev catalog',
        '',
      ].join('\n'),
      'utf8',
    );

    const config: ExarchosConfig = {
      invariants: {
        devCatalog: 'enabled',
        catalogs: [fixture.userCatalogPath],
      },
    };

    // Must not throw.
    const { entries, warnings } = resolveEffectiveCatalog({
      repoRoot: fixture.repoRoot,
      config,
      phase: 'ideate',
      workflowType: 'feature',
    });

    // Dev layer degraded to empty; the user layer still resolved.
    expect(entries.map((e) => e.id)).not.toContain('INV-1');
    expect(entries.map((e) => e.id)).toContain('team-doc-style');
    // A warning names the dev catalog and says it was skipped.
    const warning = warnings.find(
      (w) => w.includes('invariants.md') && w.includes('Dev invariant catalog'),
    );
    expect(warning).toBeDefined();
  });

  // ─── #1467: sdlc layer is default-on, independent of the dev gate ──────────

  it('ResolveEffectiveCatalog_DevCatalogDisabled_StillReturnsSdlcEntries', () => {
    // Consumer scenario: devCatalog NOT enabled ⇒ dev layer empty, but the
    // shipped SDLC-* baseline still resolves (default-on, no gate).
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
    expect(ids).not.toContain('INV-1'); // dev layer gated off
    expect(ids).toContain('SDLC-1'); // sdlc layer default-on
    expect(ids).toContain('SDLC-3');
    // Every sdlc entry is tagged integrity-class sdlc by the merge.
    for (const e of entries.filter((x) => x.id.startsWith('SDLC-'))) {
      expect(e.integrityClass).toBe('sdlc');
    }
  });

  it('ResolveEffectiveCatalog_WorkflowDiscovery_ExcludesAllSdlcEntries', () => {
    // The SDLC entries are excluded from a docs-only research workflow via
    // their `workflow-affinity` (the lists omit discovery), NOT via the
    // `projectCatalog` axis-substrate branch — that branch checks 'discover'
    // while the runtime workflow type is 'discovery' (a latent #1465 token
    // mismatch). Assert both spellings yield zero so the exclusion is robust
    // regardless of which token a caller passes.
    for (const workflowType of ['discovery', 'discover']) {
      const { entries } = resolveEffectiveCatalog({
        repoRoot: fixture.repoRoot,
        config: { invariants: { devCatalog: 'disabled' } },
        phase: 'review',
        workflowType,
      });
      expect(
        entries.filter((e) => e.id.startsWith('SDLC-')),
        `SDLC entries must be excluded for workflowType='${workflowType}'`,
      ).toHaveLength(0);
    }
  });

  // ─── #1467 DR-3: override-floor (INV-11) end-to-end on a real SDLC entry ───

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

  // ─── P1 T3: dev catalog via registered source (collapse Layers 1+3) ───────

  it('resolveEffectiveCatalog_DevViaRegistration_LoadsDevLayer', () => {
    // A `{ path, tier: dev }` registration (NOT the devCatalog boolean) must
    // surface the dev catalog's INV-* entries through the same source loop the
    // user catalogs use. The fixture's invariants.md lives at the default dev
    // path, so register it explicitly with tier:dev and leave devCatalog unset.
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

  it('resolveEffectiveCatalog_MissingDevSource_DegradesWithWarning', () => {
    // A registered dev source whose file is absent must degrade to a warning
    // (parity with the user-catalog DR-9 behavior), not throw, and the other
    // layers (sdlc) still resolve.
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

    // Did not throw; sdlc layer still present.
    expect(entries.map((e) => e.id)).toContain('SDLC-1');
    // Warning names the missing dev source path.
    const warning = warnings.find((w) =>
      w.includes('docs/architecture/does-not-exist.md'),
    );
    expect(warning).toBeDefined();
  });

  it('resolveEffectiveCatalog_SdlcLayer_Unaffected', () => {
    // The sdlc inline layer (Layer 2) is untouched by the source-loop refactor:
    // it still resolves with no registered catalogs at all, tagged sdlc.
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

  // ─── P4 T16: dogfood equivalence — sugar ≡ explicit ≡ T0 golden ───────────

  it('RepoConfig_DesugaredDevSource_MatchesGoldenSnapshot', () => {
    // Closes the migration loop against the REAL repo catalog (no repoRoot
    // override → module-relative default, the same path the running gate uses).
    //
    // Three forms must resolve to the SAME dev layer (same INV-* ids):
    //   (a) the legacy `devCatalog: 'enabled'` sugar (what `.exarchos.yml` ships),
    //   (b) an explicit `{ path: .exarchos/invariants.md, tier: dev }`
    //       registration (the desugared form),
    //   (c) the T0 characterization golden snapshot of (a).
    //
    // If (a) ≠ (b), the P1 desugaring diverged from legacy behavior — a real
    // bug, not a docs task. This test is the dogfood proof that keeping
    // `devCatalog: enabled` in this repo's `.exarchos.yml` is equivalent to the
    // explicit registered-catalog pattern (design §4.3).

    const devIdSet = (config: ExarchosConfig): { ids: string[]; tags: string[] } => {
      const { entries } = resolveEffectiveCatalog({
        config,
        phase: 'ideate',
        workflowType: 'feature',
      });
      const dev = entries
        .filter((e) => e.id.startsWith('INV-'))
        .sort((a, b) => a.id.localeCompare(b.id));
      return {
        ids: dev.map((e) => e.id),
        tags: dev.map((e) => `${e.id}:${String(e.integrityClass)}`),
      };
    };

    const sugar = devIdSet({ invariants: { devCatalog: 'enabled' } });
    const explicit = devIdSet({
      invariants: {
        catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }],
      },
    });

    // (a) ≡ (b): the desugared explicit registration yields the identical
    // dev-layer ids + integrity-class tags as the legacy boolean sugar.
    expect(explicit.ids).toEqual(sugar.ids);
    expect(explicit.tags).toEqual(sugar.tags);

    // (a) ≡ (c): the sugar still matches the T0-pinned golden id set. The T0
    // snapshot lives in resolve-effective-catalog.characterization.test.ts; its
    // captured INV-* ids are the load-bearing golden the refactor preserved.
    expect(sugar.ids).toMatchSnapshot();

    // Sanity: a non-empty dev layer (the real repo catalog has INV-* entries),
    // so an accidental empty-equals-empty pass cannot mask a regression.
    expect(sugar.ids.length).toBeGreaterThan(0);
  });

  // ─── P5 T19: dev catalog relocated to `.exarchos/`, registered explicitly ──

  it('RepoConfig_ExplicitDevRegistration_DedupesWithSugar', () => {
    // P5, T19 — the dev catalog now lives at `.exarchos/invariants.md`, and the
    // repo's `.exarchos.yml` carries BOTH the legacy `devCatalog: 'enabled'`
    // sugar AND an explicit `{ path: '.exarchos/invariants.md', tier: 'dev' }`
    // registration (the canonical "like a user catalog" form). Both desugar to
    // the SAME path, so catalog-sources path-dedup must collapse them into a
    // SINGLE dev source — no duplicate INV-* ids — and the resolved dev INV-*
    // id set must still equal the T0 characterization golden (proves the
    // relocation is behavior-preserving).
    //
    // Resolve against the real repo catalog via the module-relative default
    // (no `repoRoot` override), the same path the running gate uses.
    const devIdSet = (config: ExarchosConfig): string[] => {
      const { entries } = resolveEffectiveCatalog({
        config,
        phase: 'ideate',
        workflowType: 'feature',
      });
      return entries
        .filter((e) => e.id.startsWith('INV-'))
        .map((e) => e.id)
        .sort((a, b) => a.localeCompare(b));
    };

    // Both forms (sugar-only, explicit-only) must resolve the SAME dev catalog
    // at the relocated `.exarchos/invariants.md`. Before the move the explicit
    // `.exarchos/` source is absent (empty layer) while the sugar still loads
    // the old `docs/architecture/` location, so these diverge — the RED signal.
    const explicit = devIdSet({
      invariants: {
        catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }],
      },
    });
    const sugar = devIdSet({ invariants: { devCatalog: 'enabled' } });

    // Explicit `.exarchos/` registration loads a non-empty dev layer.
    expect(explicit.length).toBeGreaterThan(0);
    // Explicit ≡ sugar: both desugar/resolve to the same relocated catalog.
    expect(explicit).toEqual(sugar);

    // Both flags together (what `.exarchos.yml` ships) dedupe to ONE dev source:
    // no duplicate INV-* ids, and the id set is unchanged from either alone.
    const both = devIdSet({
      invariants: {
        devCatalog: 'enabled',
        catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }],
      },
    });
    expect(new Set(both).size).toBe(both.length);
    expect(both).toEqual(sugar);

    // The resolved dev INV-* id set still matches the T0 characterization golden
    // (the same 8-id set pinned by resolveEffectiveCatalog_DevCatalogEnabled_
    // GoldenSnapshot in resolve-effective-catalog.characterization.test.ts).
    // `both === sugar` above already proves equivalence transitively; this
    // explicit pin guards against the golden silently shifting.
    expect(both).toEqual([
      'INV-10',
      'INV-12',
      'INV-15',
      'INV-5b',
      'INV-5c',
      'INV-7',
      'INV-8',
      'INV-9',
    ]);
  });

  it('ResolveEffectiveCatalog_Sdlc3EnabledFalse_RefusedByFloorAndWarns', () => {
    // sdlc floor = advisory ⇒ a full disable is REFUSED: the entry survives and
    // a warning is emitted, never a silent drop (INV-11 authority gradient).
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
