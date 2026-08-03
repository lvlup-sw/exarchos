import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADVISORY_REGISTRY,
  parseAdvisoryMarkers,
  discoverAdvisories,
  validateAdvisoryGovernance,
  verifyAdvisoryRatchet,
  assertAdvisoryRatchet,
  AdvisoryRatchetError,
  type AdvisoryEntry,
  type DiscoveredAdvisory,
  type KillProbeResult,
} from './advisory-registry.js';
import { runAllKillProbes } from './advisory-kill-probes.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A far-future clock so real registry expiries are never "in the past". */
const CLOCK = new Date('2026-01-01T00:00:00Z');

/** Build a well-formed registry entry, overridable field-by-field. */
function entry(over: Partial<AdvisoryEntry> = {}): AdvisoryEntry {
  return {
    id: 'sample-advisory',
    file: 'scripts/sample-advisory.mjs',
    control: 'sample-control',
    owner: 'exarchos',
    promotionThreshold: 'measured evidence X over two release trains',
    removalThreshold: 'the checked seam is retired',
    issue: '#1590',
    expires: '2099-01-01',
    killFixture: 'sample-probe',
    ciPath: '.github/workflows/ci.yml',
    ...over,
  };
}

/** A discovered marker matching a given entry. */
function discovered(over: Partial<DiscoveredAdvisory> = {}): DiscoveredAdvisory {
  return {
    file: 'scripts/sample-advisory.mjs',
    control: 'sample-control',
    raw: 'control: sample-control',
    ...over,
  };
}

/** A HEALTHY probe result for a given entry (fires on violation, silent on clean). */
function probe(e: AdvisoryEntry, over: Partial<KillProbeResult> = {}): KillProbeResult {
  return {
    advisoryId: e.id,
    killFixture: e.killFixture,
    firedOnViolation: true,
    firedOnClean: false,
    ...over,
  };
}

describe('validateAdvisoryGovernance', () => {
  it('AdvisoryGovernance_CompleteEntry_NoProblems', () => {
    expect(validateAdvisoryGovernance(entry(), CLOCK)).toEqual([]);
  });

  // (b) an advisory missing ANY field FAILS — exhaustively, one field at a time.
  const emptyable: ReadonlyArray<keyof AdvisoryEntry> = [
    'owner',
    'promotionThreshold',
    'removalThreshold',
    'killFixture',
  ];
  for (const field of emptyable) {
    it(`AdvisoryGovernance_Missing_${field}_IsMalformed`, () => {
      const problems = validateAdvisoryGovernance(entry({ [field]: '   ' } as Partial<AdvisoryEntry>), CLOCK);
      expect(problems.some((p) => p.kind === 'malformed' && p.detail.includes(field))).toBe(true);
    });
  }

  it('AdvisoryGovernance_BadIssueRef_IsMalformed', () => {
    const problems = validateAdvisoryGovernance(entry({ issue: 'PR-42' }), CLOCK);
    expect(problems.some((p) => p.kind === 'malformed' && p.detail.includes('issue'))).toBe(true);
  });

  it('AdvisoryGovernance_CiPathNotAWorkflow_IsMalformed', () => {
    const problems = validateAdvisoryGovernance(entry({ ciPath: 'scripts/somewhere.sh' }), CLOCK);
    expect(problems.some((p) => p.kind === 'malformed' && p.detail.includes('ciPath'))).toBe(true);
  });

  it('AdvisoryGovernance_CiPathMustBeUnfilteredWorkflowYml', () => {
    // A bare workflow name (not under .github/workflows) is rejected.
    expect(
      validateAdvisoryGovernance(entry({ ciPath: 'ci.yml' }), CLOCK).some((p) => p.kind === 'malformed'),
    ).toBe(true);
    // The canonical form is accepted.
    expect(
      validateAdvisoryGovernance(entry({ ciPath: '.github/workflows/ci.yml' }), CLOCK),
    ).toEqual([]);
  });

  // (c) an expired advisory FAILS.
  it('AdvisoryGovernance_PastExpiry_IsExpired', () => {
    const problems = validateAdvisoryGovernance(entry({ expires: '2020-01-01' }), CLOCK);
    expect(problems.some((p) => p.kind === 'expired')).toBe(true);
  });

  it('AdvisoryGovernance_MalformedExpiry_IsMalformed', () => {
    expect(
      validateAdvisoryGovernance(entry({ expires: '2027-13-40' }), CLOCK).some(
        (p) => p.kind === 'malformed',
      ),
    ).toBe(true);
    expect(
      validateAdvisoryGovernance(entry({ expires: 'soon' }), CLOCK).some((p) => p.kind === 'malformed'),
    ).toBe(true);
  });

  it('AdvisoryGovernance_ExpiryOnTheDay_IsNotExpired', () => {
    // Boundary: the whole expiry day is still valid.
    const onDay = new Date('2099-01-01T23:59:59Z');
    expect(validateAdvisoryGovernance(entry({ expires: '2099-01-01' }), onDay)).toEqual([]);
  });
});

