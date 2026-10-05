import { describe, it, expect } from 'vitest';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import { invariantsCatalog } from '../../../../../src/verbs/doctor/checks/invariants-catalog.js';

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

  /**
   * `configured: false` with no warnings means that `invariants.catalogs` registers nothing.
   * The check skips, and the skip must carry a reason.
   */
  it('InvariantsCatalog_NoCatalogConfigured_ReturnsSkipped', async () => {
    const probes = makeStubProbes({
      invariants: { resolve: async () => ({ configured: false, warnings: [] }) },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.status).toBe('Skipped');
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  /**
   * An operator reads `reason` and acts on it. The text must name the remedy that works,
   * registration in `invariants.catalogs`. It must not name the retired `devCatalog` flag.
   */
  it('InvariantsCatalog_SkipReason_NamesRegistrationNotRetiredFlag', async () => {
    const probes = makeStubProbes({
      invariants: { resolve: async () => ({ configured: false, warnings: [] }) },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.status).toBe('Skipped');
    expect(result.reason).toContain('invariants.catalogs');
    expect(result.reason!.toLowerCase()).not.toContain('devcatalog');
    expect(result.message.toLowerCase()).not.toContain('devcatalog');
  });

  /**
   * The check decides on `configured`, not on an entry count for one phase.
   * A registered catalog with no entry for the resolver phase gives `configured: true`
   * and no warnings. It must Pass, not Skip.
   */
  it('InvariantsCatalog_ConfiguredButNoPhaseMatchingEntries_StillPasses', async () => {
    const probes = makeStubProbes({
      invariants: { resolve: async () => ({ configured: true, warnings: [] }) },
    });

    const result = await invariantsCatalog(probes, controller());

    expect(result.status).toBe('Pass');
  });
});
