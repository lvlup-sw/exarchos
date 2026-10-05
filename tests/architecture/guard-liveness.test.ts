/**
 * Asserts that each guard and governance surface matches files in the live tree.
 *
 * Each surface has literal paths in its config. A guard whose glob resolves to
 * nothing does not fail: it passes forever.
 * `tools/audit/measure-guard-liveness.mjs` measures the baseline, and the
 * assertions below make its numbers binding.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

type Surface = {
  kind: string;
  matched: number;
  detail?: { declared?: number; buildOutput?: boolean };
};
type Baseline = { trackedFiles: number; surfaces: Record<string, Surface> };

/** A compile output is absent before `npm run build`. It is not a dead source path. */
function isBuildOutput(surface: Surface): boolean {
  return surface.kind === 'build-output' || surface.detail?.buildOutput === true;
}

const baseline = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/guard-liveness-baseline.json'), 'utf8'),
) as Baseline;

/**
 * The live measurement, from the same measurer that produced the baseline. An
 * assertion on the committed capture only stays green after a guard dies on
 * disk, until a person measures again.
 */
const live = JSON.parse(
  await execFileAsync(process.execPath, [path.join(REPO_ROOT, 'tools/audit/measure-guard-liveness.mjs')], {
    cwd: REPO_ROOT,
  }),
) as Baseline;

/**
 * The surfaces that match nothing today, each with its reason. This is a defect
 * list and not an allowance. An equality assertion requires that a fixed entry
 * leaves the list.
 */
const KNOWN_DEAD: Record<string, string> = {};

const liveEntries = Object.entries(live.surfaces);

/**
 * The minimum remaining count for a surface that does not declare its size. Such
 * a surface can lose two percent of its captured files or ten files, whichever
 * is larger, and never more than twenty percent. A minimum of 80% alone lets
 * about 176 files leave a lint glob of 881 files.
 */
function undeclaredScopeFloor(before: number): number {
  const eightyPercent = Math.ceil(before * 0.8);
  const twoPercentLoss = before - Math.max(10, Math.ceil(before * 0.02));
  return Math.max(eightyPercent, twoPercentLoss);
}

