import { describe, it, expect } from 'vitest';
import { makeStubProbes } from './__shared__/make-stub-probes.js';
import { invariantsCatalog } from './invariants-catalog.js';

const controller = () => new AbortController().signal;

describe('invariantsCatalog', () => {
  it('InvariantsCatalog_ConfiguredNoWarnings_ReturnsPass', async () => {
    const probes = makeStubProbes({
      invariants: { resolve: async () => ({ configured: true, warnings: [] }) },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.category).toBe('invariants');
    expect(result.name).toBe('invariants-catalog');
    expect(result.status).toBe('Pass');
    expect(result.fix).toBeUndefined();
  });

  it('InvariantsCatalog_MalformedUserCatalog_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      invariants: {
        resolve: async () => ({
          configured: true,
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
          configured: true,
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
    // configured:false with no warnings means the dev catalog is disabled and
    // no user catalogs are configured — nothing to validate (DIM-2: no silent
    // skip; reason is populated).
    const probes = makeStubProbes({
      invariants: { resolve: async () => ({ configured: false, warnings: [] }) },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.status).toBe('Skipped');
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it('InvariantsCatalog_ConfiguredButNoPhaseMatchingEntries_StillPasses', async () => {
    // Regression for the Seer MEDIUM (#1482): the decision keys off `configured`,
    // not a phase-projected entry count. A catalog that IS configured and loaded
    // cleanly but whose entries do not project to the resolver's phase (e.g. all
    // `phase-affinity: ['review']`) must Pass — never Skip as "nothing
    // configured". The resolver surfaces this as configured:true, warnings:[].
    const probes = makeStubProbes({
      invariants: { resolve: async () => ({ configured: true, warnings: [] }) },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.status).toBe('Pass');
  });
});
