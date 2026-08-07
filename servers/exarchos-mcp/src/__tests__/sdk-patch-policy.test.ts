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

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
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
   * The live tree. Today v1 is still installed, so the expected verdict is
   * "patch present, version matching, nothing to report".
   */
  it('PatchLifetime_LiveTree_AgreesWithTheDeclaredPin', () => {
    const dependencies = readDependencies();
    const patches = readPatchFilenames();

    // Anti-vacuity: an empty read of either input would make the verdict below
    // meaningless while still reporting green.
    expect(Object.keys(dependencies).length).toBeGreaterThan(0);
    expect(patches.length).toBeGreaterThan(0);

    const findings = checkPatchLifetime(dependencies, patches);
    expect(
      findings.map((f) => f.message),
      'The SDK patch and the declared dependency disagree.',
    ).toEqual([]);
  });

  /**
   * `patch-package` only runs if it is wired to run. A patch file that is never
   * applied is indistinguishable, on the wire, from no patch at all.
   */
  it('PatchLifetime_PatchPackage_IsInstalledAndWiredToPostinstall', () => {
    const pkg = readPackageJson();
    const dependencies = readDependencies();
    expect(dependencies['patch-package']).toBeDefined();

    const scripts = pkg['scripts'];
    expect(isRecord(scripts)).toBe(true);
    if (!isRecord(scripts)) throw new Error('package.json scripts is not an object');
    const postinstall = scripts['postinstall'];
    expect(
      postinstall,
      'patches/ exists but nothing applies it — postinstall must run patch-package',
    ).toBe('patch-package');
  });

  /**
   * The patch's SUBSTANCE, not its prose.
   *
   * Task 050 regenerated the patch to re-base its justification (it is a
   * v1-only backport of v2-native behaviour, not a workaround for an open
   * upstream bug). Regenerating from a mutated `node_modules` is exactly how a
   * hunk gets silently lost, so the three behavioural changes are pinned by
   * their code, not by their comments.
   *
   * BLOCKING ARM — every behavioural change must be present in the patch AND
   * live in the installed SDK.
   *
   * NEGATIVE TWIN / second authority — the patch file DECLARES the changes;
   * `node_modules/@modelcontextprotocol/sdk` DEMONSTRATES them. Neither is
   * computed from the other, so they can genuinely disagree: a patch that is
   * present but never applied (postinstall removed, filename version drifted,
   * a hand-edit to node_modules) satisfies the file check alone while the wire
   * quietly reverts to draft-07. Checking only the patch text would call that
   * green.
   *
   * @kill-seam: a patch file that is present and correct but never actually applied to the installed SDK
   * @oracle-sources: patches/@modelcontextprotocol+sdk+1.29.0.patch, ../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js
   */
  it('SdkPatch_RegeneratedContent_RetainsEveryBehaviouralHunk', () => {
    const patches = readPatchFilenames().filter((n) => n.startsWith(V1_PATCH_PREFIX));
    expect(patches.length).toBe(1);
    const patchName = patches[0];
    if (patchName === undefined) throw new Error('no v1 patch resolved');
    const body = readFileSync(join(patchesDir, patchName), 'utf8');

    // Both files the patch must reach.
    expect(body).toContain('server/mcp.js');
    expect(body).toContain('server/zod-compat.js');

    // Added lines only — a `+` prefix, so a coincidental match in the removed
    // or context text cannot satisfy these.
    const added = body
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');

    // Hunk 1/2 — the dialect. Both the input and the output conversion paths.
    const targetLines = added
      .split('\n')
      .filter((l) => l.includes("target: 'draft-2020-12'"));
    expect(
      targetLines.length,
      'the draft-2020-12 target must be set on BOTH the inputSchema and the ' +
        'outputSchema conversion — one alone leaves half the manifest on draft-07',
    ).toBeGreaterThanOrEqual(2);

    // Hunk 3 — the object-root splice, on both paths.
    const spliceLines = added.split('\n').filter((l) => l.includes("emitted.type = 'object'"));
    expect(spliceLines.length).toBeGreaterThanOrEqual(2);

    // Hunk 4 — DU acceptance, without which the splice never runs because the
    // schema is dropped before it gets there.
    expect(added).toContain("def.type === 'union'");
    expect(added).toContain('def.discriminator');

    // ── Second authority: the SAME changes, live in the installed SDK ───────
    // A declared-but-unapplied patch is the failure this arm exists to catch.
    const installedMcp = join(SDK_SERVER_DIR, 'mcp.js');
    const installedZodCompat = join(SDK_SERVER_DIR, 'zod-compat.js');
    expect(
      existsSync(installedMcp) && existsSync(installedZodCompat),
      `${V1_PACKAGE} is a dependency but its server modules are not installed — ` +
        'run npm install before trusting this suite',
    ).toBe(true);

    const liveMcp = readFileSync(installedMcp, 'utf8');
    const liveZodCompat = readFileSync(installedZodCompat, 'utf8');

    expect(
      liveMcp.split("target: 'draft-2020-12'").length - 1,
      'the installed SDK does not carry the draft-2020-12 target on both ' +
        'conversion paths — the patch is present but NOT applied. Run `npx ' +
        'patch-package` (postinstall should have done this).',
    ).toBeGreaterThanOrEqual(2);
    expect(liveMcp.split("emitted.type = 'object'").length - 1).toBeGreaterThanOrEqual(2);
    expect(
      liveZodCompat,
      'the installed SDK still drops discriminated unions — the patch is not applied',
    ).toContain('def.discriminator');
  });
});
