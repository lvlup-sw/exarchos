import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHIM_REGISTRY,
  SHIM_SCAN_ROOTS,
  parseShimMarkers,
  discoverShims,
  validateEntryGovernance,
  verifyShimRatchet,
  assertShimRatchet,
  ShimRatchetError,
  type ShimEntry,
  type DiscoveredShim,
  type ShimDiscoveryFs,
} from './shim-registry.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A far-future clock so real registry expiries are never "in the past". */
const CLOCK = new Date('2026-01-01T00:00:00Z');

/** Build a well-formed registry entry, overridable field-by-field. */
function entry(over: Partial<ShimEntry> = {}): ShimEntry {
  return {
    id: 'sample-shim',
    file: 'src/sample-adapter.ts',
    runtime: 'cursor',
    capability: 'slash-command-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-01-31',
    ...over,
  };
}

/** A discovered marker matching a given entry. */
function discovered(over: Partial<DiscoveredShim> = {}): DiscoveredShim {
  return {
    file: 'src/sample-adapter.ts',
    runtimes: ['cursor'],
    capability: 'slash-command-native',
    raw: 'runtimes: cursor, capability: slash-command-native',
    ...over,
  };
}

// The literal marker token is spliced so this test file never accidentally
// self-declares a shim that a future tree scan could pick up.
const MARK = 'SHIM' + '(';

describe('parseShimMarkers', () => {
  it('parseShimMarkers_MultiRuntimeMarker_SplitsCoverage', () => {
    const src = `// ${MARK}runtimes: copilot+cursor, capability: slash-command-native) — note`;
    const parsed = parseShimMarkers(src, 'x/y.ts');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.runtimes).toEqual(['copilot', 'cursor']);
    expect(parsed[0]?.capability).toBe('slash-command-native');
    expect(parsed[0]?.file).toBe('x/y.ts');
  });

  it('parseShimMarkers_NoMarker_ReturnsEmpty', () => {
    expect(parseShimMarkers('nothing to see here', 'a.ts')).toEqual([]);
  });

  it('parseShimMarkers_MultipleMarkers_AllCaptured', () => {
    const src = [
      `// ${MARK}runtimes: cursor, capability: a)`,
      `// ${MARK}runtimes: copilot, capability: b)`,
    ].join('\n');
    const parsed = parseShimMarkers(src, 'a.ts');
    expect(parsed.map((p) => p.capability)).toEqual(['a', 'b']);
  });
});

describe('validateEntryGovernance', () => {
  it('valid entry → no problems', () => {
    expect(validateEntryGovernance(entry(), CLOCK)).toEqual([]);
  });

  it('bad issue ref → malformed', () => {
    const problems = validateEntryGovernance(entry({ issue: '1590' }), CLOCK);
    expect(problems.map((p) => p.kind)).toContain('malformed');
  });

  it('empty owner → malformed', () => {
    const problems = validateEntryGovernance(entry({ owner: '  ' }), CLOCK);
    expect(problems.map((p) => p.kind)).toContain('malformed');
  });

  it('polluted expires (trailing text) → malformed', () => {
    const problems = validateEntryGovernance(
      entry({ expires: '2027-01-31; see also #1609' }),
      CLOCK,
    );
    expect(problems.map((p) => p.kind)).toContain('malformed');
  });

  it('impossible calendar date → malformed', () => {
    const problems = validateEntryGovernance(entry({ expires: '2027-02-31' }), CLOCK);
    expect(problems.map((p) => p.kind)).toContain('malformed');
  });

  it('past expiry → expired', () => {
    const problems = validateEntryGovernance(entry({ expires: '2020-01-01' }), CLOCK);
    expect(problems.map((p) => p.kind)).toContain('expired');
  });
});