describe('parseAdvisoryMarkers', () => {
  it('AdvisoryMarker_Parses_ControlField', () => {
    const src = '# ' + 'ADVISORY(control: benchmark-regression) — non-blocking perf check\n';
    const [m] = parseAdvisoryMarkers(src, 'scripts/x.sh');
    expect(m).toBeDefined();
    expect(m?.control).toBe('benchmark-regression');
    expect(m?.file).toBe('scripts/x.sh');
  });

  it('AdvisoryMarker_NoMarker_Empty', () => {
    expect(parseAdvisoryMarkers('no marker here', 'scripts/x.sh')).toEqual([]);
  });
});

describe('verifyAdvisoryRatchet', () => {
  it('AdvisoryRatchet_RegisteredAndDiscoveredAndProbed_Ok', () => {
    const e = entry();
    const result = verifyAdvisoryRatchet({
      registry: [e],
      discovered: [discovered()],
      probeResults: [probe(e)],
      now: CLOCK,
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('AdvisoryRatchet_UnregisteredMarker_Fails', () => {
    // A marker on disk with NO registry entry — the count grew ungoverned.
    const result = verifyAdvisoryRatchet({
      registry: [],
      discovered: [discovered({ file: 'scripts/rogue.mjs', control: 'rogue' })],
      probeResults: [],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'unregistered')).toBe(true);
  });

  it('AdvisoryRatchet_MissingOnDisk_Fails', () => {
    const e = entry();
    const result = verifyAdvisoryRatchet({
      registry: [e],
      discovered: [],
      probeResults: [probe(e)],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'missing-on-disk')).toBe(true);
  });

  it('AdvisoryRatchet_ControlMismatch_Fails', () => {
    const e = entry({ control: 'declared-control' });
    const result = verifyAdvisoryRatchet({
      registry: [e],
      discovered: [discovered({ control: 'other-control' })],
      probeResults: [probe(e)],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'control-mismatch')).toBe(true);
  });

  it('AdvisoryRatchet_DuplicateId_Fails', () => {
    const e = entry();
    const result = verifyAdvisoryRatchet({
      registry: [e, entry({ file: 'scripts/other.mjs', control: 'c2' })].map((x) => ({ ...x, id: 'dup' })),
      discovered: [discovered(), discovered({ file: 'scripts/other.mjs', control: 'c2' })],
      probeResults: [probe({ ...e, id: 'dup' })],
      now: CLOCK,
    });
    expect(result.violations.some((v) => v.kind === 'duplicate-id')).toBe(true);
  });

  // (c) expired advisory FAILS at the ratchet level.
  it('AdvisoryRatchet_ExpiredEntry_Fails', () => {
    const e = entry({ expires: '2000-01-01' });
    const result = verifyAdvisoryRatchet({
      registry: [e],
      discovered: [discovered()],
      probeResults: [probe(e)],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'expired')).toBe(true);
  });

  // (b) missing field FAILS at the ratchet level.
  it('AdvisoryRatchet_MissingOwner_Fails', () => {
    const e = entry({ owner: '' });
    const result = verifyAdvisoryRatchet({
      registry: [e],
      discovered: [discovered()],
      probeResults: [probe(e)],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'malformed')).toBe(true);
  });

  // (d) a kill fixture that no longer fires FAILS.
  it('AdvisoryRatchet_KillFixtureDidNotFire_Fails', () => {
    const e = entry();
    const result = verifyAdvisoryRatchet({
      registry: [e],
      discovered: [discovered()],
      probeResults: [probe(e, { firedOnViolation: false })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'kill-fixture-dead')).toBe(true);
  });

  it('AdvisoryRatchet_KillFixtureFiresOnClean_IsNotDiscriminating_Fails', () => {
    const e = entry();
    const result = verifyAdvisoryRatchet({
      registry: [e],
      discovered: [discovered()],
      probeResults: [probe(e, { firedOnClean: true })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'kill-fixture-dead')).toBe(true);
  });

  it('AdvisoryRatchet_NoProbeResult_Fails', () => {
    const e = entry();
    const result = verifyAdvisoryRatchet({
      registry: [e],
      discovered: [discovered()],
      probeResults: [],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'kill-fixture-missing')).toBe(true);
  });

  it('AdvisoryRatchet_ReportsEveryViolationInOnePass', () => {
    // Never short-circuits: an expired + missing-on-disk + missing-owner entry
    // surfaces all three, plus its kill-fixture-missing.
    const e = entry({ owner: '', expires: '2000-01-01' });
    const result = verifyAdvisoryRatchet({
      registry: [e],
      discovered: [],
      probeResults: [],
      now: CLOCK,
    });
    const kinds = new Set(result.violations.map((v) => v.kind));
    expect(kinds.has('malformed')).toBe(true);
    expect(kinds.has('expired')).toBe(true);
    expect(kinds.has('missing-on-disk')).toBe(true);
    expect(kinds.has('kill-fixture-missing')).toBe(true);
  });
});

describe('assertAdvisoryRatchet', () => {
  it('AdvisoryRatchet_Assert_ThrowsTypedError', () => {
    expect(() =>
      assertAdvisoryRatchet({
        registry: [],
        discovered: [discovered({ file: 'scripts/rogue.mjs', control: 'rogue' })],
        probeResults: [],
        now: CLOCK,
      }),
    ).toThrow(AdvisoryRatchetError);
  });

  it('AdvisoryRatchet_Assert_HealthyRegistry_DoesNotThrow', () => {
    const e = entry();
    expect(() =>
      assertAdvisoryRatchet({
        registry: [e],
        discovered: [discovered()],
        probeResults: [probe(e)],
        now: CLOCK,
      }),
    ).not.toThrow();
  });
});

describe('discoverAdvisories (injectable fs)', () => {
  it('AdvisoryDiscovery_FindsMarker_ExcludesSelf', () => {
    const fs = {
      listFiles: (root: string) =>
        root.endsWith('scripts')
          ? [join(REPO_ROOT, 'scripts', 'lint-inv6.mjs'), join(REPO_ROOT, 'src', 'advisory-registry.ts')]
          : [],
      readFile: (abs: string) =>
        abs.includes('lint-inv6')
          ? '// ' + 'ADVISORY(control: inv6-workflow-agnosticism) — x'
          : '// ' + 'ADVISORY(control: should-be-ignored) — self',
    };
    const found = discoverAdvisories({ repoRoot: REPO_ROOT, roots: ['scripts', 'src'], fs });
    // Self path (src/advisory-registry.ts) is excluded even though it "contains" a marker.
    expect(found).toHaveLength(1);
    expect(found[0]?.control).toBe('inv6-workflow-agnosticism');
  });
});

// ── (a) Exit-proof: the REAL registry is fully governed, its markers are on ──
// ── disk, and every kill fixture actually fires. ─────────────────────────────
describe('ADVISORY_REGISTRY (real repo)', () => {
  it('EveryRegisteredAdvisory_HasCompleteGovernance', () => {
    for (const e of ADVISORY_REGISTRY) {
      expect(validateAdvisoryGovernance(e, CLOCK), `${e.id} governance`).toEqual([]);
      // Every mandated field is present and non-trivial.
      expect(e.owner.trim().length, `${e.id} owner`).toBeGreaterThan(0);
      expect(e.promotionThreshold.trim().length, `${e.id} promotionThreshold`).toBeGreaterThan(0);
      expect(e.removalThreshold.trim().length, `${e.id} removalThreshold`).toBeGreaterThan(0);
      expect(e.killFixture.trim().length, `${e.id} killFixture`).toBeGreaterThan(0);
      expect(e.ciPath, `${e.id} ciPath`).toMatch(/^\.github\/workflows\/[\w.-]+\.ya?ml$/);
      expect(e.issue, `${e.id} issue`).toMatch(/^#\d+$/);
    }
  });

  it('RealMarkersMatchRegistry_And_KillFixturesFire', () => {
    const discoveredReal = discoverAdvisories({ repoRoot: REPO_ROOT });
    // Exactly the governed advisories are marked on disk (no ungoverned strays).
    expect(discoveredReal.map((d) => d.control).sort()).toEqual(
      ADVISORY_REGISTRY.map((e) => e.control).sort(),
    );

    const probeResults = runAllKillProbes(ADVISORY_REGISTRY, { repoRoot: REPO_ROOT });
    // Every registered advisory's kill fixture fires on its seeded violation and
    // stays silent on its clean control.
    for (const r of probeResults) {
      expect(r.firedOnViolation, `${r.advisoryId} kill fixture must FIRE: ${r.detail}`).toBe(true);
      expect(r.firedOnClean, `${r.advisoryId} must be discriminating: ${r.detail}`).toBe(false);
    }

    // The full real-repo ratchet is green.
    assertAdvisoryRatchet({
      registry: ADVISORY_REGISTRY,
      discovered: discoveredReal,
      probeResults,
      now: new Date(),
    });
  });
});
