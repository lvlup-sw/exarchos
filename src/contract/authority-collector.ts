/**
 * Reads the live contract authorities from the tree and verifies them against the checked-in
 * lockfile. This is the impure side of `authority-pin.ts`.
 *
 * `verifyContractAuthority()` blocks generation and release, and fails closed. Paths resolve from
 * the location of this module, so source and a built dist give the same result.
 * {@link AuthoritySourcePaths} overrides each path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V2_LATEST_PROTOCOL_VERSION } from './sdk/seam.js';
import { TOOL_REGISTRY } from '../registry.js';
import {
  computeAuthorities,
  verifyAuthorities,
  AuthorityLockSchema,
  type AuthorityInputs,
  type AuthorityValue,
  type AuthorityLock,
  type AuthorityVerdict,
} from './authority-pin.js';
import { CONTRACT_SURFACE_VERSION } from './compatibility.js';
import { serializeContractSurface } from './contract-surface.js';

/**
 * The declared compatibility-policy version. Increase it, and approve the lock again, when the
 * meaning of the semver policy in `src/runtime/lib/plugin-compat.ts` changes.
 */
export const COMPATIBILITY_POLICY_VERSION = '1.0.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolvable source locations for every authority. Overridable for tests. */
export interface AuthoritySourcePaths {
  /** Hand-written Strategos.Contracts stand-in schema module. */
  readonly strategosContractsFile: string;
  /** Compatibility-policy implementation. */
  readonly compatibilityPolicyFile: string;
  /** This repo's package.json (the SDK and Strategos-contract dependency specs). */
  readonly packageJsonFile: string;
  /** Target invariant catalog. */
  readonly invariantCatalogFile: string;
  /** The checked-in authority lockfile. */
  readonly lockFile: string;
}

/** Default source paths, anchored to this module's on-disk location. */
export function defaultSourcePaths(): AuthoritySourcePaths {
  return {
    strategosContractsFile: path.resolve(HERE, '../architecture/invariant-schema.ts'),
    compatibilityPolicyFile: path.resolve(HERE, '../runtime/lib/plugin-compat.ts'),
    packageJsonFile: path.resolve(HERE, '../../package.json'),
    invariantCatalogFile: path.resolve(HERE, '../../.exarchos/invariants.md'),
    lockFile: path.resolve(HERE, 'contract-authority.lock.json'),
  };
}

/** Flatten the built-in tool registry into stable `<tool>.<action>` ActionIds. */
export function flattenActionIds(): string[] {
  const ids: string[] = [];
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      ids.push(`${tool.name}.${action.name}`);
    }
  }
  return ids;
}

function readText(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/**
 * Returns the dependency spec of `@lvlup-sw/strategos-contracts`. The spec pins the contract, not
 * the Exarchos package version, so a release of this repo does not change the authority.
 */
function extractStrategosContractsSpec(packageJsonText: string): string {
  return extractDependencySpec(packageJsonText, '@lvlup-sw/strategos-contracts');
}

/** The package.json sections searched for a pinned spec, in order. */
const DEPENDENCY_SECTIONS: readonly string[] = ['dependencies', 'devDependencies'];

/**
 * The spec that package.json pins for a package, from `dependencies` or else
 * from `devDependencies`. A build-only package such as the Strategos contracts
 * lives in `devDependencies`, because the shipped files bundle it.
 *
 * Returns '' when neither section names the package. The freeze reads '' as a
 * floating spec, so a missing pin still blocks.
 */
function extractDependencySpec(packageJsonText: string, packageName: string): string {
  const parsed: unknown = JSON.parse(packageJsonText);
  if (!parsed || typeof parsed !== 'object') return '';
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = (parsed as Record<string, unknown>)[section];
    if (deps && typeof deps === 'object') {
      const spec = (deps as Record<string, unknown>)[packageName];
      if (typeof spec === 'string') return spec;
    }
  }
  return '';
}

/**
 * Returns the `@modelcontextprotocol/server` dependency spec. This package supplies the protocol
 * version. A missing key returns `''`, which reads downstream as an unpinned dependency.
 */
function extractSdkVersionSpec(packageJsonText: string): string {
  const parsed: unknown = JSON.parse(packageJsonText);
  if (parsed && typeof parsed === 'object' && 'dependencies' in parsed) {
    const deps = (parsed as { dependencies?: unknown }).dependencies;
    if (deps && typeof deps === 'object') {
      const spec = (deps as Record<string, unknown>)['@modelcontextprotocol/server'];
      if (typeof spec === 'string') return spec;
    }
  }
  return '';
}

function extractSchemaVersion(catalogText: string): string {
  const match = /^schema-version:\s*(\S+)\s*$/m.exec(catalogText);
  return match?.[1] ?? '';
}

/** Read every authority input from the tree at {@link AuthoritySourcePaths}. */
export function collectAuthorityInputs(
  paths: AuthoritySourcePaths = defaultSourcePaths(),
): AuthorityInputs {
  const packageJsonText = readText(paths.packageJsonFile);
  const catalogText = readText(paths.invariantCatalogFile);
  return {
    strategosContractsVersion: extractStrategosContractsSpec(packageJsonText),
    strategosContractsSource: readText(paths.strategosContractsFile),
    mcpProtocolVersion: V2_LATEST_PROTOCOL_VERSION,
    mcpSdkVersionSpec: extractSdkVersionSpec(packageJsonText),
    actionIds: flattenActionIds(),
    compatibilityPolicyVersion: COMPATIBILITY_POLICY_VERSION,
    compatibilityPolicySource: readText(paths.compatibilityPolicyFile),
    invariantCatalogSchemaVersion: extractSchemaVersion(catalogText),
    invariantCatalogSource: catalogText,
    contractSurfaceVersion: CONTRACT_SURFACE_VERSION,
    contractSurfaceSource: serializeContractSurface(),
  };
}

/** Compute the live authority values from the tree. */
export function collectLiveAuthorities(
  paths: AuthoritySourcePaths = defaultSourcePaths(),
): AuthorityValue[] {
  return computeAuthorities(collectAuthorityInputs(paths));
}

/** Load + schema-validate the checked-in lockfile. Throws on missing/invalid. */
export function loadAuthorityLock(
  lockFile: string = defaultSourcePaths().lockFile,
): AuthorityLock {
  return AuthorityLockSchema.parse(JSON.parse(readText(lockFile)));
}

/**
 * Verifies the live tree against the approved lockfile. This check blocks generation and release.
 * It fails closed on a floating, unapproved, mismatched, or missing authority, and on a missing or
 * invalid lockfile.
 */
export function verifyContractAuthority(
  paths: AuthoritySourcePaths = defaultSourcePaths(),
): AuthorityVerdict {
  const live = collectLiveAuthorities(paths);
  let lock: AuthorityLock;
  try {
    lock = loadAuthorityLock(paths.lockFile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      violations: [
        {
          authority: '<lock>',
          kind: 'missing',
          message: `cannot load/validate authority lockfile at ${paths.lockFile}: ${message}`,
        },
      ],
      report: `contract authority BLOCKED — lockfile unavailable: ${message}`,
    };
  }
  return verifyAuthorities(live, lock);
}
