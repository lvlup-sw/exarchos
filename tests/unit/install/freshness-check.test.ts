import { describe, it, expect } from 'vitest';
import { buildInstallIdentity, type RawInstallInputs } from '../../../src/install/install-identity.js';
import {
  assertInstallFreshness,
  verifyInstallFreshness,
  InstallFreshnessError,
  FRESHNESS_DIMENSIONS,
  type FreshnessDimension,
} from '../../../src/install/freshness-check.js';

// ─── Exit proof (P05-04) ────────────────────────────────────────────────────
//
// "Matching installations proceed; independently seeded binary, plugin, skill,
//  schema, and cache mismatches block before workflow execution."
//
// The `expected` identity is what the running binary requires; `observed` is
// what is actually installed at the runtime locations. Each of the five
// dimensions is independently seedable and independently blocking.

const BASE_RAW: RawInstallInputs = {
  binaryVersion: '2.12.0',
  binaryEntries: [{ path: 'bin/exarchos', content: 'BINARY-BYTES' }],
  pluginManifest: '{"name":"exarchos","version":"2.12.0"}',
  skillEntries: [{ path: 'skills/claude/a/SKILL.md', content: 'skill a\n' }],
  schemaVersion: 6,
  cacheLocation: '/home/u/.exarchos/cache',
  cacheEntries: [{ path: 'index.json', content: '{}' }],
};

const EXPECTED = buildInstallIdentity(BASE_RAW);

/** Build an observed identity from the base inputs with one dimension seeded. */
function observedWith(overrides: Partial<RawInstallInputs>): ReturnType<typeof buildInstallIdentity> {
  return buildInstallIdentity({ ...BASE_RAW, ...overrides });
}

/** The single-dimension seeds that drive the exit-proof matrix. */
const SEEDS: Record<Exclude<FreshnessDimension, 'schema'>, Partial<RawInstallInputs>> & {
  schema: Partial<RawInstallInputs>;
} = {
  binary: { binaryVersion: '2.13.0' }, // user upgraded the binary
  plugin: { pluginManifest: '{"name":"exarchos","version":"2.11.0"}' }, // stale plugin
  skill: { skillEntries: [{ path: 'skills/claude/a/SKILL.md', content: 'STALE skill a\n' }] },
  schema: { schemaVersion: 7 }, // store written by a newer binary
  cache: { cacheEntries: [{ path: 'index.json', content: '{"stale":true}' }] },
};

describe('install freshness — exit proof (P05-04)', () => {
  it('matching installation proceeds (no throw, fresh result)', () => {
    const observed = buildInstallIdentity(BASE_RAW);
    expect(verifyInstallFreshness(EXPECTED, observed)).toEqual({ fresh: true });
    expect(() => assertInstallFreshness(EXPECTED, observed)).not.toThrow();
  });

  for (const dimension of FRESHNESS_DIMENSIONS) {
    it(`independently blocks a seeded ${dimension} mismatch`, () => {
      const observed = observedWith(SEEDS[dimension]);

      const result = verifyInstallFreshness(EXPECTED, observed);
      expect(result.fresh).toBe(false);
      if (result.fresh) throw new Error('unreachable');

      // Exactly this one dimension is flagged — the seeds are independent.
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0]?.dimension).toBe(dimension);
      expect(result.mismatches[0]?.remediation.length ?? 0).toBeGreaterThan(0);

      // ...and the gate blocks with a typed error naming the dimension.
      let caught: unknown;
      try {
        assertInstallFreshness(EXPECTED, observed);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InstallFreshnessError);
      const typed = caught as InstallFreshnessError;
      expect(typed.code).toBe('INSTALL_FRESHNESS_MISMATCH');
      expect(typed.mismatches.map((m) => m.dimension)).toEqual([dimension]);
      expect(typed.message).toContain(dimension);
    });
  }
});

// ─── Schema directional policy (P05-04, ART-009) ────────────────────────────

describe('install freshness — schema directionality', () => {
  it('does NOT block an OLDER store (forward-migrated on open)', () => {
    const observed = observedWith({ schemaVersion: 5 });
    const result = verifyInstallFreshness(EXPECTED, observed);
    // Only the schema dimension is in play here; older must pass.
    expect(result).toEqual({ fresh: true });
    expect(() => assertInstallFreshness(EXPECTED, observed)).not.toThrow();
  });

  it('does NOT block an EQUAL store', () => {
    const observed = observedWith({ schemaVersion: 6 });
    expect(verifyInstallFreshness(EXPECTED, observed)).toEqual({ fresh: true });
  });

  it('BLOCKS a NEWER store', () => {
    const observed = observedWith({ schemaVersion: 7 });
    expect(() => assertInstallFreshness(EXPECTED, observed)).toThrow(InstallFreshnessError);
  });
});

// ─── Aggregate reporting (P05-04) ───────────────────────────────────────────

describe('install freshness — aggregate reporting', () => {
  it('reports every mismatched dimension, not just the first', () => {
    const observed = observedWith({
      binaryVersion: '9.9.9',
      cacheEntries: [{ path: 'index.json', content: 'STALE' }],
    });
    const result = verifyInstallFreshness(EXPECTED, observed);
    expect(result.fresh).toBe(false);
    if (result.fresh) throw new Error('unreachable');
    expect(result.mismatches.map((m) => m.dimension)).toEqual(['binary', 'cache']);
  });

  it('preserves the stable dimension order (binary→plugin→skill→schema→cache)', () => {
    const observed = observedWith({
      binaryVersion: '9.9.9',
      pluginManifest: 'stale',
      skillEntries: [{ path: 'skills/claude/a/SKILL.md', content: 'stale' }],
      schemaVersion: 8,
      cacheEntries: [{ path: 'index.json', content: 'stale' }],
    });
    const result = verifyInstallFreshness(EXPECTED, observed);
    expect(result.fresh).toBe(false);
    if (result.fresh) throw new Error('unreachable');
    expect(result.mismatches.map((m) => m.dimension)).toEqual([
      'binary',
      'plugin',
      'skill',
      'schema',
      'cache',
    ]);
  });
});
