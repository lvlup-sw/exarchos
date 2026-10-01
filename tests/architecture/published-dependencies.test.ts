/**
 * A public user installs the published package from npmjs.org, with no
 * `.npmrc` and no token. So every package that such an install must fetch has
 * to be on npmjs.org.
 *
 * This repository's `.npmrc` maps some scopes to other registries. A package
 * of such a scope is often restricted there, and npmjs.org returns 404 for it.
 * When it is listed under `dependencies`, the public install fails with E404,
 * while every CI job still passes, because CI has the token.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const PUBLIC_REGISTRY_HOST = 'registry.npmjs.org';

/** The package.json sections that a public `npm install` of this package resolves. */
const INSTALLED_SECTIONS = ['dependencies', 'peerDependencies'] as const;

type PackageJson = Partial<Record<(typeof INSTALLED_SECTIONS)[number], Record<string, string>>>;

interface NpmrcRegistries {
  readonly defaultRegistry: string | undefined;
  readonly scopes: ReadonlyMap<string, string>;
}

/** Reads the default registry and the `@scope:registry=` lines of an .npmrc text. */
function parseNpmrcRegistries(npmrcText: string): NpmrcRegistries {
  const scopes = new Map<string, string>();
  let defaultRegistry: string | undefined;
  for (const raw of npmrcText.split(/\r?\n/)) {
    const line = raw.trim();
    const scoped = /^(@[^:\s]+):registry\s*=\s*(\S+)$/.exec(line);
    if (scoped) scopes.set(scoped[1]!, scoped[2]!);
    const unscoped = /^registry\s*=\s*(\S+)$/.exec(line);
    if (unscoped) defaultRegistry = unscoped[1]!;
  }
  return { defaultRegistry, scopes };
}

function isPublicRegistry(url: string): boolean {
  try {
    return new URL(url).host === PUBLIC_REGISTRY_HOST;
  } catch {
    return false;
  }
}

/** The package that a dependency entry installs. An `npm:` alias names a different package. */
function installedPackageName(name: string, spec: string): string {
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)/.exec(spec);
  return alias ? alias[1]! : name;
}

/** The registry that a package name resolves from under the given .npmrc. */
function registryFor(packageName: string, npmrc: NpmrcRegistries): string {
  const scope = packageName.startsWith('@') ? packageName.split('/')[0]! : undefined;
  const scoped = scope === undefined ? undefined : npmrc.scopes.get(scope);
  return scoped ?? npmrc.defaultRegistry ?? `https://${PUBLIC_REGISTRY_HOST}/`;
}

/** Each installed dependency entry that resolves from a registry other than npmjs.org. */
function foreignInstalledDependencies(pkg: PackageJson, npmrc: NpmrcRegistries): string[] {
  const foreign: string[] = [];
  for (const section of INSTALLED_SECTIONS) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      const registry = registryFor(installedPackageName(name, spec), npmrc);
      if (!isPublicRegistry(registry)) foreign.push(`${section}.${name} -> ${registry}`);
    }
  }
  return foreign;
}

function readRepoNpmrc(): NpmrcRegistries {
  return parseNpmrcRegistries(fs.readFileSync(path.join(REPO_ROOT, '.npmrc'), 'utf8'));
}

function readRepoPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as PackageJson;
}

describe('published dependencies resolve from npmjs.org', () => {
  it('Npmrc_MapsAtLeastOneScopeToAnotherRegistry', () => {
    const npmrc = readRepoNpmrc();
    const foreignScopes = [...npmrc.scopes].filter(([, url]) => !isPublicRegistry(url));
    expect(foreignScopes.length, 'the guard read no foreign scope from .npmrc').toBeGreaterThan(0);
    expect(npmrc.scopes.get('@lvlup-sw')).toBe('https://npm.pkg.github.com');
  });

  it('PackageJson_InstalledDependencies_AllResolveFromNpmjs', () => {
    const pkg = readRepoPackageJson();
    expect(Object.keys(pkg.dependencies ?? {}).length, 'no dependencies were read').toBeGreaterThan(0);
    expect(foreignInstalledDependencies(pkg, readRepoNpmrc())).toEqual([]);
  });

  it('SeededRestrictedRuntimeDependency_IsNamed', () => {
    const pkg = readRepoPackageJson();
    const seeded: PackageJson = {
      ...pkg,
      dependencies: { ...pkg.dependencies, '@lvlup-sw/strategos-contracts': '0.14.0' },
    };
    expect(foreignInstalledDependencies(seeded, readRepoNpmrc())).toEqual([
      'dependencies.@lvlup-sw/strategos-contracts -> https://npm.pkg.github.com',
    ]);
  });

  it('SeededAliasToARestrictedScope_IsNamed', () => {
    const seeded: PackageJson = {
      dependencies: { contracts: 'npm:@lvlup-sw/strategos-contracts@0.14.0', zod: '^4.4.3' },
    };
    expect(foreignInstalledDependencies(seeded, readRepoNpmrc())).toEqual([
      'dependencies.contracts -> https://npm.pkg.github.com',
    ]);
  });

  it('SeededRestrictedPeerDependency_IsNamed', () => {
    const seeded: PackageJson = { peerDependencies: { '@lvlup-sw/strategos-contracts': '0.14.0' } };
    expect(foreignInstalledDependencies(seeded, readRepoNpmrc())).toEqual([
      'peerDependencies.@lvlup-sw/strategos-contracts -> https://npm.pkg.github.com',
    ]);
  });

  it('SeededDefaultRegistryOverride_NamesEveryUnscopedDependency', () => {
    const npmrc = parseNpmrcRegistries('registry=https://npm.example.test/\n');
    const seeded: PackageJson = { dependencies: { zod: '^4.4.3' } };
    expect(foreignInstalledDependencies(seeded, npmrc)).toEqual([
      'dependencies.zod -> https://npm.example.test/',
    ]);
  });
});
