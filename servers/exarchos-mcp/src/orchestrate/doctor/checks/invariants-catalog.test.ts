import { describe, it, expect } from 'vitest';
import { makeStubProbes } from './__shared__/make-stub-probes.js';
import { invariantsCatalog } from './invariants-catalog.js';

const controller = () => new AbortController().signal;

describe('invariantsCatalog', () => {
  it('InvariantsCatalog_ValidCatalog_NoWarnings_ReturnsPass', async () => {
    const probes = makeStubProbes({
      invariants: { resolve: async () => ({ entryCount: 19, warnings: [] }) },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.category).toBe('invariants');
    expect(result.name).toBe('invariants-catalog');
    expect(result.status).toBe('Pass');
    expect(result.message).toContain('19');
    expect(result.fix).toBeUndefined();
  });

  it('InvariantsCatalog_MalformedUserCatalog_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      invariants: {
        resolve: async () => ({
          entryCount: 19,
          warnings: [
            "User invariant catalog 'docs/architecture/mine.md' failed to load and was skipped. Reason: bad YAML",
          ],
        }),
      },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('mine.md');
    expect(result.fix).toBeDefined();
    expect(result.fix!.length).toBeGreaterThan(0);
  });

  it('InvariantsCatalog_ReservedNamespaceId_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      invariants: {
        resolve: async () => ({
          entryCount: 19,
          warnings: [
            "User catalog entry 'INV-99' uses a reserved id namespace (INV-*, SDLC-*) and was skipped; rename it.",
          ],
        }),
      },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('INV-99');
    expect(result.fix).toBeDefined();
  });

  it('InvariantsCatalog_NoCatalogConfigured_ReturnsSkipped', async () => {
    // entryCount 0 with no warnings means the dev catalog is disabled and no
    // user catalogs are configured — nothing to validate (DIM-2: no silent
    // skip; reason is populated).
    const probes = makeStubProbes({
      invariants: { resolve: async () => ({ entryCount: 0, warnings: [] }) },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.status).toBe('Skipped');
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
  });
});