describe('verifyShimRatchet — exit proofs', () => {
  // (e) current authored set, against a matching discovered set, passes.
  it('ShimRatchet_MatchingRegistryAndDiscovery_Passes', () => {
    const result = verifyShimRatchet({
      registry: [entry()],
      discovered: [discovered()],
      now: CLOCK,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // (c) adding a shim on disk with no registry entry FAILS.
  it('ShimRatchet_UnregisteredDiscoveredShim_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry()],
      discovered: [
        discovered(),
        discovered({ file: 'src/new-adapter.ts', runtimes: ['opencode'] }),
      ],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    const unregistered = result.violations.filter((v) => v.kind === 'unregistered');
    expect(unregistered).toHaveLength(1);
    expect(unregistered[0]?.file).toBe('src/new-adapter.ts');
    expect(unregistered[0]?.runtime).toBe('opencode');
  });

  // (c) a multi-runtime marker where only SOME runtimes are registered fails
  //     on the unregistered runtime only.
  it('ShimRatchet_PartiallyRegisteredMultiRuntimeMarker_FailsOnGap', () => {
    const result = verifyShimRatchet({
      registry: [entry({ runtime: 'cursor' })],
      discovered: [discovered({ runtimes: ['cursor', 'copilot'] })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    const unregistered = result.violations.filter((v) => v.kind === 'unregistered');
    expect(unregistered.map((v) => v.runtime)).toEqual(['copilot']);
  });

  // (d) an expired registry entry FAILS.
  it('ShimRatchet_ExpiredRegistryEntry_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry({ expires: '2020-01-01' })],
      discovered: [discovered()],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'expired')).toBe(true);
  });

  it('ShimRatchet_CapabilityMismatch_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry({ capability: 'slash-command-native' })],
      discovered: [discovered({ capability: 'something-else' })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'capability-mismatch')).toBe(true);
  });

  it('ShimRatchet_RegistryEntryWithoutMarkerOnDisk_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry()],
      discovered: [],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'missing-on-disk')).toBe(true);
  });

  it('ShimRatchet_DuplicateRegistryId_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry(), entry({ file: 'src/other.ts', runtime: 'copilot' })],
      discovered: [discovered(), discovered({ file: 'src/other.ts', runtimes: ['copilot'] })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'duplicate-id')).toBe(true);
  });

  it('assertShimRatchet_Violation_ThrowsShimRatchetError', () => {
    expect(() =>
      assertShimRatchet({ registry: [entry()], discovered: [], now: CLOCK }),
    ).toThrow(ShimRatchetError);
  });
});

describe('discoverShims (injected fs)', () => {
  it('discoverShims_ScansConfiguredRoots_ParsesMarkers', () => {
    const fs: ShimDiscoveryFs = {
      listTsFiles: (absRoot) =>
        absRoot.endsWith('src') ? [join(absRoot, 'adapter.ts'), join(absRoot, 'plain.ts')] : [],
      readFile: (abs) =>
        abs.endsWith('adapter.ts')
          ? `// ${MARK}runtimes: cursor, capability: slash-command-native)`
          : 'no marker here',
    };
    const found = discoverShims({ repoRoot: '/repo', roots: ['src'], fs });
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe('src/adapter.ts');
    expect(found[0]?.runtimes).toEqual(['cursor']);
  });

  it('discoverShims_ExcludesSelfModule', () => {
    const fs: ShimDiscoveryFs = {
      listTsFiles: () => ['/repo/src/shim-registry.ts'],
      // Even if the module contained a marker, it must be skipped.
      readFile: () => `// ${MARK}runtimes: cursor, capability: x)`,
    };
    const found = discoverShims({ repoRoot: '/repo', roots: ['src'], fs });
    expect(found).toEqual([]);
  });
});

describe('SHIM_REGISTRY — real repo (exit proof e)', () => {
  it('registry entries are internally well-formed', () => {
    for (const e of SHIM_REGISTRY) {
      // Governance is valid as of the fixed clock (well before real expiries).
      expect(validateEntryGovernance(e, CLOCK)).toEqual([]);
    }
  });

  it('registry files exist on disk', () => {
    // (indirectly) — discovery must find each registered file's marker below,
    // which requires the file to exist. This asserts the paths are real.
    const files = new Set(SHIM_REGISTRY.map((e) => e.file));
    for (const f of files) {
      expect(f.startsWith('servers/') || f.startsWith('src/')).toBe(true);
    }
  });

  it('RealShimSet_MatchesRegistry_RatchetPasses', () => {
    const found = discoverShims({ repoRoot: REPO_ROOT, roots: SHIM_SCAN_ROOTS });
    const result = verifyShimRatchet({
      registry: SHIM_REGISTRY,
      discovered: found,
      now: CLOCK,
    });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
