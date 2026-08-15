/**
 * What every guard and governance surface currently matches.
 *
 * These are all configured with literal paths, and the structure refactor
 * rewrites nearly all of them. The failure this catches is not a guard that
 * goes red — it is one whose glob resolves to nothing and therefore passes
 * forever, which reads exactly like success.
 *
 * The baseline is re-measured by `tools/audit/measure-guard-liveness.mjs`, and
 * the assertions below are what make the numbers load-bearing rather than
 * decorative.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

type Surface = {
  kind: string;
  matched: number;
  detail?: { declared?: number; buildOutput?: boolean };
};
type Baseline = { trackedFiles: number; surfaces: Record<string, Surface> };

/** Compile outputs. Absent before `npm run build`; not a dead source path. */
function isBuildOutput(surface: Surface): boolean {
  return surface.kind === 'build-output' || surface.detail?.buildOutput === true;
}

const baseline = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/guard-liveness-baseline.json'), 'utf8'),
) as Baseline;

/**
 * The LIVE measurement, taken by running the same measurer that produced the
 * baseline.
 *
 * Everything below this line used to read the committed capture only, which
 * makes the whole file a statement about a JSON document rather than about the
 * repository: a guard could evaporate the moment after a capture and every
 * assertion here would keep passing until someone re-measured by hand. Task 042
 * found exactly that — three CODEOWNERS patterns matching zero files, owning
 * 424 files between them and silently falling through to the `*` rule, with
 * this suite green the whole time.
 */
const live = JSON.parse(
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'tools/audit/measure-guard-liveness.mjs')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
) as Baseline;

/**
 * Surfaces known to match nothing TODAY, each with the task that removes it.
 * This is a defect list, not an allowance: when the entry is fixed the set
 * shrinks and the equality assertion below demands this list shrink with it.
 *
 * Currently empty, and it earned that. The one entry here — a `files[]` naming
 * `CLAUDE.md.template`, which does not exist — was removed by the
 * dead-declaration task, and the equality assertion is what forced this list to
 * be emptied rather than left carrying a defect that no longer exists.
 */
const KNOWN_DEAD: Record<string, string> = {};

const liveEntries = Object.entries(live.surfaces);

