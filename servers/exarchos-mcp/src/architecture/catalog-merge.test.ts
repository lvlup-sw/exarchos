import { describe, it, expect } from 'vitest';
import { mergeCatalogs, applyOverrides, ReservedNamespaceError } from './catalog-merge.js';
import type { InvariantEntry } from './invariants-loader.js';

/**
 * Minimal `InvariantEntry` factory for tests. Only the fields the
 * catalog-merge / override-floor logic reads are meaningful; the rest are
 * filled with benign defaults so the shape type-checks.
 */
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
  it('MergeCatalogs_DevSdlcUser_PreservesLayerOrigin', () => {
    const dev = [entry('INV-1', { integrityClass: 'substrate' })];
    const sdlc = [entry('SDLC-1')];
    const user = [entry('my-rule')];

    const merged = mergeCatalogs({ dev, sdlc, user });

    const byId = new Map(merged.map((e) => [e.id, e]));
    // Dev layer entries keep whatever integrity-class they already carry.
    expect(byId.get('INV-1')?.integrityClass).toBe('substrate');
    // SDLC layer entries are tagged `sdlc`.
    expect(byId.get('SDLC-1')?.integrityClass).toBe('sdlc');
    // User layer entries are tagged `user`.
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
});

describe('applyOverrides', () => {
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
    // sdlc floor is `advisory`: a disable is clamped, not honored.
    expect(resolved).toBeDefined();
    expect(resolved?.severity?.default).toBe('advisory');
    expect(warnings.some((w) => w.includes('SDLC-1'))).toBe(true);
  });

  it('ApplyOverrides_DisableBelowFloor_ClampNeutralizesByPhaseAndByWorkflow', () => {
    // A clamp-to-advisory must be TOTAL: a shipped by-phase/by-workflow map
    // must not survive and silently re-escalate the clamped invariant to
    // blocking (resolveSeverity ranks by-phase > by-workflow > default).
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
    // The context maps are dropped, so NO context can resolve to blocking.
    expect(resolved?.severity?.['by-phase']).toBeUndefined();
    expect(resolved?.severity?.['by-workflow']).toBeUndefined();
  });

  it('ApplyOverrides_DevSubstrate_NotPresentWhenDevCatalogDisabled', () => {
    // devCatalog disabled ⇒ empty dev layer ⇒ no substrate-class entries.
    const merged = mergeCatalogs({ dev: [], sdlc: [entry('SDLC-1')], user: [] });
    expect(merged.some((e) => e.integrityClass === 'substrate')).toBe(false);

    // An override naming a (now-absent) substrate id is a no-op + warning.
    const { entries, warnings } = applyOverrides(merged, {
      'INV-1': { severity: 'advisory' },
    });
    expect(entries.some((e) => e.id === 'INV-1')).toBe(false);
    expect(warnings.some((w) => w.includes('INV-1'))).toBe(true);
  });
});
