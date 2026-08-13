/**
 * T6 — `invariants_scaffold` handler tests.
 *
 * The scaffold verb creates a v3-shaped starter catalog file at a target path
 * (with one commented worked-example entry), idempotently registers it in
 * `.exarchos.yml`, and NEVER overwrites an existing catalog file. All fs side
 * effects flow through injected hooks so the handler is pure-by-default
 * (mirrors `seedExarchosConfig`).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleScaffold, renderStarterCatalog } from './scaffold.js';
import type { ScaffoldDeps } from './scaffold.js';
import { loadInvariants } from '../../architecture/invariants-loader.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

// ─── In-memory fs harness ────────────────────────────────────────────────────

interface FakeFs {
  files: Map<string, string>;
  deps: ScaffoldDeps;
  writes: Array<{ path: string; contents: string }>;
}

function makeFakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed));
  const writes: Array<{ path: string; contents: string }> = [];
  const deps: ScaffoldDeps = {
    exists: (p) => files.has(p),
    read: (p) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    },
    write: (p, contents) => {
      files.set(p, contents);
      writes.push({ path: p, contents });
    },
  };
  return { files, deps, writes };
}

describe('handleScaffold', () => {
  it('handleScaffold_NewCatalog_WritesStarterFile', async () => {
    const fake = makeFakeFs();

    const result = await handleScaffold(
      { repoRoot: '/repo', path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      catalog: { wrote: boolean; path: string; reason: string };
    };
    expect(data.catalog.wrote).toBe(true);
    expect(data.catalog.reason).toBe('created');

    const written = fake.files.get('/repo/.exarchos/invariants.md');
    expect(written).toBeDefined();
    // v3-shaped: a top-level `invariants:` list key …
    expect(written).toMatch(/invariants:/);
    // … and a COMMENTED worked-example entry (the author un-comments to start).
    expect(written).toMatch(/#.*id:/);
  });

  it('handleScaffold_ExistingFile_NoOverwrite', async () => {
    const existing = 'invariants:\n  - id: U-1\n';
    const fake = makeFakeFs({
      '/repo/.exarchos/invariants.md': existing,
    });

    const result = await handleScaffold(
      { repoRoot: '/repo', path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      catalog: { wrote: boolean; path: string; reason: string };
    };
    expect(data.catalog.wrote).toBe(false);
    expect(data.catalog.reason).toBe('already-exists');
    // The catalog file is untouched — no write to that path.
    expect(
      fake.writes.some(
        (w) => w.path === '/repo/.exarchos/invariants.md',
      ),
    ).toBe(false);
    expect(fake.files.get('/repo/.exarchos/invariants.md')).toBe(
      existing,
    );
  });

  it('handleScaffold_RegistersInExarchosYml', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos.yml': 'test: npm test\n',
    });

    const result = await handleScaffold(
      { repoRoot: '/repo', path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      registration: { wrote: boolean; path: string; reason: string };
    };
    expect(data.registration.wrote).toBe(true);

    const yml = fake.files.get('/repo/.exarchos.yml');
    expect(yml).toBeDefined();
    expect(yml).toMatch(/invariants:/);
    expect(yml).toMatch(/\.exarchos\/invariants\.md/);
  });

  it('handleScaffold_AlreadyRegistered_RegistrationIdempotent', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos.yml':
        'invariants:\n  catalogs:\n    - { path: .exarchos/invariants.md, tier: user }\n',
    });

    const result = await handleScaffold(
      { repoRoot: '/repo', path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      registration: { wrote: boolean; reason: string };
    };
    expect(data.registration.wrote).toBe(false);
    expect(data.registration.reason).toBe('already-registered');
  });

  it('handleScaffold_SuccessEnvelope_PublishesNextActions', async () => {
    const fake = makeFakeFs();

    const result = await handleScaffold(
      { repoRoot: '/repo', path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as { next_actions: string[] };
    expect(data.next_actions).toContain('doctor');
    expect(data.next_actions).toContain('view invariants_effective');
  });
});

/**
 * Round-trip regression (#1487 HIGH/Sentry): a freshly-scaffolded catalog MUST
 * be parseable by `loadInvariants`. The prior `renderStarterCatalog` emitted no
 * `---` frontmatter fences, so `gray-matter` produced `data.invariants ===
 * undefined` and `loadInvariants` threw — every scaffolded file was dead on
 * arrival and silently skipped by `resolveEffectiveCatalog`. This covers the
 * scaffold → loadInvariants round-trip the original tests omitted.
 *
 * ## T-42: this test had gone VACUOUS — read before touching it
 *
 * It used to opt the load in with `invariants: { devCatalog: 'enabled' }`.
 * DR-31 retired that boolean and made it inert, so the loader's registration
 * gate began short-circuiting to `[]` BEFORE parsing the file. The test still
 * passed — but for the wrong reason: `expect(entries).toEqual([])` was
 * satisfied by "the loader never opened the file", not by "the scaffold
 * declares no entries". The #1487 regression it exists to catch (a scaffold
 * that THROWS on parse) would no longer have been caught at all, because the
 * parse never ran.
 *
 * Two changes fix that, and the second is the load-bearing one:
 *   1. the catalog is REGISTERED, so the loader actually parses it; and
 *   2. a positive control loads a seeded copy of the SAME body through the
 *      SAME call and requires the seeded entry back. If the gate ever
 *      short-circuits again, the control returns `[]` and this test fails
 *      loudly instead of passing silently.
 */
