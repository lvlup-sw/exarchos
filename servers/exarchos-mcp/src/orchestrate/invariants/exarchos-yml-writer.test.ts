/**
 * T10 — `.exarchos.yml` catalog-registration writer tests.
 *
 * Shared by T6 (scaffold) and T9 (add). Appends `{ path, tier }` to
 * `invariants.catalogs` if absent; idempotent; comment-preserving (uses the
 * `yaml` package's `Document`/`parseDocument` round-trip so the seeded
 * onboarding comment stanza survives).
 */
import { describe, it, expect } from 'vitest';

import { wireCatalogRegistration } from './exarchos-yml-writer.js';
import type { YmlWriterDeps } from './exarchos-yml-writer.js';

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
      { path: 'docs/architecture/my-invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe('registered');
    const yml = fake.files.get(YML)!;
    expect(yml).toMatch(/invariants:/);
    expect(yml).toMatch(/catalogs:/);
    expect(yml).toMatch(/docs\/architecture\/my-invariants\.md/);
    expect(yml).toMatch(/tier: user/);
  });

  it('WireCatalog_NoConfigFile_CreatesIt', () => {
    const fake = makeFakeFs();

    const result = wireCatalogRegistration(
      YML,
      { path: 'docs/architecture/my-invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(true);
    expect(result.reason).toBe('registered');
    const yml = fake.files.get(YML)!;
    expect(yml).toMatch(/docs\/architecture\/my-invariants\.md/);
  });

  it('WireCatalog_AlreadyRegistered_NoChange', () => {
    const seed =
      'invariants:\n  catalogs:\n    - { path: docs/architecture/my-invariants.md, tier: user }\n';
    const fake = makeFakeFs({ [YML]: seed });

    const result = wireCatalogRegistration(
      YML,
      { path: 'docs/architecture/my-invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('already-registered');
    // No write at all.
    expect(fake.writes.length).toBe(0);
  });

  it('WireCatalog_AlreadyRegisteredAsBareString_NoChange', () => {
    const seed =
      'invariants:\n  catalogs:\n    - docs/architecture/my-invariants.md\n';
    const fake = makeFakeFs({ [YML]: seed });

    const result = wireCatalogRegistration(
      YML,
      { path: 'docs/architecture/my-invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('already-registered');
  });

  it('WireCatalog_NonSequenceCatalogsNode_WrapsAndAppends', () => {
    // #1487 review: a malformed `invariants.catalogs` that is a non-sequence
    // (scalar/map) value must not throw on `.add`. The writer wraps the prior
    // value into a fresh sequence, then appends the new registration.
    const seed = 'invariants:\n  catalogs: legacy-string-value\n';
    const fake = makeFakeFs({ [YML]: seed });

    expect(() =>
      wireCatalogRegistration(
        YML,
        { path: 'docs/architecture/my-invariants.md', tier: 'user' },
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
    // The prior scalar is preserved as the first sequence element, and the
    // new registration is appended.
    expect(yml).toMatch(/legacy-string-value/);
    expect(yml).toMatch(/docs\/architecture\/my-invariants\.md/);
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
      { path: 'docs/architecture/my-invariants.md', tier: 'user' },
      fake.deps,
    );

    expect(result.wrote).toBe(true);
    const yml = fake.files.get(YML)!;
    // The seeded comment stanza survives the round-trip edit.
    expect(yml).toContain('# .exarchos.yml header comment — MUST survive.');
    expect(yml).toContain('# Architectural invariants (opt-in). Authoring guide:');
    expect(yml).toContain('# docs/guides/authoring-invariants.md.');
    // And the new registration is present.
    expect(yml).toMatch(/docs\/architecture\/my-invariants\.md/);
  });
});
