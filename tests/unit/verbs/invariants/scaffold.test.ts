/**
 * Tests for the `invariants_scaffold` handler. The verb writes a v3 starter catalog with one commented
 * worked-example entry and registers it in `.exarchos.yml` when it is not registered. It does not
 * overwrite an existing catalog. All file system effects go through injected hooks, like
 * `seedExarchosConfig`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleScaffold, renderStarterCatalog } from '../../../../src/verbs/invariants/scaffold.js';
import type { ScaffoldDeps } from '../../../../src/verbs/invariants/scaffold.js';
import { loadInvariants } from '../../../../src/architecture/invariants-loader.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

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
  /** The starter file has a top-level `invariants:` key and a commented worked-example entry. */
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
    expect(written).toMatch(/invariants:/);
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
 * A new scaffolded catalog must parse through `loadInvariants` and declare no entries. Without `---`
 * frontmatter fences, `data.invariants` is undefined and `loadInvariants` throws.
 * Registration is the opt-in, and the loader returns `[]` for an unregistered file before it parses.
 * So `registering` registers the file under test.
 *
 * A positive control loads a seeded copy of the same body and must get the seeded entry back.
 * Without it, `toEqual([])` also passes for a loader that does not read the file. `SEEDED_ENTRY` is
 * the worked example without comments, and the test asserts that the seeded body differs.
 */
describe('renderStarterCatalog → loadInvariants round-trip (#1487)', () => {
  const registering = (catalogPath: string, tier: 'user' | 'dev') => ({
    invariants: { catalogs: [{ path: catalogPath, tier }] },
  });

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
        let entries: ReturnType<typeof loadInvariants> | undefined;
        expect(() => {
          entries = loadInvariants(
            catalogPath,
            undefined,
            registering(catalogPath, tier),
          );
        }).not.toThrow();
        expect(Array.isArray(entries)).toBe(true);
        expect(entries).toEqual([]);

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
 * The `dev` tier with `INV` ids is the reserved namespace of exarchos. A consumer repo cannot scaffold
 * a dev catalog, and the guard runs before any write. The exarchos repo or an explicit override can.
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
