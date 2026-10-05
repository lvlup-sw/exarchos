/**
 * The lifetime policy for the v1 SDK patch and for `patch-package`. The patch was a backport for
 * `@modelcontextprotocol/sdk` only, so it must exist exactly while that package is a dependency.
 *
 * - Deleted too early: v1 still serves the wire, and `tools/list` reverts to draft-07. npm reports
 *   nothing.
 * - Kept too long: `patch-package` does not fail on a patch for an absent package.
 * - Stale version: `patch-package` matches a patch by the version in its filename, so a moved pin
 *   leaves the patch unapplied.
 *
 * Each rule is a pure function. The tests drive it with the two populations, because the live tree
 * can show only one. `tests/integration/tools-list-2020-12.test.ts` checks the wire output.
 *
 * The manifest records what is declared, and the lockfile records what npm resolved. A lockfile
 * that still holds a v1 tree puts a v1 install back under `node_modules`.
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
/** The directory of the v1 SDK server modules under `node_modules`. */
const SDK_SERVER_DIR = join(
  packageRoot,
  'node_modules',
  '@modelcontextprotocol',
  'sdk',
  'dist',
  'esm',
  'server',
);

/** The v1 SDK, the package that the patch corrected. */
const V1_PACKAGE = '@modelcontextprotocol/sdk';

/** `patch-package` writes `@scope/name` as `@scope+name` in a patch filename. */
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

type PatchLifetimeCode =
  | 'PATCH_MISSING_WHILE_DEPENDENCY_LIVE'
  | 'PATCH_VERSION_MISMATCH'
  | 'ORPHAN_PATCH_WITHOUT_DEPENDENCY';

interface PatchLifetimeFinding {
  code: PatchLifetimeCode;
  message: string;
}

/**
 * Decides whether the v1 SDK patch and the v1 SDK dependency agree that each exists. When the two
 * exist, they must also agree on the version. `patch-package` matches a patch to a package by the
 * version in the filename, so a mismatch leaves the patch unapplied with no error.
 *
 * It is a pure function, so a test can drive each arm with a synthetic population. Neither input
 * derives from the other.
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

type PatchToolingCode =
  | 'PATCH_TOOLING_MISSING'
  | 'PATCH_TOOLING_NOT_INVOKED'
  | 'ORPHAN_PATCH_TOOLING'
  | 'ORPHAN_PATCH_INVOCATION';

interface PatchToolingFinding {
  readonly code: PatchToolingCode;
  readonly message: string;
}

/**
 * True when `script` runs `patch-package` and lets its failure surface.
 *
 * A substring test is wrong. `echo patch-package` names the tool and does not run it, and
 * `patch-package || true` discards the exit status. The function splits the script into sequential
 * segments and compares the command word of each one, after an `npx` prefix and its flags. A `|`
 * in the script disqualifies it, because a fallback or a pipe replaces the exit status.
 */
export function invokesPatchPackage(script: unknown): boolean {
  if (typeof script !== 'string') return false;
  if (script.includes('|')) return false;
  return script
    .split(/&&|;/)
    .map((segment) => segment.trim())
    .some((segment) => {
      const words = segment.split(/\s+/).filter((word) => word.length > 0);
      let index = 0;
      if (words[index] === 'npx') {
        index += 1;
        while (words[index]?.startsWith('-')) index += 1;
      }
      return words[index] === 'patch-package';
    });
}

/**
 * Decides whether `patch-package` and the patch files agree that each exists. Patch files with no
 * tooling stay unapplied. Tooling with no patch files runs on each install of the published
 * package and does nothing.
 *
 * It is a pure function, because the live tree can show only one of the two populations.
 */
