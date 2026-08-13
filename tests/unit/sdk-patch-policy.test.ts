// ─── DR-0 / task 050 — patch LIFETIME policy ────────────────────────────────
//
// `patches/@modelcontextprotocol+sdk+1.29.0.patch` makes v1's `tools/list`
// emit native draft-2020-12 and keeps the discriminated-union LCD envelope
// object-rooted instead of silently dropping it. Task 050 evaluated it against
// `@modelcontextprotocol/server@2.0.0` and found that **v2 does both natively**
// — so the patch is not a permanent fixture, it is a v1-only backport with a
// death condition: the removal of `@modelcontextprotocol/sdk` (task 053).
//
// A decision recorded only in prose rots. This file makes the two failure
// modes of that decision mechanical:
//
//   • DELETED TOO EARLY — the patch goes while v1 still serves the wire.
//     Measured cost: reversing the patch fails `tools-list-2020-12.test.ts`
//     and the byte golden 6/6 — `$schema` reverts to draft-07, every
//     production tool loses its `outputSchema`, tuples render as `items`.
//     The dangerous part is that npm reports nothing; the regression is
//     entirely on the wire.
//
//   • KEPT TOO LONG — v1 is removed and an orphan patch stays behind.
//     `patch-package` does not fail on a patch for an absent package, so the
//     file would sit in the tree indefinitely, describing a dependency that
//     no longer exists.
//
// A third, quieter mode is covered too: the SDK pin moves and the patch
// filename still names the old version. `patch-package` matches patches to
// packages BY VERSION in the filename, so a stale filename means the patch is
// simply not applied — the same wire regression as deleting it, with a patch
// file still sitting in the tree to reassure the reader.
//
// The rule is written as a pure function over (dependencies, patch filenames)
// and exercised against BOTH populations — v1-present and v1-absent — before
// being applied to the live tree. Without that, the death-condition arm would
// be vacuous today (v1 is present) and would assert nothing at all.

/**
 * DR-30 authorities. The lifetime rule is a pure function over two sources,
 * neither derived from the other:
 *
 *   • `../../package.json` — which SDK generations are DECLARED.
 *   • the `patches/` DIRECTORY LISTING — which patch files exist, and for which
 *     package@version (`patch-package` matches by the filename).
 *
 * A patch cannot compute the manifest and the manifest cannot compute the
 * patches directory, so the two genuinely disagree in both directions the
 * module docblock enumerates: deleted-too-early and kept-too-long.
 *
 * `patches/` cannot be NAMED as a path authority any more — task 049 deleted the
 * last patch, so the directory does not exist and an annotation pointing at it
 * would name an authority nobody can consult. The second declared authority is
 * therefore `../../package-lock.json`, and it is a real one rather than a
 * stand-in: the manifest records what is DECLARED, the lockfile records what npm
 * actually RESOLVED, and a lockfile still carrying a v1 tree after the manifest
 * dropped it is precisely how `patch-package` would go on finding a v1 install
 * to patch. That is the deleted-too-early failure mode arriving through the back
 * door, and nothing else in this file would catch it.
 *
 * (This file-level annotation replaces one that lived on
 * `SdkPatch_RegeneratedContent_RetainsEveryBehaviouralHunk`, retired by task
 * 049 — see the retirement note below. Its authorities were the patch text and
 * the installed v1 modules; both are gone with the dependency.)
 *
 * @oracle-sources: ../../package.json, ../../package-lock.json
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '../..');
const packageJsonPath = join(packageRoot, 'package.json');
const patchesDir = join(packageRoot, 'patches');
/** Where the patched v1 modules land once `postinstall` has run. */
const SDK_SERVER_DIR = join(
  packageRoot,
  'node_modules',
  '@modelcontextprotocol',
  'sdk',
  'dist',
  'esm',
  'server',
);

/** The v1 SDK — the generation the patch exists to correct. */
const V1_PACKAGE = '@modelcontextprotocol/sdk';

/** `patch-package` encodes `@scope/name` as `@scope+name` in patch filenames. */
const V1_PATCH_PREFIX = `${V1_PACKAGE.replace('/', '+')}+`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPackageJson(): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (!isRecord(raw)) throw new Error('package.json did not parse to an object');
  return raw;
}