describe('guard liveness', () => {
  it('GuardLiveness_EveryConfiguredGuard_MatchesNonEmptyFileSet', () => {
    // Live tree, not the committed capture. A baseline-only emptiness check
    // stays green after a surface dies on disk — the failure this suite exists
    // to catch. Build outputs are excluded: they are absent before
    // `npm run build` and are not a dead source path.
    const dead = Object.entries(live.surfaces)
      .filter(([, s]) => !isBuildOutput(s) && s.matched === 0)
      .map(([name]) => name);

    // Equality, not subset: a surface that dies later must fail here, and a
    // known-dead one that gets fixed must be struck from the list rather than
    // left as standing cover.
    expect(dead.sort()).toEqual(Object.keys(KNOWN_DEAD).sort());
  });

  it('GuardLiveness_KnownDeadSurface_CarriesItsReason', () => {
    for (const [name, reason] of Object.entries(KNOWN_DEAD)) {
      expect(baseline.surfaces[name], `${name} is listed dead but absent from the baseline`).toBeDefined();
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('GuardLiveness_GuardMatchingZeroFiles_FailsClosed', () => {
    // Proves the assertion has teeth. A seeded empty surface must be rejected
    // by the same filter the live emptiness checks use (skip compile outputs).
    const seeded = { ...live.surfaces, 'seeded:evaporated-guard': { kind: 'seeded', matched: 0 } };
    const dead = Object.entries(seeded)
      .filter(([, s]) => !isBuildOutput(s as Surface) && (s as Surface).matched === 0)
      .map(([name]) => name);

    expect(dead.sort()).not.toEqual(Object.keys(KNOWN_DEAD).sort());
    expect(dead).toContain('seeded:evaporated-guard');
  });

  it('GuardLiveness_DeclaredCount_ResolvesToRealFiles', () => {
    // A surface that declares N entries and resolves fewer has partially
    // evaporated, which a bare non-zero count would hide. Live tree, not the
    // committed capture — a baseline-only partial-evaporation check stays
    // green after the tree loses files.
    const partial = liveEntries
      .filter(([, s]) => s.detail?.declared !== undefined && s.matched < (s.detail.declared ?? 0))
      .map(([name, s]) => `${name}: ${s.matched}/${s.detail?.declared}`);

    expect(partial).toEqual([]);
  });

  it('GuardLiveness_TheLiveBoundaryRule_ConstrainsAndForbidsRealModules', () => {
    // The one `error`-severity dependency-cruiser rule. Both ends are checked:
    // an empty constrained set constrains nothing, and an empty target set
    // leaves nothing to forbid.
    expect(live.surfaces['depcruise:no-domain-core-to-io-adapters:from']?.matched).toBeGreaterThan(0);
    expect(live.surfaces['depcruise:no-domain-core-to-io-adapters:to']?.matched).toBeGreaterThan(0);
  });

  it('GuardLiveness_CodeownersPatterns_AreEnumeratedByName', () => {
    // CODEOWNERS is extensionless, so any scan filtered by file extension
    // cannot see it. Ownership collapsing to the `*` fallback is silent.
    const codeowners = liveEntries.filter(([name]) => name.startsWith('codeowners:'));

    expect(codeowners.length).toBeGreaterThan(1);
    for (const [name, surface] of codeowners) {
      expect(surface.matched, `${name} owns nothing`).toBeGreaterThan(0);
    }
  });

  it('GuardLiveness_Baseline_IsCurrentWithTheTree', () => {
    // A baseline captured against a different tree size is stale, and a stale
    // baseline is a comparison against fiction.
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
      .split('\0')
      .filter((rel) => rel.length > 0).length;

    // Tolerance covers ordinary in-flight edits; a structural move blows past it.
    expect(Math.abs(tracked - baseline.trackedFiles)).toBeLessThan(50);
  });

  it('GuardLiveness_AfterRetarget_EveryGuardMatchesNonEmptySet', () => {
    // Task 042, and the assertion the whole task exists for — measured against
    // the TREE, not the capture. A guard whose path config resolves to nothing
    // does not go red; it passes forever, which reads exactly like success.
    const dead = Object.entries(live.surfaces)
      .filter(([, s]) => !isBuildOutput(s) && s.matched === 0)
      .map(([name]) => name);

    expect(dead.sort(), 'these configured surfaces match no file on the live tree').toEqual(
      Object.keys(KNOWN_DEAD).sort(),
    );

    // Denominator: an empty measurement would satisfy the filter above by
    // having nothing to filter.
    //
    // The tracked-file floor is 2,500 rather than 3,000: the prose exodus moved
    // ~550 documents to the external documents repository, so the tree is
    // legitimately smaller. The floor exists to catch a census that read
    // NOTHING, so it tracks the tree's order of magnitude rather than pinning
    // its size — pinning would make every deliberate removal a failure.
    expect(Object.keys(live.surfaces).length).toBeGreaterThan(15);
    expect(live.trackedFiles).toBeGreaterThan(2_500);
  });

  it('GuardLiveness_ComparedToBaseline_NoGuardSilentlyLostItsScope', () => {
    // The subtler half. A surface can keep matching SOMETHING while quietly
    // losing most of its reach — the retarget that half-lands. Every surface
    // present in both captures must still match, and any that vanished from the
    // measurement entirely must be gone because its config was retargeted, not
    // because the measurer stopped seeing it.
    for (const [name, before] of Object.entries(baseline.surfaces)) {
      const after = live.surfaces[name];
      if (after === undefined) continue; // consolidated away — covered below
      if (isBuildOutput(after) || isBuildOutput(before)) continue;
      expect(after.matched, `${name} matched ${before.matched} at capture and ${after.matched} now`)
        .toBeGreaterThan(0);
      if (after.detail?.declared !== undefined) {
        expect(
          after.matched,
          `${name} declared ${after.detail.declared} and resolved ${after.matched}`,
        ).toBe(after.detail.declared);
      } else {
        // A surface can keep matching SOMETHING while losing most of its reach.
        // 80% of the captured count is enough headroom for ordinary edits and
        // still fails a retarget that half-lands.
        expect(
          after.matched,
          `${name} fell from ${before.matched} to ${after.matched}`,
        ).toBeGreaterThanOrEqual(Math.ceil(before.matched * 0.8));
      }
    }

    // A surface named in the capture but absent from the live measurement is
    // either retargeted (its replacement is present) or a regression. Pinning
    // the set makes the difference reviewable instead of inferred.
    const vanished = Object.keys(baseline.surfaces)
      .filter((name) => live.surfaces[name] === undefined)
      .sort();
    expect(vanished, 'a configured surface disappeared from the measurement').toEqual([]);
  });

  it('GuardLiveness_CodeownersMatcher_IsImportedFromOneModule', () => {
    // Decay rule: two copies of the prefix matcher already drifted on a
    // leading slash. Another correct instance is not the fix — both
    // instruments must import the shared module, and neither may re-declare
    // the function.
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
  });

  it('GuardLiveness_EverySurfaceClass_IsRepresented', () => {
    // The classes the design enumerates. A class missing entirely is not a
    // passing guard — it is an unmeasured one.
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