describe('guard liveness', () => {
  /**
   * Reads the live tree, because a check of the committed capture stays green
   * after a surface dies on disk. The assertion is equality and not subset. A
   * surface that dies must fail here, and a fixed entry must leave `KNOWN_DEAD`.
   */
  it('GuardLiveness_EveryConfiguredGuard_MatchesNonEmptyFileSet', () => {
    const dead = Object.entries(live.surfaces)
      .filter(([, s]) => !isBuildOutput(s) && s.matched === 0)
      .map(([name]) => name);

    expect(dead.sort()).toEqual(Object.keys(KNOWN_DEAD).sort());
  });

  /**
   * `KNOWN_DEAD` is empty today, so the loop over it cannot fail. The seeded
   * entry with an empty reason must appear in the result of the filter.
   */
  it('GuardLiveness_KnownDeadSurface_CarriesItsReason', () => {
    const seeded: Record<string, string> = { ...KNOWN_DEAD, 'seeded:empty-reason': '' };
    const emptyReason = Object.entries(seeded).filter(([, reason]) => reason.length === 0);
    expect(emptyReason.map(([name]) => name)).toContain('seeded:empty-reason');

    for (const [name, reason] of Object.entries(KNOWN_DEAD)) {
      expect(baseline.surfaces[name], `${name} is listed dead but absent from the baseline`).toBeDefined();
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  /**
   * Seeds a surface with zero matches. The filter expression of the live
   * emptiness checks must put that surface in the dead list.
   */
  it('GuardLiveness_GuardMatchingZeroFiles_FailsClosed', () => {
    const seeded = { ...live.surfaces, 'seeded:evaporated-guard': { kind: 'seeded', matched: 0 } };
    const dead = Object.entries(seeded)
      .filter(([, s]) => !isBuildOutput(s as Surface) && (s as Surface).matched === 0)
      .map(([name]) => name);

    expect(dead.sort()).not.toEqual(Object.keys(KNOWN_DEAD).sort());
    expect(dead).toContain('seeded:evaporated-guard');
  });

  /**
   * A surface that declares N entries and resolves fewer lost part of its
   * scope, which a count above zero hides. Reads the live tree.
   */
  it('GuardLiveness_DeclaredCount_ResolvesToRealFiles', () => {
    const partial = liveEntries
      .filter(([, s]) => s.detail?.declared !== undefined && s.matched < (s.detail.declared ?? 0))
      .map(([name, s]) => `${name}: ${s.matched}/${s.detail?.declared}`);

    expect(partial).toEqual([]);
  });

  /**
   * The one dependency-cruiser rule with `error` severity. An empty constrained
   * set constrains nothing, and an empty target set forbids nothing.
   */
  it('GuardLiveness_TheLiveBoundaryRule_ConstrainsAndForbidsRealModules', () => {
    expect(live.surfaces['depcruise:no-domain-core-to-io-adapters:from']?.matched).toBeGreaterThan(0);
    expect(live.surfaces['depcruise:no-domain-core-to-io-adapters:to']?.matched).toBeGreaterThan(0);
  });

  /**
   * CODEOWNERS has no extension, so a scan that filters by file extension does
   * not see it. A pattern that matches nothing falls to the `*` rule silently.
   */
  it('GuardLiveness_CodeownersPatterns_AreEnumeratedByName', () => {
    const codeowners = liveEntries.filter(([name]) => name.startsWith('codeowners:'));

    expect(codeowners.length).toBeGreaterThan(1);
    for (const [name, surface] of codeowners) {
      expect(surface.matched, `${name} owns nothing`).toBeGreaterThan(0);
    }
  });

  /**
   * A baseline from a tree of a different size is stale. The tolerance of 50
   * files covers ordinary edits, and a structural move exceeds it.
   */
  it('GuardLiveness_Baseline_IsCurrentWithTheTree', async () => {
    const tracked = (
      await execFileAsync('git', ['ls-files', '-z'], {
        cwd: REPO_ROOT,
      })
    )
      .split('\0')
      .filter((rel) => rel.length > 0).length;

    expect(Math.abs(tracked - baseline.trackedFiles)).toBeLessThan(50);
  });

  /**
   * Measures the live tree and not the capture. The last two assertions are the
   * denominator, because an empty measurement has nothing to filter. The minimum
   * of 2,500 tracked files detects a census that read nothing. It follows the
   * order of magnitude of the tree and does not pin its size.
   */
  it('GuardLiveness_AfterRetarget_EveryGuardMatchesNonEmptySet', () => {
    const dead = Object.entries(live.surfaces)
      .filter(([, s]) => !isBuildOutput(s) && s.matched === 0)
      .map(([name]) => name);

    expect(dead.sort(), 'these configured surfaces match no file on the live tree').toEqual(
      Object.keys(KNOWN_DEAD).sort(),
    );

    expect(Object.keys(live.surfaces).length).toBeGreaterThan(15);
    expect(live.trackedFiles).toBeGreaterThan(2_500);
  });

  /**
   * A surface can still match some files after it loses most of its scope. Each
   * surface in both captures must still match. A declared count must resolve in
   * full, and an undeclared surface must stay above its minimum. A surface in
   * the capture that the live measurement lacks is a retarget or a regression.
   * The pinned empty set makes each such change visible in review.
   */
  it('GuardLiveness_ComparedToBaseline_NoGuardSilentlyLostItsScope', () => {
    for (const [name, before] of Object.entries(baseline.surfaces)) {
      const after = live.surfaces[name];
      if (after === undefined) continue;
      if (isBuildOutput(after) || isBuildOutput(before)) continue;
      expect(after.matched, `${name} matched ${before.matched} at capture and ${after.matched} now`)
        .toBeGreaterThan(0);
      if (after.detail?.declared !== undefined) {
        expect(
          after.matched,
          `${name} declared ${after.detail.declared} and resolved ${after.matched}`,
        ).toBe(after.detail.declared);
      } else {
        expect(
          after.matched,
          `${name} fell from ${before.matched} to ${after.matched}`,
        ).toBeGreaterThanOrEqual(undeclaredScopeFloor(before.matched));
      }
    }

    const vanished = Object.keys(baseline.surfaces)
      .filter((name) => live.surfaces[name] === undefined)
      .sort();
    expect(vanished, 'a configured surface disappeared from the measurement').toEqual([]);
  });

  it('GuardLiveness_UndeclaredScopeLoss_RejectsATwentyPercentDropOnALargeSurface', () => {
    const before = 881;
    const oldFloor = Math.ceil(before * 0.8);
    const floor = undeclaredScopeFloor(before);
    expect(floor, 'the tightened floor is not stricter than 80% on a large surface').toBeGreaterThan(
      oldFloor,
    );
    expect(oldFloor).toBeLessThan(floor);
  });

  /**
   * Two copies of the prefix matcher drift apart. Both instruments must import
   * the shared module, and neither can declare the function again.
   */
  it('GuardLiveness_CodeownersMatcher_IsImportedFromOneModule', () => {
    const measurer = fs.readFileSync(
      path.join(REPO_ROOT, 'tools/audit/measure-guard-liveness.mjs'),
      'utf8',
    );
    const census = fs.readFileSync(
      path.join(REPO_ROOT, 'tools/conformance/src/governance-liveness.ts'),
      'utf8',
    );
    expect(measurer).toMatch(/from ['"]\.\/lib\/codeowners-match\.mjs['"]/);
    expect(census).toMatch(/from ['"].*lib\/codeowners-match\.mjs['"]/);
    expect(measurer).not.toMatch(/function codeownersMatches\b/);
    expect(census).not.toMatch(/function codeownersMatches\b/);
    expect(measurer).toMatch(/createRequire/);
    expect(measurer).toMatch(/no-domain-core-to-io-adapters/);
    expect(measurer).not.toMatch(/fromMatch/);
    expect(measurer).not.toMatch(/depcruise\.match\(/);
  });

  /** A surface class with no measured surface is not a guard that passes. Nothing measures it. */
  it('GuardLiveness_EverySurfaceClass_IsRepresented', () => {
    const kinds = new Set(liveEntries.map(([, s]) => s.kind));

    for (const kind of [
      'module-set',
      'ownership',
      'packaging',
      'build-output',
      'test-protection',
      'catalog-reference',
      'lint-scope',
      'dead-code',
    ]) {
      expect(kinds, `no surface of kind "${kind}" was measured`).toContain(kind);
    }
  });
});