function readDependencies(): Record<string, string> {
  const deps = readPackageJson()['dependencies'];
  if (typeof deps !== 'object' || deps === null) return {};
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range === 'string') out[name] = range;
  }
  return out;
}

function readPatchFilenames(): string[] {
  if (!existsSync(patchesDir)) return [];
  return readdirSync(patchesDir).filter((name) => name.endsWith('.patch'));
}

// ─── The rule ───────────────────────────────────────────────────────────────

type PatchLifetimeCode =
  | 'PATCH_MISSING_WHILE_DEPENDENCY_LIVE'
  | 'PATCH_VERSION_MISMATCH'
  | 'ORPHAN_PATCH_WITHOUT_DEPENDENCY';

interface PatchLifetimeFinding {
  code: PatchLifetimeCode;
  message: string;
}

/**
 * Decide whether the v1 SDK patch and the v1 SDK dependency agree about each
 * other's existence — and, when both exist, about the version.
 *
 * Deliberately a pure function of its two inputs so both arms can be driven
 * with synthetic populations. Neither input is derived from the other:
 * `package.json` does not read `patches/`, and a patch filename does not read
 * `package.json`, so they can genuinely disagree.
 */
export function checkPatchLifetime(
  dependencies: Readonly<Record<string, string>>,
  patchFilenames: readonly string[],
): PatchLifetimeFinding[] {
  const findings: PatchLifetimeFinding[] = [];
  const pinned = dependencies[V1_PACKAGE];
  const v1Patches = patchFilenames.filter((name) => name.startsWith(V1_PATCH_PREFIX));

  if (pinned === undefined) {
    for (const name of v1Patches) {
      findings.push({
        code: 'ORPHAN_PATCH_WITHOUT_DEPENDENCY',
        message:
          `"${name}" patches ${V1_PACKAGE}, which is no longer a dependency. ` +
          `The patch was a v1-only backport of behaviour @modelcontextprotocol/` +
          `server@2.0.0 provides natively (DR-0 task 050); once v1 is gone the ` +
          `patch — and patch-package with it, if nothing else needs it — must go too.`,
      });
    }
    return findings;
  }

  if (v1Patches.length === 0) {
    findings.push({
      code: 'PATCH_MISSING_WHILE_DEPENDENCY_LIVE',
      message:
        `${V1_PACKAGE}@${pinned} is still a dependency but no patch for it ` +
        `remains in patches/. v1 emits draft-07 and DROPS every ` +
        `discriminated-union outputSchema without this patch, and nothing in ` +
        `npm reports that — the loss is entirely on the wire. Restore the ` +
        `patch, or remove v1 first (task 053).`,
    });
    return findings;
  }

  for (const name of v1Patches) {
    // patch-package matches a patch to an installed package by the version
    // embedded in the filename; a mismatch means silent non-application.
    if (!name.startsWith(`${V1_PATCH_PREFIX}${pinned}.patch`)) {
      findings.push({
        code: 'PATCH_VERSION_MISMATCH',
        message:
          `"${name}" does not name the pinned version ${pinned}. patch-package ` +
          `matches patches to packages by that version, so this patch will not ` +
          `be applied — the SDK bump silently reverts tools/list to draft-07. ` +
          `Regenerate with: npx patch-package ${V1_PACKAGE}`,
      });
    }
  }

  return findings;
}

