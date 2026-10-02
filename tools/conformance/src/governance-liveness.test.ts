// Governance and packaging liveness.
//
// Every register checked here fails open: a stale entry produces no error. The only way to see
// one is to count what it matches.
//
// A census that reports "all live" looks the same as a census that scanned nothing. Thus the
// seeded stale-pattern case proves that the finding path can produce a finding.
//
// @oracle-sources: ../../../.github/CODEOWNERS, ../../../package.json, ../../../manifest.json, ../../../tools/audit/protected-suites.json, live-git-tracked-file-listing
//
// This suite lives under `src/` because the `conformance` vitest project collects that directory.
// No project collects a sibling `tests/` directory here.

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
  /** The denominator. Most checks in this suite pass on an empty scan. */
  it('the census scanned a real tree', () => {
    expect(result.trackedFiles).toBeGreaterThan(500);
    expect(result.surfaces.length).toBeGreaterThan(10);
  });

  /**
   * Per-register denominators. CODEOWNERS alone satisfies the whole-census count. A register that
   * the reader returns nothing for drops out of the audit, and its checks pass with no input.
   */
  it('every register contributed surfaces', () => {
    const counted = new Map<string, number>();
    for (const surface of result.surfaces) {
      counted.set(surface.register, (counted.get(surface.register) ?? 0) + 1);
    }
    for (const register of ['codeowners', 'files', 'manifest', 'protected-suites'] as const) {
      expect(
        counted.get(register) ?? 0,
        `the ${register} register contributed no surfaces — it was not read`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * The test first asserts that it reads patterns. CODEOWNERS has no extension, so a scan that
   * filters by extension cannot see it.
   */
  it('Codeowners_EveryPattern_MatchesAtLeastOneTrackedFile', () => {
    const patterns = codeownersPatterns();
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

  /**
   * `dist/bin` and `dist/release-verify.js` are bun compile outputs. The census records them, but
   * a clean checkout must not report them dead. CI runs `test:run` and `test:conformance` before
   * `build:binary`.
   */
  it('FilesArray_BuildOutputs_AreExcludedFromDeadOnACleanTree', () => {
    const buildOutputs = result.surfaces.filter((s) => s.register === 'files' && s.buildOutput);
    expect(
      buildOutputs.map((s) => s.pattern).sort(),
      'package.json `files[]` names no dist/ build output — the exclusion below is vacuous',
    ).not.toEqual([]);
    expect(
      result.dead.filter((s) => s.buildOutput).map((s) => s.pattern),
      'a build-output files[] entry was reported dead on a tree that has not been built',
    ).toEqual([]);
  });

  it('ProtectedSuites_EveryDeclaredFile_IsTracked', () => {
    const dead = result.dead.filter((s) => s.register === 'protected-suites');
    expect(
      dead.map((s) => s.pattern),
      'protected-suites.json names files that are not tracked. The suite-protection register fails open.',
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

  /**
   * GitHub applies the last rule that matches. A trailing `*` thus overrides every specific rule.
   * The default must be first, and it must appear once.
   */
  it('Codeowners_StarIsTheFirstRuleAndIsNotRepeated', () => {
    const patterns = codeownersPatterns();
    expect(patterns.length, 'CODEOWNERS declares no patterns').toBeGreaterThan(1);
    expect(patterns[0], 'the default rule is not first').toBe('*');
    expect(
      patterns.filter((pattern) => pattern === '*'),
      '`*` is repeated — later copies win and swallow the specific rules',
    ).toEqual(['*']);
  });

  it('Codeowners_LastMatch_DoesNotCollapseSpecificRulesToStar', () => {
    const patterns = codeownersPatterns();
    const tracked = trackedFiles();
    const specific = patterns.filter((pattern) => pattern !== '*');
    expect(specific.length, 'CODEOWNERS has no rule besides `*`').toBeGreaterThan(0);

    for (const pattern of specific) {
      const hits = tracked.filter((rel) => codeownersMatches(pattern, rel));
      expect(hits.length, `${pattern} matches no tracked file`).toBeGreaterThan(0);
      for (const rel of hits) {
        let winner: string | undefined;
        for (const rule of patterns) {
          if (codeownersMatches(rule, rel)) winner = rule;
        }
        expect(
          winner,
          `${rel} last-match-wins to \`*\` despite matching ${pattern}`,
        ).not.toBe('*');
      }
    }
  });

  /**
   * Proves that the finding path fires. A pattern for a deleted tree matches nothing, and live
   * patterns still match, so the matcher works. Unsupported gitignore forms such as `**` match
   * nothing, so a hole reports dead and not live.
   */
  it('GovernanceLiveness_StalePattern_FailsClosed', () => {
    const tracked = trackedFiles();
    const stale = 'servers/exarchos-mcp/';
    expect(
      tracked.filter((rel) => codeownersMatches(stale, rel)),
      'the seeded stale pattern matches real files — pick one that is genuinely gone',
    ).toEqual([]);

    expect(tracked.filter((rel) => codeownersMatches('src/', rel)).length).toBeGreaterThan(0);
    expect(tracked.filter((rel) => codeownersMatches('/src/', rel)).length).toBeGreaterThan(0);
    expect(tracked.filter((rel) => codeownersMatches('/src/', rel)).length).toBe(
      tracked.filter((rel) => codeownersMatches('src/', rel)).length,
    );
    expect(tracked.filter((rel) => codeownersMatches('*', rel)).length).toBe(tracked.length);
    expect(tracked.filter((rel) => codeownersMatches('**', rel))).toEqual([]);
    expect(tracked.filter((rel) => codeownersMatches('src/**', rel))).toEqual([]);
  });

  /** On a failure, the message is the whole product, so the test checks it. */
  it('the report names every dead surface it found', () => {
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
