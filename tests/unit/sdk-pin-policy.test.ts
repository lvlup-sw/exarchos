/**
 * The pin policy for the MCP SDK. Each `@modelcontextprotocol/*` dependency has an exact pin, so a
 * version bump is an explicit, reviewed change and not a result of `npm install`.
 *
 * The three v2 packages (`core`, `server`, `client`) are one generation. The v1 package
 * `@modelcontextprotocol/sdk` is gone, and `SdkPinPolicy_V1Generation_IsFullyRemoved` checks that
 * against two sources:
 *
 * - the manifest, across each dependency map: the declared set
 * - the parsed package tree: the imported set
 *
 * A package that the manifest lost while a module still imports it is a broken build. The tree
 * walk starts at the package root, because a v1 import can be outside `src`.
 *
 * @oracle-sources: ../../package.json, ../../tools/test-helpers/module-specifier-parser.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

import { parseModuleSpecifiers } from '../../tools/test-helpers/module-specifier-parser.js';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The repository root, which is also the package root. No manifest in the repository sits above
 * it, so the test reads one manifest.
 */
const packageRoot = join(here, '../..');
const packageJsonPath = join(packageRoot, 'package.json');

/** The three v2 packages. They are one generation and must have one version. */
const V2_PACKAGES = [
  '@modelcontextprotocol/core',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/client',
] as const;

/** The retired v1 package root. Each subpath under it also belongs to v1. */
const V1_PACKAGE = '@modelcontextprotocol/sdk';

/** An exact version such as `2.0.0`, or a patch wildcard such as `2.0.x`. No range operator. */
const EXACT_PIN = /^\d+\.\d+\.(\d+|x)$/;

function readDependencies(): Record<string, string> {
  const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (typeof pkg !== 'object' || pkg === null) {
    throw new Error('package.json did not parse to an object');
  }
  const deps = (pkg as { dependencies?: unknown }).dependencies;
  if (typeof deps !== 'object' || deps === null) {
    throw new Error('package.json has no dependencies object');
  }
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range === 'string') out[name] = range;
  }
  return out;
}

/**
 * Reads each declared dependency of a manifest, across each dependency map that npm installs from.
 * A read of only `dependencies` misses a v1 entry under `devDependencies`, which npm still
 * installs. The function throws when the manifest has no dependency map, because an empty record
 * lacks v1 for the wrong reason.
 */
function readAllDeclaredDeps(manifestPath: string): Record<string, string> {
  const pkg: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof pkg !== 'object' || pkg === null) {
    throw new Error(`${manifestPath} did not parse to an object`);
  }
  const maps = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const;
  const out: Record<string, string> = {};
  let mapsSeen = 0;
  for (const key of maps) {
    const map = (pkg as Record<string, unknown>)[key];
    if (typeof map !== 'object' || map === null) continue;
    mapsSeen += 1;
    for (const [name, range] of Object.entries(map)) {
      if (typeof range === 'string') out[name] = range;
    }
  }
  if (mapsSeen === 0) {
    throw new Error(`${manifestPath} declared no dependency maps at all`);
  }
  return out;
}

function expectExactPin(name: string, range: string): void {
  expect(range, `${name} must be exact-pinned, got "${range}"`).toMatch(EXACT_PIN);
  expect(range.startsWith('^'), `${name} must not use a caret range`).toBe(false);
  expect(range.startsWith('~'), `${name} must not use a tilde range`).toBe(false);
}

/**
 * Walks each `.ts` module in the package and collects the v1 import sites. The walk starts at the
 * package root and not at a named subtree, so a new tree is in scope with no list to update.
 *
 * It skips `node_modules` and `dist`, which are vendored and generated. It also skips hidden
 * directories, which hold scratch files and configuration and no published source.
 *
 * The specifiers come from a parse and not a text match. A v1 package name in a fixture string
 * thus does not count as an import.
 */
function importSitesInPackage(): {
  moduleCount: number;
  modulesOutsideSrc: number;
  v1Sites: string[];
} {
  const v1Sites: string[] = [];
  let moduleCount = 0;
  let modulesOutsideSrc = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        if (entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      moduleCount += 1;
      const module = relative(packageRoot, full).split(sep).join('/');
      if (!module.startsWith('src/')) modulesOutsideSrc += 1;
      for (const parsed of parseModuleSpecifiers(readFileSync(full, 'utf8'), full)) {
        const { specifier } = parsed;
        if (specifier === V1_PACKAGE || specifier.startsWith(`${V1_PACKAGE}/`)) {
          v1Sites.push(`${module}:${parsed.line} → ${specifier}`);
        }
      }
    }
  };

  walk(packageRoot);
  return { moduleCount, modulesOutsideSrc, v1Sites };
}

describe('MCP SDK pin policy (#1292, DR-0)', () => {
  /**
   * v2 is a new major with a surface that still changes, so each bump must be explicit. The three
   * packages are one generation and must have one version. A tree with `core@2.0.0` and
   * `server@2.1.0` gives a structural type mismatch with no package identity to explain it.
   */
  it('SdkPinPolicy_V2Packages_AreExactPinned', () => {
    const deps = readDependencies();

    for (const name of V2_PACKAGES) {
      expect(deps[name], `${name} must be a declared dependency (DR-0)`).toBeTypeOf(
        'string',
      );
    }

    for (const name of V2_PACKAGES) {
      expectExactPin(name, deps[name]!);
    }

    const versions = new Set(V2_PACKAGES.map((name) => deps[name]!));
    expect(
      [...versions],
      'The v2 packages must be pinned to ONE version — they are a single ' +
        'generation and the seam draws handles across all three.',
    ).toHaveLength(1);
  });

  /**
   * The manifest must not declare the v1 package, and a module in the package must not import it.
   *
   * Two checks stop a pass from an empty scan. The walk must resolve more than 50 modules. It must
   * also reach modules outside `src`, because a walk of only `src` passes the count and misses a
   * v1 import in another tree.
   */
  it('SdkPinPolicy_V1Generation_IsFullyRemoved', () => {
    expect(
      readAllDeclaredDeps(packageJsonPath)[V1_PACKAGE],
      `${V1_PACKAGE} (v1) was removed by task 049. Re-declaring it re-opens the ` +
        `two-generation hazard the seam's brand exists to police — if that is ` +
        `genuinely wanted, it is a DR-0 decision to reverse, not a dependency ` +
        `to add back.`,
    ).toBeUndefined();

    const { moduleCount, modulesOutsideSrc, v1Sites } = importSitesInPackage();

    expect(
      moduleCount,
      'The source walk resolved implausibly few modules — the scan is broken, ' +
        'so its zero-v1-imports verdict means nothing.',
    ).toBeGreaterThan(50);

    expect(
      modulesOutsideSrc,
      'The walk resolved no modules outside `src/`. Task 049 shipped a ' +
        'surviving v1 import in `test/process/` for exactly this reason — a ' +
        'src-only scan reports a package-wide verdict it never measured.',
    ).toBeGreaterThan(0);

    expect(
      v1Sites,
      `These modules still import the retired v1 SDK. The package is no longer ` +
        `installed, so these are broken imports, not merely stale ones — route ` +
        `them through \`contract/sdk/seam.ts\`.`,
    ).toEqual([]);
  });
});
