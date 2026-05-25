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
      { repoRoot: '/repo', path: 'docs/architecture/my-invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      catalog: { wrote: boolean; path: string; reason: string };
    };
    expect(data.catalog.wrote).toBe(true);
    expect(data.catalog.reason).toBe('created');

    const written = fake.files.get('/repo/docs/architecture/my-invariants.md');
    expect(written).toBeDefined();
    // v3-shaped: a top-level `invariants:` list key …
    expect(written).toMatch(/invariants:/);
    // … and a COMMENTED worked-example entry (the author un-comments to start).
    expect(written).toMatch(/#.*id:/);
  });

  it('handleScaffold_ExistingFile_NoOverwrite', async () => {
    const existing = 'invariants:\n  - id: U-1\n';
    const fake = makeFakeFs({
      '/repo/docs/architecture/my-invariants.md': existing,
    });

    const result = await handleScaffold(
      { repoRoot: '/repo', path: 'docs/architecture/my-invariants.md', tier: 'user' },
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
        (w) => w.path === '/repo/docs/architecture/my-invariants.md',
      ),
    ).toBe(false);
    expect(fake.files.get('/repo/docs/architecture/my-invariants.md')).toBe(
      existing,
    );
  });

  it('handleScaffold_RegistersInExarchosYml', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos.yml': 'test: npm test\n',
    });

    const result = await handleScaffold(
      { repoRoot: '/repo', path: 'docs/architecture/my-invariants.md', tier: 'user' },
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
    expect(yml).toMatch(/docs\/architecture\/my-invariants\.md/);
  });

  it('handleScaffold_AlreadyRegistered_RegistrationIdempotent', async () => {
    const fake = makeFakeFs({
      '/repo/.exarchos.yml':
        'invariants:\n  catalogs:\n    - { path: docs/architecture/my-invariants.md, tier: user }\n',
    });

    const result = await handleScaffold(
      { repoRoot: '/repo', path: 'docs/architecture/my-invariants.md', tier: 'user' },
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
      { repoRoot: '/repo', path: 'docs/architecture/my-invariants.md', tier: 'user' },
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
 */
describe('renderStarterCatalog → loadInvariants round-trip (#1487)', () => {
  it.each(['user', 'dev'] as const)(
    'renderStarterCatalog_%s_ParsesViaLoadInvariantsWithoutThrowing',
    (tier) => {
      const body = renderStarterCatalog(tier);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-roundtrip-'));
      const catalogPath = path.join(dir, 'invariants.md');
      fs.writeFileSync(catalogPath, body);

      try {
        // devCatalog:'enabled' so the loader gate does not short-circuit to [].
        const entries = loadInvariants(catalogPath, undefined, {
          invariants: { devCatalog: 'enabled' },
        });
        expect(Array.isArray(entries)).toBe(true);
        // A pristine scaffold has only the COMMENTED worked example → empty.
        expect(entries).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