describe('renderStarterCatalog → loadInvariants round-trip (#1487)', () => {
  /** Register the file under test — DR-31: registration IS the opt-in. */
  const registering = (catalogPath: string, tier: 'user' | 'dev') => ({
    invariants: { catalogs: [{ path: catalogPath, tier }] },
  });

  /**
   * The commented worked example from the scaffold, un-commented. Seeding it
   * turns the pristine body into one that declares exactly one entry, which is
   * how we prove the loader really read the file.
   */
  const SEEDED_ENTRY = [
    'invariants:',
    '  - id: U-1',
    '    dimension: example-dimension',
    '    axis: authoring',
    '    cost-of-load: reference-only',
    '    applies-to:',
    '      - "src/**/*.ts"',
    '    summary: One-sentence statement of the rule this invariant enforces.',
    '    references:',
    '      - docs/architecture/some-design.md',
    '    severity:',
    '      default: advisory',
    '    integrity-class: user',
    '    enforcement:',
    '      mode: audit',
    '      audit-prompt: >-',
    '        Does the diff violate <the rule>? Cite the offending file + line.',
  ].join('\n');

  it.each(['user', 'dev'] as const)(
    'renderStarterCatalog_%s_ParsesViaLoadInvariantsWithoutThrowing',
    (tier) => {
      const body = renderStarterCatalog(tier);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-roundtrip-'));
      const catalogPath = path.join(dir, 'invariants.md');
      const seededPath = path.join(dir, 'seeded.md');
      fs.writeFileSync(catalogPath, body);

      try {
        // (1) THE #1487 CLAIM: a pristine scaffold parses without throwing...
        let entries: ReturnType<typeof loadInvariants> | undefined;
        expect(() => {
          entries = loadInvariants(
            catalogPath,
            undefined,
            registering(catalogPath, tier),
          );
        }).not.toThrow();
        expect(Array.isArray(entries)).toBe(true);
        // ...and declares NO entries, because its worked example is commented.
        // A scaffold that shipped a LIVE entry reddens right here.
        expect(entries).toEqual([]);

        // (2) POSITIVE CONTROL — the anti-vacuity guard. The same loader call
        // against the same body WITH the worked example live must return that
        // entry. A gate that short-circuits, or a parser that never reads the
        // frontmatter, returns [] here and this fails. Without this assertion
        // the `toEqual([])` above passes for a loader that does nothing.
        //
        // The seeded copy differs from the pristine one ONLY in that its
        // worked example is live. If the substitution ever stops applying, the
        // control would silently degenerate into a second copy of the pristine
        // case — so assert the bodies actually differ before relying on it.
        const seededBody = body.replace('invariants: []', SEEDED_ENTRY);
        expect(
          seededBody,
          'seeding anchor `invariants: []` not found in the scaffold body — ' +
            'the positive control below would be vacuous',
        ).not.toEqual(body);
        fs.writeFileSync(seededPath, seededBody);

        const seeded = loadInvariants(
          seededPath,
          undefined,
          registering(seededPath, tier),
        );
        expect(seeded.map((e) => e.id)).toEqual(['U-1']);
      } finally {
        rmrf(dir);
      }
    },
  );
});

/**
 * #1489 — `dev`/INV-N is exarchos's reserved substrate namespace. Scaffolding a
 * dev catalog from a consumer repo is rejected before any write; the exarchos
 * repo itself (or an explicit override) is allowed.
 */
describe('handleScaffold reserved-tier guard (#1489)', () => {
  it('handleScaffold_DevTier_NonExarchosRepo_BlockedAsReserved', async () => {
    const fake = makeFakeFs({
      '/repo/package.json': JSON.stringify({ name: '@acme/consumer' }),
    });

    const result = await handleScaffold(
      { repoRoot: '/repo', tier: 'dev' },
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RESERVED_TIER');
    expect(result.error?.suggestedFix?.params.tier).toBe('user');
    // No catalog file written — guard fires before the fs write.
    expect(fake.writes).toHaveLength(0);
  });

  it('handleScaffold_DevTier_ExarchosRepo_Allows', async () => {
    const fake = makeFakeFs({
      '/repo/package.json': JSON.stringify({ name: '@lvlup-sw/exarchos' }),
    });

    const result = await handleScaffold(
      { repoRoot: '/repo', tier: 'dev' },
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { catalog: { wrote: boolean } }).catalog.wrote).toBe(
      true,
    );
  });

  it('handleScaffold_DevTier_WithOverride_Allows', async () => {
    const fake = makeFakeFs({
      '/repo/package.json': JSON.stringify({ name: '@acme/consumer' }),
    });

    const result = await handleScaffold(
      { repoRoot: '/repo', tier: 'dev', allowReservedTier: true },
      fake.deps,
    );

    expect(result.success).toBe(true);
  });
});
