import { describe, it, expect } from 'vitest';
import { mergeCatalogs, applyOverrides, ReservedNamespaceError } from '../../../src/architecture/catalog-merge.js';
import type { InvariantEntry } from '../../../src/architecture/invariants-loader.js';

/** Builds an `InvariantEntry`. Only the fields that the merge and the override floor read need real values. */
function entry(id: string, overrides: Partial<InvariantEntry> = {}): InvariantEntry {
  return {
    id,
    dimension: 'test',
    axis: 'substrate',
    costOfLoad: 'always-load',
    appliesTo: [],
    summary: 'summary',
    references: [],
    raw: {},
    ...overrides,
  };
}

describe('mergeCatalogs', () => {
  /** A dev entry keeps its integrity-class. An sdlc entry and a user entry get the class of their layer. */
  it('MergeCatalogs_DevSdlcUser_PreservesLayerOrigin', () => {
    const dev = [entry('INV-1', { integrityClass: 'substrate' })];
    const sdlc = [entry('SDLC-1')];
    const user = [entry('my-rule')];

    const merged = mergeCatalogs({ dev, sdlc, user });

    const byId = new Map(merged.map((e) => [e.id, e]));
    expect(byId.get('INV-1')?.integrityClass).toBe('substrate');
    expect(byId.get('SDLC-1')?.integrityClass).toBe('sdlc');
    expect(byId.get('my-rule')?.integrityClass).toBe('user');
    expect(merged).toHaveLength(3);
  });

  it('MergeCatalogs_UserReservedId_FailsValidation', () => {
    expect(() =>
      mergeCatalogs({ dev: [], sdlc: [], user: [entry('INV-99')] }),
    ).toThrow(ReservedNamespaceError);
    expect(() =>
      mergeCatalogs({ dev: [], sdlc: [], user: [entry('SDLC-5')] }),
    ).toThrow(/SDLC-5/);
  });

  /**
   * The dev catalog owns the `INV-*` namespace, so a dev entry with that id merges with no error.
   * The merged entry has `tier: 'dev'`, so a consumer can read its source.
   */
  it('mergeCatalogs_InvIdInDevTier_Accepted', () => {
    const merged = mergeCatalogs({
      dev: [entry('INV-1', { integrityClass: 'substrate' })],
      sdlc: [],
      user: [],
    });
    const inv1 = merged.find((e) => e.id === 'INV-1');
    expect(inv1).toBeDefined();
    expect(inv1?.tier).toBe('dev');
  });

  /** A user entry with a reserved id throws. A user entry with a free id gets `tier: 'user'`. */
  it('mergeCatalogs_InvIdInUserTier_Rejected', () => {
    expect(() =>
      mergeCatalogs({ dev: [], sdlc: [], user: [entry('INV-7')] }),
    ).toThrow(ReservedNamespaceError);
    expect(() =>
      mergeCatalogs({ dev: [], sdlc: [], user: [entry('SDLC-2')] }),
    ).toThrow(ReservedNamespaceError);
    const merged = mergeCatalogs({
      dev: [],
      sdlc: [],
      user: [entry('team-rule')],
    });
    expect(merged.find((e) => e.id === 'team-rule')?.tier).toBe('user');
  });

  /** Only the sdlc layer can hold an `SDLC-*` id, and that entry gets `tier: 'sdlc'`. The user layer cannot. */
  it('mergeCatalogs_SdlcId_ReservedOutsideBuiltin', () => {
    const merged = mergeCatalogs({
      dev: [],
      sdlc: [entry('SDLC-1')],
      user: [],
    });
    expect(merged.find((e) => e.id === 'SDLC-1')?.tier).toBe('sdlc');
    expect(() =>
      mergeCatalogs({ dev: [], sdlc: [], user: [entry('SDLC-9')] }),
    ).toThrow(/SDLC-9/);
  });
});

describe('applyOverrides', () => {
  /** The sdlc floor is `advisory`, so `enabled: false` clamps the entry and does not remove it. */
  it('ApplyOverrides_DisableBelowFloor_ClampsToAdvisoryWithWarning', () => {
    const merged = mergeCatalogs({
      dev: [],
      sdlc: [entry('SDLC-1')],
      user: [],
    });

    const { entries, warnings } = applyOverrides(merged, {
      'SDLC-1': { enabled: false },
    });

    const resolved = entries.find((e) => e.id === 'SDLC-1');
    expect(resolved).toBeDefined();
    expect(resolved?.severity?.default).toBe('advisory');
    expect(warnings.some((w) => w.includes('SDLC-1'))).toBe(true);
  });

  /**
   * The clamp must drop the `by-phase` and `by-workflow` maps. `resolveSeverity` ranks them above
   * `default`, so a kept map makes the clamped invariant blocking again in that context.
   */
  it('ApplyOverrides_DisableBelowFloor_ClampNeutralizesByPhaseAndByWorkflow', () => {
    const merged = mergeCatalogs({
      dev: [],
      sdlc: [
        entry('SDLC-1', {
          severity: {
            default: 'blocking',
            'by-phase': { review: 'blocking' },
            'by-workflow': { feature: 'blocking' },
          },
        }),
      ],
      user: [],
    });

    const { entries } = applyOverrides(merged, {
      'SDLC-1': { enabled: false },
    });

    const resolved = entries.find((e) => e.id === 'SDLC-1');
    expect(resolved?.severity?.default).toBe('advisory');
    expect(resolved?.severity?.['by-phase']).toBeUndefined();
    expect(resolved?.severity?.['by-workflow']).toBeUndefined();
  });

  /**
   * A `severity` override must apply in every context, so it also drops the `by-phase` and
   * `by-workflow` maps. The sdlc floor is `advisory`, which permits an override to `advisory`.
   */
  it('ApplyOverrides_SeverityOverride_ReplacesContextMaps', () => {
    const merged = mergeCatalogs({
      dev: [],
      sdlc: [
        entry('SDLC-1', {
          severity: {
            default: 'blocking',
            'by-phase': { review: 'blocking' },
            'by-workflow': { feature: 'blocking' },
          },
        }),
      ],
      user: [],
    });

    const { entries } = applyOverrides(merged, {
      'SDLC-1': { severity: 'advisory' },
    });

    const resolved = entries.find((e) => e.id === 'SDLC-1');
    expect(resolved?.severity?.default).toBe('advisory');
    expect(resolved?.severity?.['by-phase']).toBeUndefined();
    expect(resolved?.severity?.['by-workflow']).toBeUndefined();
  });

  /**
   * With no registered dev catalog, the dev layer is empty and no entry is substrate-class.
   * An override for an absent substrate id changes nothing and adds a warning.
   * An operator reads that warning, so it must give the real cause: no catalog registers the id.
   * It must not blame the `devCatalog` key, which has no effect.
   */
  it('ApplyOverrides_DevSubstrate_NotPresentWhenNoDevCatalogRegistered', () => {
    const merged = mergeCatalogs({ dev: [], sdlc: [entry('SDLC-1')], user: [] });
    expect(merged.some((e) => e.integrityClass === 'substrate')).toBe(false);

    const { entries, warnings } = applyOverrides(merged, {
      'INV-1': { severity: 'advisory' },
    });
    expect(entries.some((e) => e.id === 'INV-1')).toBe(false);
    const warning = warnings.find((w) => w.includes('INV-1'));
    expect(warning).toBeDefined();

    expect(warning!.toLowerCase()).not.toContain('devcatalog');
    expect(warning).toContain('registering');
  });
});
