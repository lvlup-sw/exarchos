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

type Surface = { kind: string; matched: number; detail?: { declared?: number } };
type Baseline = { trackedFiles: number; surfaces: Record<string, Surface> };

const baseline = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/guard-liveness-baseline.json'), 'utf8'),
) as Baseline;

/**
 * Surfaces known to match nothing TODAY, each with the task that removes it.
 * This is a defect list, not an allowance: when the entry is fixed the set
 * shrinks and the equality assertion below demands this list shrink with it.
 */
const KNOWN_DEAD: Record<string, string> = {
  'package.files:CLAUDE.md.template':
    'the file does not exist; the shipped package declares it anyway. Removed by the dead-declaration task.',
};

const entries = Object.entries(baseline.surfaces);

describe('guard liveness', () => {
  it('GuardLiveness_EveryConfiguredGuard_MatchesNonEmptyFileSet', () => {
    const dead = entries.filter(([, s]) => s.matched === 0).map(([name]) => name);

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
    // Proves the assertion has teeth. A seeded empty surface must be rejected;
    // if this passes, the check above is decorative.
    const seeded = { ...baseline.surfaces, 'seeded:evaporated-guard': { kind: 'seeded', matched: 0 } };
    const dead = Object.entries(seeded)
      .filter(([, s]) => (s as Surface).matched === 0)
      .map(([name]) => name);

    expect(dead.sort()).not.toEqual(Object.keys(KNOWN_DEAD).sort());
    expect(dead).toContain('seeded:evaporated-guard');
  });

  it('GuardLiveness_DeclaredCount_ResolvesToRealFiles', () => {
    // A surface that declares N entries and resolves fewer has partially
    // evaporated, which a bare non-zero count would hide.
    const partial = entries
      .filter(([, s]) => s.detail?.declared !== undefined && s.matched < (s.detail.declared ?? 0))
      .map(([name, s]) => `${name}: ${s.matched}/${s.detail?.declared}`);

    expect(partial).toEqual([]);
  });

  it('GuardLiveness_TheLiveBoundaryRule_ConstrainsAndForbidsRealModules', () => {
    // The one `error`-severity dependency-cruiser rule. Both ends are checked:
    // an empty constrained set constrains nothing, and an empty target set
    // leaves nothing to forbid. The refactor destroys both paths, so this is
    // the number its retargeting has to restore.
    expect(baseline.surfaces['depcruise:no-domain-core-to-io-adapters:from']?.matched).toBeGreaterThan(0);
    expect(baseline.surfaces['depcruise:no-domain-core-to-io-adapters:to']?.matched).toBeGreaterThan(0);
  });

  it('GuardLiveness_CodeownersPatterns_AreEnumeratedByName', () => {
    // CODEOWNERS is extensionless, so any scan filtered by file extension
    // cannot see it. Ownership collapsing to the `*` fallback is silent.
    const codeowners = entries.filter(([name]) => name.startsWith('codeowners:'));

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

  it('GuardLiveness_EverySurfaceClass_IsRepresented', () => {
    // The classes the design enumerates. A class missing entirely is not a
    // passing guard — it is an unmeasured one.
    const kinds = new Set(entries.map(([, s]) => s.kind));

    for (const kind of [
      'module-set',
      'ownership',
      'packaging',
      'test-protection',
      'catalog-reference',
      'lint-scope',
      'dead-code',
    ]) {
      expect(kinds, `no surface of kind "${kind}" was measured`).toContain(kind);
    }
  });
});
