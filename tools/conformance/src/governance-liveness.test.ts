// ─── Governance and packaging liveness ───────────────────────────────────────
//
// Every register checked here FAILS OPEN, which is what makes a liveness census
// the right instrument: a stale entry produces no error anywhere, so the only
// way to see one is to go and count what it matches.
//
// The seeded-violation case at the bottom is not decoration. A census that
// reports "all live" is indistinguishable from a census that scanned nothing,
// and this workflow has repeatedly found guards in the second state. Pinning a
// known-dead input proves the reporting path can produce a finding at all.
//
// @oracle-sources: ../../../.github/CODEOWNERS, ../../../package.json, ../../../manifest.json, live-git-tracked-file-listing
//
// Co-located with its subject under `src/` because that is the directory the
// `conformance` vitest project collects. A sibling `tests/` directory here is
// matched by no project, so a suite placed there passes by never running.

import { describe, it, expect } from 'vitest';

import {
  auditGovernanceLiveness,
  codeownersMatches,
  codeownersPatterns,
  formatGovernanceLiveness,
  trackedFiles,
} from './governance-liveness.js';

const result = auditGovernanceLiveness();

describe('governance liveness', () => {
  it('the census scanned a real tree', () => {
    // The denominator. Every assertion below is satisfied by an empty scan.
    expect(result.trackedFiles).toBeGreaterThan(500);
    expect(result.surfaces.length).toBeGreaterThan(10);
  });

  it('every register contributed surfaces', () => {
    // Per-register denominators. The whole-census count above is satisfied by
    // CODEOWNERS alone, so a register whose file was renamed — or whose shape
    // changed enough that the reader returns nothing — would drop out of the
    // audit entirely and every check below it would pass by having no input.
    const counted = new Map<string, number>();
    for (const surface of result.surfaces) {
      counted.set(surface.register, (counted.get(surface.register) ?? 0) + 1);
    }
    for (const register of ['codeowners', 'files', 'manifest'] as const) {
      expect(
        counted.get(register) ?? 0,
        `the ${register} register contributed no surfaces — it was not read`,
      ).toBeGreaterThan(0);
    }
  });

  it('Codeowners_EveryPattern_MatchesAtLeastOneTrackedFile', () => {
    const patterns = codeownersPatterns();
    // CODEOWNERS is EXTENSIONLESS, so an extension-filtered scan cannot see it
    // at all — reading zero patterns is the failure this asserts against.
    expect(patterns.length, 'CODEOWNERS declares no patterns — was it renamed?').toBeGreaterThan(1);

    const dead = result.dead.filter((s) => s.register === 'codeowners');
    expect(
      dead.map((s) => s.pattern),
      'CODEOWNERS patterns owning no tracked file. Ownership silently falls through to `*`, ' +
        'and every review gate on those paths disappears without anything turning red.',
    ).toEqual([]);
  });

  it('FilesArray_EveryEntry_ExistsOnDisk', () => {
    const dead = result.dead.filter((s) => s.register === 'files');
    expect(
      dead.map((s) => s.pattern),
      'package.json `files[]` entries that name nothing. npm ships less without complaining.',
    ).toEqual([]);
  });

  it('ManifestComponents_EverySource_ExistsOnDisk', () => {
    const dead = result.dead.filter((s) => s.register === 'manifest');
    expect(
      dead.map((s) => s.pattern),
      'plugin manifest components whose `source` names nothing. The installer copies an empty ' +
        'component and reports success.',
    ).toEqual([]);
  });

  it('GovernanceLiveness_StalePattern_FailsClosed', () => {
    // Teeth. The matcher is exercised directly against a pattern naming a tree
    // this repository deleted, so the finding path is proven to fire rather
    // than assumed to.
    const tracked = trackedFiles();
    const stale = 'servers/exarchos-mcp/';
    expect(
      tracked.filter((rel) => codeownersMatches(stale, rel)),
      'the seeded stale pattern matches real files — pick one that is genuinely gone',
    ).toEqual([]);

    // …and a live one still matches, so the matcher is not simply broken.
    expect(tracked.filter((rel) => codeownersMatches('src/', rel)).length).toBeGreaterThan(0);
    expect(tracked.filter((rel) => codeownersMatches('*', rel)).length).toBe(tracked.length);
  });

  it('the report names every dead surface it found', () => {
    // The message is the whole product on a failure, so it is checked rather
    // than trusted.
    const rendered = formatGovernanceLiveness({
      ok: false,
      surfaces: [],
      dead: [{ register: 'codeowners', pattern: 'servers/', matched: 0 }],
      trackedFiles: 1,
    });
    expect(rendered).toContain('servers/');
    expect(rendered).toContain('codeowners');
  });
});
