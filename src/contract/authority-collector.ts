// ─── Authority collector + verification entry point (P03-01) ─────────────────
//
// The impure counterpart to `authority-pin.ts`: reads the live authorities from
// the real tree (schema module, compatibility policy, invariant catalog,
// package.json, the MCP SDK protocol constant, and the ActionId registry),
// loads the checked-in lockfile, and returns the fail-closed verdict.
//
// `verifyContractAuthority()` is the entry point that BLOCKS generation and
// release (wired as a real test in `authority-collector.test.ts`). Downstream
// work packages (P03-02 … P03-09) import `collectLiveAuthorities()` /
// `verifyContractAuthority()` to gate their generators against the frozen,
// approved snapshot.
//
// Path resolution is anchored to THIS module's location (import.meta.url) so it
// works identically under vitest (source) and a built dist. All paths are
// overridable via {@link AuthoritySourcePaths} for testing / targeting another
// tree.
// ────────────────────────────────────────────────────────────────────────────

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
 * The declared compatibility-policy version. Bump this (and re-approve the
 * lock) when the semver compatibility policy in `src/lib/plugin-compat.ts`
 * changes meaning, not just implementation detail.
 */
export const COMPATIBILITY_POLICY_VERSION = '1.0.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolvable source locations for every authority. Overridable for tests. */
export interface AuthoritySourcePaths {
  /** Hand-written Strategos.Contracts stand-in schema module. */
  readonly strategosContractsFile: string;
  /** Compatibility-policy implementation. */
  readonly compatibilityPolicyFile: string;
  /** exarchos-mcp package.json (version + SDK dependency spec). */
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
    // src/contract → src → exarchos-mcp → servers → <repo root> → .exarchos/…
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

function extractSdkVersionSpec(packageJsonText: string): string {
  const parsed: unknown = JSON.parse(packageJsonText);
  if (parsed && typeof parsed === 'object' && 'dependencies' in parsed) {
    const deps = (parsed as { dependencies?: unknown }).dependencies;
    if (deps && typeof deps === 'object') {
      // Retargeted to the v2 server package by task 049 (DR-0). The v1
      // `@modelcontextprotocol/sdk` dependency is gone, and an extractor still
      // reading its key would silently return '' — which reads downstream as
      // "unpinned" rather than "the package moved", i.e. a floating-dependency
      // alarm nobody could act on. This must name the package the protocol
      // version above is actually read from.
      const spec = (deps as Record<string, unknown>)['@modelcontextprotocol/server'];
      if (typeof spec === 'string') return spec;
    }
  }
  return '';
}

function extractPackageVersion(packageJsonText: string): string {
  const parsed: unknown = JSON.parse(packageJsonText);
  if (parsed && typeof parsed === 'object' && 'version' in parsed) {
    const version = (parsed as { version?: unknown }).version;
    if (typeof version === 'string') return version;
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
    strategosContractsVersion: extractPackageVersion(packageJsonText),
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
 * Verify the live tree against the approved lockfile. This is the entry point
 * that BLOCKS generation and release: it fails closed on a floating, unapproved,
 * mismatched, or missing authority — and on a missing/invalid lockfile.
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