export function checkPatchToolingLifetime(
  patchFilenames: readonly string[],
  dependencies: Readonly<Record<string, string>>,
  scripts: Readonly<Record<string, unknown>>,
): readonly PatchToolingFinding[] {
  const findings: PatchToolingFinding[] = [];
  const installed = dependencies['patch-package'] !== undefined;
  const invoked = invokesPatchPackage(scripts['postinstall']);

  if (patchFilenames.length > 0) {
    if (!installed) {
      findings.push({
        code: 'PATCH_TOOLING_MISSING',
        message:
          `${patchFilenames.length} patch file(s) exist but patch-package is not a dependency. ` +
          'An unapplied patch is indistinguishable on the wire from no patch at all.',
      });
    }
    if (!invoked) {
      findings.push({
        code: 'PATCH_TOOLING_NOT_INVOKED',
        message:
          `${patchFilenames.length} patch file(s) exist but no postinstall script runs ` +
          'patch-package, so nothing applies them.',
      });
    }
    return findings;
  }

  if (installed) {
    findings.push({
      code: 'ORPHAN_PATCH_TOOLING',
      message:
        'patch-package is a dependency with no patches to apply. It shipped to every consumer ' +
        'of the published package to do nothing — drop it, and restore it with the patch if one ' +
        'is ever needed again.',
    });
  }
  if (invoked) {
    findings.push({
      code: 'ORPHAN_PATCH_INVOCATION',
      message:
        'postinstall runs patch-package with no patches to apply. Every install pays for a ' +
        'no-op, and the hook reads as evidence that patching is live when it is not.',
    });
  }
  return findings;
}

