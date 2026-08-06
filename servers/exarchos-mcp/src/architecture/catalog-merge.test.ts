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

  // ─── P1 T4: reserved-namespace keyed off the source tier ──────────────────

  it('mergeCatalogs_InvIdInDevTier_Accepted', () => {
    // An INV-* id carried by a dev-tier entry is legitimate (the dev catalog
    // owns the INV-* namespace) and must merge without ReservedNamespaceError.
    // The merged entry carries an explicit `tier: 'dev'` tag so downstream
    // consumers (doctor, conformance) can reason about provenance.
    const merged = mergeCatalogs({
      dev: [entry('INV-1', { integrityClass: 'substrate' })],
      sdlc: [],
      user: [],
    });
    const inv1 = merged.find((e) => e.id === 'INV-1');
    expect(inv1).toBeDefined();
    expect(inv1?.tier).toBe('dev');
  });

  it('mergeCatalogs_InvIdInUserTier_Rejected', () => {
    // INV-* / SDLC-* in a user-tier entry remains reserved → throws.
    expect(() =>
      mergeCatalogs({ dev: [], sdlc: [], user: [entry('INV-7')] }),
    ).toThrow(ReservedNamespaceError);
    expect(() =>
      mergeCatalogs({ dev: [], sdlc: [], user: [entry('SDLC-2')] }),
    ).toThrow(ReservedNamespaceError);
    // Non-reserved user-tier entries are tagged `tier: 'user'`.
    const merged = mergeCatalogs({
      dev: [],
      sdlc: [],
      user: [entry('team-rule')],
    });
    expect(merged.find((e) => e.id === 'team-rule')?.tier).toBe('user');
  });

  it('mergeCatalogs_SdlcId_ReservedOutsideBuiltin', () => {
    // SDLC-* belongs ONLY to the inline sdlc layer. The inline sdlc layer
    // carries it legitimately (tagged tier:sdlc); any non-builtin (user) source
    // claiming SDLC-* is rejected.
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

  it('ApplyOverrides_SeverityOverride_ReplacesContextMaps', () => {
    // A scalar `severity` override must apply in EVERY context: a shipped
    // by-phase/by-workflow map must not survive and silently ignore the
    // override (resolveSeverity ranks by-phase > by-workflow > default).
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

    // sdlc floor is advisory ⇒ lowering to advisory is permitted.
    const { entries } = applyOverrides(merged, {
      'SDLC-1': { severity: 'advisory' },
    });

    const resolved = entries.find((e) => e.id === 'SDLC-1');
    expect(resolved?.severity?.default).toBe('advisory');
    expect(resolved?.severity?.['by-phase']).toBeUndefined();
    expect(resolved?.severity?.['by-workflow']).toBeUndefined();
  });

  it('ApplyOverrides_DevSubstrate_NotPresentWhenNoDevCatalogRegistered', () => {
    // No `tier: dev` catalog registered ⇒ empty dev layer ⇒ no
    // substrate-class entries. (T-43: the dev layer is empty because nothing
    // registered it, not because a boolean was flipped off.)
    const merged = mergeCatalogs({ dev: [], sdlc: [entry('SDLC-1')], user: [] });
    expect(merged.some((e) => e.integrityClass === 'substrate')).toBe(false);

    // An override naming a (now-absent) substrate id is a no-op + warning.
    const { entries, warnings } = applyOverrides(merged, {
      'INV-1': { severity: 'advisory' },
    });
    expect(entries.some((e) => e.id === 'INV-1')).toBe(false);
    const warning = warnings.find((w) => w.includes('INV-1'));
    expect(warning).toBeDefined();

    // USER-FACING OUTPUT GUARD (T-43). This warning is read by an operator
    // deciding why their override did nothing. It used to blame the retired
    // `devCatalog` gate — a mechanism that no longer exists, so an operator
    // following it would look for a switch there is no switch for. Coverage
    // above only checked the id appeared, so the stale explanation was
    // unobserved; pin that it explains the real cause (nothing registered).
    expect(warning!.toLowerCase()).not.toContain('devcatalog');
    expect(warning).toContain('registering');
  });
});