describe('DR-0 / task 050 — SDK patch lifetime policy', () => {
  /**
   * The rule itself, driven over populations the live tree cannot supply today.
   *
   * BLOCKING ARM — each failure mode is provoked and must be reported with its
   * own code. NEGATIVE TWIN — the agreeing populations (both present at a
   * matching version; both absent) must report nothing, so the rejections above
   * are attributable to the disagreement rather than to a rule that fails on
   * everything.
   */
  it('CheckPatchLifetime_DisagreeingPopulations_AreRejected', () => {
    const pinned = { [V1_PACKAGE]: '1.29.0' };
    const matching = ['@modelcontextprotocol+sdk+1.29.0.patch'];

    // NEGATIVE TWIN — agreement is silent, in both directions.
    expect(checkPatchLifetime(pinned, matching)).toEqual([]);
    expect(checkPatchLifetime({}, [])).toEqual([]);
    // An unrelated patch for some other package is none of this rule's business.
    expect(checkPatchLifetime({}, ['some-other-pkg+1.0.0.patch'])).toEqual([]);

    // BLOCKING ARM — deleted too early.
    expect(checkPatchLifetime(pinned, []).map((f) => f.code)).toEqual([
      'PATCH_MISSING_WHILE_DEPENDENCY_LIVE',
    ]);

    // BLOCKING ARM — kept too long.
    expect(checkPatchLifetime({}, matching).map((f) => f.code)).toEqual([
      'ORPHAN_PATCH_WITHOUT_DEPENDENCY',
    ]);

    // BLOCKING ARM — the quiet one: pin moved, filename did not.
    const bumped = { [V1_PACKAGE]: '1.30.0' };
    expect(checkPatchLifetime(bumped, matching).map((f) => f.code)).toEqual([
      'PATCH_VERSION_MISMATCH',
    ]);
  });

  /**
   * The live tree. Task 049 removed v1 AND its patch together, so the expected
   * verdict is now "no v1 dependency, no v1 patch, nothing to report" — the
   * death condition this policy was written to reach, actually reached.
   *
   * ── The anti-vacuity guard had to MOVE, not just relax ──────────────────────
   * This arm used to assert `patches.length > 0` on the grounds that an empty
   * read would make the verdict meaningless. That was right while a patch was
   * expected; it is wrong now, because zero patches is the CORRECT state and the
   * assertion would force an orphan file to exist forever to satisfy its own
   * vacuity check.
   *
   * Deleting it outright would be the real hazard, so the tooth is relocated
   * rather than dropped: the rule's non-vacuity is established by
   * `CheckPatchLifetime_DisagreeingPopulations_AreRejected`, which drives
   * `checkPatchLifetime` over BOTH populations synthetically (v1-present and
   * v1-absent) and requires findings from each. A broken rule that returns `[]`
   * for everything fails THERE, so `[]` here is meaningful. What remains
   * checkable live — that the manifest read resolved something at all — stays.
   */
  it('PatchLifetime_LiveTree_AgreesWithTheDeclaredPin', () => {
    const dependencies = readDependencies();
    const patches = readPatchFilenames();

    // Anti-vacuity on the input the tree can still be wrong about: a manifest
    // read that resolved nothing would make the verdict below meaningless.
    expect(Object.keys(dependencies).length).toBeGreaterThan(0);

    const findings = checkPatchLifetime(dependencies, patches);
    expect(
      findings.map((f) => f.message),
      'The SDK patch and the declared dependency disagree.',
    ).toEqual([]);

    // The death condition, asserted as a pair rather than inferred. Either half
    // alone is a defect the rule above already names: a patch with no package
    // is an orphan, a v1 package with no patch is the silent wire regression.
    expect(dependencies[V1_PACKAGE]).toBeUndefined();
    expect(patches.filter((n) => n.startsWith(V1_PATCH_PREFIX))).toEqual([]);

    // ── SECOND AUTHORITY: what npm RESOLVED, not what we declared ────────────
    // The lockfile is not derived from the manifest — it is the record of a
    // resolution that already happened, and it can lag one behind. A lockfile
    // still carrying the v1 tree would put a v1 install back under
    // `node_modules` for `patch-package` to find, which is the deleted-too-early
    // regression re-entering through a path the manifest check cannot see.
    const lockRaw: unknown = JSON.parse(
      readFileSync(join(packageRoot, 'package-lock.json'), 'utf8'),
    );
    const lockPackages =
      typeof lockRaw === 'object' && lockRaw !== null
        ? ((lockRaw as { packages?: Record<string, unknown> }).packages ?? {})
        : {};
    const lockedPaths = Object.keys(lockPackages);

    // Anti-vacuity: an unreadable or empty lockfile must not read as "clean".
    expect(lockedPaths.length).toBeGreaterThan(0);

    expect(
      lockedPaths.filter((p) => p.endsWith(`node_modules/${V1_PACKAGE}`)),
      'The lockfile still resolves the v1 SDK even though the manifest dropped ' +
        'it. `npm install` would restore a v1 tree under node_modules, and any ' +
        'v1 patch would start applying again — run `npm install` to re-resolve ' +
        'and commit the updated lockfile.',
    ).toEqual([]);
  });

  /**
   * `patch-package` only runs if it is wired to run. A patch file that is never
   * applied is indistinguishable, on the wire, from no patch at all.
   */
  it('PatchLifetime_PatchPackageWiring_MatchesWhetherAnyPatchExists', () => {
    // The applier and the patches it applies live or die together, so this is a
    // BICONDITIONAL rather than a one-sided requirement. Both arms are real:
    //
    //   patches present, no applier — patches/ sits in the tree describing
    //     corrections nothing performs, and npm reports nothing. Whatever the
    //     patch guaranteed is lost silently on the wire.
    //
    //   applier present, no patches — an orphan `postinstall` runs on every
    //     install of the PUBLISHED product to apply nothing. Task 019 hit this
    //     arm: the old server package was never published, so its no-op
    //     postinstall was harmless there and would not have been here.
    //
    // The rule above already states the policy ("the patch — and patch-package
    // with it, if nothing else needs it — must go too"); this holds the live
    // manifest to it in both directions.
    const pkg = readPackageJson();
    const dependencies = readDependencies();
    const scripts = pkg['scripts'];
    if (!isRecord(scripts)) throw new Error('package.json scripts is not an object');

    const patchCount = readPatchFilenames().length;
    const applierDeclared = dependencies['patch-package'] !== undefined;
    const postinstallApplies =
      typeof scripts['postinstall'] === 'string' &&
      scripts['postinstall'].includes('patch-package');

    if (patchCount > 0) {
      expect(
        applierDeclared,
        `${patchCount} patch file(s) exist but patch-package is not a dependency`,
      ).toBe(true);
      expect(
        postinstallApplies,
        `${patchCount} patch file(s) exist but nothing applies them — postinstall must run patch-package`,
      ).toBe(true);
    } else {
      expect(
        postinstallApplies,
        'no patches remain, so postinstall must not run patch-package on every install of the published product',
      ).toBe(false);
    }
  });

  /**
   * ── RETIRED BY TASK 049, deliberately and with its guarantee re-homed ──────
   *
   * `SdkPatch_RegeneratedContent_RetainsEveryBehaviouralHunk` used to pin the
   * patch's three behavioural hunks against TWO authorities: the patch file
   * (which DECLARED them) and the installed v1 SDK under `node_modules` (which
   * DEMONSTRATED them). DR-0's source migration removed
   * `@modelcontextprotocol/sdk` entirely and this task deleted the now-orphan
   * patch, so BOTH authorities are gone — not stale, gone. There is no honest
   * way to keep the assertion: it would be reading a file that does not exist
   * about a package that is not installed.
   *
   * WHAT THE PATCH EXISTED TO GUARANTEE IS UNCHANGED AND STILL CHECKED, which
   * is the only reason this is a retirement rather than a loss. The patch was a
   * v1-only backport of behaviour v2 has natively: `tools/list` emitting
   * draft-2020-12, and the discriminated-union LCD envelope staying
   * object-rooted instead of being silently dropped. Task 050 predicted this
   * and said the conformance test is "retained regardless as a conformance
   * check rather than a patch guard" — so the surviving guard is
   * `integration/tools-list-2020-12.test.ts`, which asserts the WIRE OUTPUT
   * rather than the mechanism that produced it. It passes against v2 with no
   * patch applied, which is the empirical answer to the question task 050
   * posed: SEP-2106 covers both halves.
   *
   * That substitution is strictly better than what it replaces. The old arm
   * checked that a specific workaround was present in a specific vendored file;
   * the surviving one checks the property anyone actually cares about, and
   * would stay meaningful across any future SDK change.
   *
   * The LIFETIME rule above (`PatchLifetime_LiveTree_AgreesWithTheDeclaredPin`)
   * is deliberately NOT retired: it is a pure function over (dependencies,
   * patch filenames) with both populations exercised synthetically, so it needs
   * no v1 to stay sharp — and it is precisely the rule that flagged this
   * orphaned patch for deletion in the first place.
   */
});