describe('DR-0 / task 050 — SDK patch lifetime policy', () => {
  /**
   * The test drives the rule with populations that the live tree cannot supply. Each failure mode
   * must give its own code. The populations that agree must give no finding, which shows that the
   * rule does not reject every input. A patch for a different package is outside this rule.
   */
  it('CheckPatchLifetime_DisagreeingPopulations_AreRejected', () => {
    const pinned = { [V1_PACKAGE]: '1.29.0' };
    const matching = ['@modelcontextprotocol+sdk+1.29.0.patch'];

    expect(checkPatchLifetime(pinned, matching)).toEqual([]);
    expect(checkPatchLifetime({}, [])).toEqual([]);
    expect(checkPatchLifetime({}, ['some-other-pkg+1.0.0.patch'])).toEqual([]);

    expect(checkPatchLifetime(pinned, []).map((f) => f.code)).toEqual([
      'PATCH_MISSING_WHILE_DEPENDENCY_LIVE',
    ]);

    expect(checkPatchLifetime({}, matching).map((f) => f.code)).toEqual([
      'ORPHAN_PATCH_WITHOUT_DEPENDENCY',
    ]);

    const bumped = { [V1_PACKAGE]: '1.30.0' };
    expect(checkPatchLifetime(bumped, matching).map((f) => f.code)).toEqual([
      'PATCH_VERSION_MISMATCH',
    ]);
  });

  /**
   * The live tree has no v1 dependency and no v1 patch, so the rule reports nothing. An empty
   * patch list is the correct state, so this test does not require a patch file.
   * `CheckPatchLifetime_DisagreeingPopulations_AreRejected` proves that the rule can fail. Here,
   * the manifest and the lockfile must each give entries, so an empty read does not pass.
   *
   * The lockfile is the second authority. A lockfile that still resolves the v1 SDK puts a v1
   * install back under `node_modules`, where a v1 patch applies again.
   */
  it('PatchLifetime_LiveTree_AgreesWithTheDeclaredPin', () => {
    const dependencies = readDependencies();
    const patches = readPatchFilenames();

    expect(Object.keys(dependencies).length).toBeGreaterThan(0);

    const findings = checkPatchLifetime(dependencies, patches);
    expect(
      findings.map((f) => f.message),
      'The SDK patch and the declared dependency disagree.',
    ).toEqual([]);

    expect(dependencies[V1_PACKAGE]).toBeUndefined();
    expect(patches.filter((n) => n.startsWith(V1_PATCH_PREFIX))).toEqual([]);

    const lockRaw: unknown = JSON.parse(
      readFileSync(join(packageRoot, 'package-lock.json'), 'utf8'),
    );
    const lockPackages =
      typeof lockRaw === 'object' && lockRaw !== null
        ? ((lockRaw as { packages?: Record<string, unknown> }).packages ?? {})
        : {};
    const lockedPaths = Object.keys(lockPackages);

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
   * The tooling must be present exactly while a patch file exists. The test drives the two
   * populations with synthetic input, because the live tree can supply only one.
   */
  it('CheckPatchToolingLifetime_BothPopulations_AreJudged', () => {
    const wired = { 'patch-package': '^8.0.1' };
    const invoking = { postinstall: 'patch-package' };

    expect(checkPatchToolingLifetime(['x+1.0.0.patch'], wired, invoking)).toEqual([]);
    expect(checkPatchToolingLifetime([], {}, {})).toEqual([]);

    expect(checkPatchToolingLifetime(['x+1.0.0.patch'], {}, {}).map((f) => f.code)).toEqual([
      'PATCH_TOOLING_MISSING',
      'PATCH_TOOLING_NOT_INVOKED',
    ]);

    expect(checkPatchToolingLifetime([], wired, invoking).map((f) => f.code)).toEqual([
      'ORPHAN_PATCH_TOOLING',
      'ORPHAN_PATCH_INVOCATION',
    ]);
  });

  /**
   * A script that names `patch-package` and does not run it must not count. A script that discards
   * the exit status must not count. The forms that run it and let it fail must still pass.
   */
  it('InvokesPatchPackage_NamingItIsNotRunningIt', () => {
    const wired = { 'patch-package': '^8.0.1' };
    const notInvoked = (postinstall: string): string[] =>
      checkPatchToolingLifetime(['x+1.0.0.patch'], wired, { postinstall }).map((f) => f.code);

    expect(invokesPatchPackage('echo patch-package')).toBe(false);
    expect(invokesPatchPackage('# patch-package runs here')).toBe(false);
    expect(notInvoked('echo patch-package')).toEqual(['PATCH_TOOLING_NOT_INVOKED']);

    expect(invokesPatchPackage('patch-package || true')).toBe(false);
    expect(invokesPatchPackage('patch-package | tee log')).toBe(false);
    expect(notInvoked('patch-package || true')).toEqual(['PATCH_TOOLING_NOT_INVOKED']);

    expect(invokesPatchPackage('patch-package')).toBe(true);
    expect(invokesPatchPackage('npx patch-package')).toBe(true);
    expect(invokesPatchPackage('npx --no-install patch-package')).toBe(true);
    expect(invokesPatchPackage('npm run build && patch-package')).toBe(true);
    expect(invokesPatchPackage('patch-package --error-on-fail')).toBe(true);
    expect(invokesPatchPackage(undefined)).toBe(false);
  });

  /**
   * The live tree has no patch files, so it must have no `patch-package` dependency and no
   * `postinstall` script. The last three expectations name that state, and they fail when a patch
   * file returns. If you add a patch file, restore the dependency and the `postinstall` script,
   * then change these three expectations.
   */
  it('PatchLifetime_LiveTree_CarriesNoToolingForAnEmptyPatchSet', () => {
    const pkg = readPackageJson();
    const scripts = pkg['scripts'];
    if (!isRecord(scripts)) throw new Error('package.json scripts is not an object');

    const dependencies = readDependencies();
    expect(Object.keys(dependencies).length).toBeGreaterThan(0);
    expect(Object.keys(scripts).length).toBeGreaterThan(0);

    const patches = readPatchFilenames();
    expect(checkPatchToolingLifetime(patches, dependencies, scripts)).toEqual([]);

    expect(patches).toEqual([]);
    expect(dependencies['patch-package']).toBeUndefined();
    expect(scripts['postinstall']).toBeUndefined();
  });
});
