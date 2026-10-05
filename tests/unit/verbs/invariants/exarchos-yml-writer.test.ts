/**
 * Tests for the writer that registers a catalog in `.exarchos.yml`. The scaffold and add verbs use it.
 *
 * It appends `{ path, tier }` to `invariants.catalogs` when the path is absent, and it is idempotent.
 * It edits a `yaml` `Document`, so the seeded onboarding comments stay.
 */
import { describe, it, expect } from 'vitest';

import { wireCatalogRegistration } from '../../../../src/verbs/invariants/exarchos-yml-writer.js';
import type { YmlWriterDeps } from '../../../../src/verbs/invariants/exarchos-yml-writer.js';

interface FakeFs {
  files: Map<string, string>;
  deps: YmlWriterDeps;
  writes: Array<{ path: string; contents: string }>;
}

function makeFakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed));
  const writes: Array<{ path: string; contents: string }> = [];
  const deps: YmlWriterDeps = {
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

const YML = '/repo/.exarchos.yml';

describe('wireCatalogRegistration', () => {
  it('WireCatalog_UnregisteredPath_AppendsRegistration', () => {
    const fake = makeFakeFs({ [YML]: 'test: npm test\n' });

    const result = wireCatalogRegistration(
      YML,
      { path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe('registered');
    const yml = fake.files.get(YML)!;
    expect(yml).toMatch(/invariants:/);
    expect(yml).toMatch(/catalogs:/);
    expect(yml).toMatch(/\.exarchos\/invariants\.md/);
    expect(yml).toMatch(/tier: user/);
  });

  it('WireCatalog_NoConfigFile_CreatesIt', () => {
    const fake = makeFakeFs();

    const result = wireCatalogRegistration(
      YML,
      { path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe('registered');
    const yml = fake.files.get(YML)!;
    expect(yml).toMatch(/\.exarchos\/invariants\.md/);
  });

  it('WireCatalog_AlreadyRegistered_NoChange', () => {
    const seed =
      'invariants:\n  catalogs:\n    - { path: .exarchos/invariants.md, tier: user }\n';
    const fake = makeFakeFs({ [YML]: seed });

    const result = wireCatalogRegistration(
      YML,
      { path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('already-registered');
    expect(fake.writes.length).toBe(0);
  });

  it('WireCatalog_AlreadyRegisteredAsBareString_NoChange', () => {
    const seed =
      'invariants:\n  catalogs:\n    - .exarchos/invariants.md\n';
    const fake = makeFakeFs({ [YML]: seed });

    const result = wireCatalogRegistration(
      YML,
      { path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('already-registered');
  });

  /**
   * A malformed `invariants.catalogs` that is a scalar or a map must not throw.
   * The writer wraps the prior value in a new sequence as the first element, then appends the new registration.
   */
  it('WireCatalog_NonSequenceCatalogsNode_WrapsAndAppends', () => {
    const seed = 'invariants:\n  catalogs: legacy-string-value\n';
    const fake = makeFakeFs({ [YML]: seed });

    expect(() =>
      wireCatalogRegistration(
        YML,
        { path: '.exarchos/invariants.md', tier: 'user' },
        fake.deps,
      ),
    ).not.toThrow();

    const result = wireCatalogRegistration(
      YML,
      { path: 'docs/architecture/another.md', tier: 'user' },
      fake.deps,
    );
    expect(result.wrote).toBe(true);
    const yml = fake.files.get(YML)!;
    expect(yml).toMatch(/legacy-string-value/);
    expect(yml).toMatch(/\.exarchos\/invariants\.md/);
    expect(yml).toMatch(/docs\/architecture\/another\.md/);
  });

  it('WireCatalog_PreservesComments', () => {
    const seed = `# .exarchos.yml header comment — MUST survive.
test: npm test
# Architectural invariants (opt-in). Authoring guide:
# docs/guides/authoring-invariants.md.
# invariants:
#   devCatalog: disabled
`;
    const fake = makeFakeFs({ [YML]: seed });

    const result = wireCatalogRegistration(
      YML,
      { path: '.exarchos/invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(true);
    const yml = fake.files.get(YML)!;
    expect(yml).toContain('# .exarchos.yml header comment — MUST survive.');
    expect(yml).toContain('# Architectural invariants (opt-in). Authoring guide:');
    expect(yml).toContain('# docs/guides/authoring-invariants.md.');
    expect(yml).toMatch(/\.exarchos\/invariants\.md/);
  });

  /** The writer matches on path. An entry with the same path and another tier gets the requested tier in place, without a duplicate. */
  it('WireCatalog_SamePathDifferentTier_UpgradesInPlace', () => {
    const seed =
      'invariants:\n  catalogs:\n    - { path: .exarchos/invariants.md, tier: user }\n';
    const fake = makeFakeFs({ [YML]: seed });

    const result = wireCatalogRegistration(
      YML,
      { path: '.exarchos/invariants.md', tier: 'dev' },
      fake.deps,
    );

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe('upgraded');
    const yml = fake.files.get(YML)!;
    expect(yml).toMatch(/tier: dev/);
    expect(yml).not.toMatch(/tier: user/);
    expect(yml.match(/\.exarchos\/invariants\.md/g)?.length).toBe(1);
  });

  it('WireCatalog_SamePathSameTier_NoOp', () => {
    const seed =
      'invariants:\n  catalogs:\n    - { path: .exarchos/invariants.md, tier: dev }\n';
    const fake = makeFakeFs({ [YML]: seed });

    const result = wireCatalogRegistration(
      YML,
      { path: '.exarchos/invariants.md', tier: 'dev' },
      fake.deps,
    );

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('already-registered');
    expect(fake.writes.length).toBe(0);
  });
});
