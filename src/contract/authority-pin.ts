/**
 * Contract authority pins and the lockfile contract. Every contract generator builds against these
 * pins, so generation and release use an approved snapshot.
 *
 * `verifyAuthorities` fails closed when an authority is floating, unapproved, mismatched, or
 * missing. This module is pure: it takes collected authority values and a parsed lock, and it
 * returns a verdict. `authority-collector.ts` reads the files, the SDK constant, and the registry.
 *
 * `verbs/gates/contract-drift.ts` compares the schemas of two tree states. This module compares
 * the live tree to an approved lock.
 */

import { z } from 'zod';
import {
  digestText,
  digestIdentifierSet,
  isFloatingVersionSpec,
  DIGEST_RE,
} from './authority-digest.js';

/**
 * The frozen authorities, in canonical order.
 *
 * `contract-surface` is a digest of the closed contract surface in `error-families.ts`,
 * `envelope.ts`, `request-context.ts` and `compatibility.ts`. A new error code, exit mapping, or
 * output-carrier kind changes the digest, and the freeze then needs a new approval.
 */
export const AUTHORITY_IDS = [
  'strategos-contracts',
  'mcp-protocol',
  'mcp-sdk',
  'action-id-registry',
  'compatibility-policy',
  'invariant-catalog',
  'contract-surface',
] as const;

export type AuthorityId = (typeof AUTHORITY_IDS)[number];

/** The kind of thing an authority pins (drives how it is measured/reviewed). */
export const AuthorityKindSchema = z.enum([
  'schema',
  'protocol',
  'package',
  'registry',
  'policy',
  'catalog',
]);
export type AuthorityKind = z.infer<typeof AuthorityKindSchema>;

/**
 * A LIVE-computed authority value (measured from the current tree). Compared
 * against the lock's {@link AuthorityPin} of the same id.
 */
export interface AuthorityValue {
  readonly id: AuthorityId;
  readonly kind: AuthorityKind;
  /** Human-facing pinned version, such as `1.29.0`, or `null` for a digest-only authority. */
  readonly version: string | null;
  /**
   * The raw version spec from source, such as a `package.json` dependency range. Floating
   * detection reads it. It is `null` for an authority that has no version.
   */
  readonly versionSpec: string | null;
  /** Content digest `sha256:<hex>`, or `null` for version-only authorities. */
  readonly digest: string | null;
  /** Provenance: what was measured, for lock review. */
  readonly source: string;
}

/** A single pinned + approved authority entry in the lockfile. */
export const AuthorityPinSchema = z
  .object({
    kind: AuthorityKindSchema,
    version: z.string().nullable(),
    versionSpec: z.string().nullable(),
    digest: z.string().regex(DIGEST_RE).nullable(),
    source: z.string(),
    /**
     * The approval marker of one authority. When this or the whole-lock marker is `false`, the
     * freeze blocks generation and release until a person runs the generator again.
     */
    approved: z.boolean(),
  })
  .strict();
export type AuthorityPin = z.infer<typeof AuthorityPinSchema>;

/** The checked-in authority lockfile. */
export const AuthorityLockSchema = z
  .object({
    lockVersion: z.literal(1),
    /** Whole-lock approval marker (see {@link AuthorityPinSchema.approved}). */
    approved: z.boolean(),
    /** The person, release, or work package that approved this snapshot. */
    approvedBy: z.string(),
    /** Optional human note, such as regeneration instructions. */
    note: z.string().optional(),
    /** Pins keyed by {@link AuthorityId}. The verifier requires a pin for each id. */
    authorities: z.record(z.string(), AuthorityPinSchema),
  })
  .strict();
export type AuthorityLock = z.infer<typeof AuthorityLockSchema>;

/**
 * The collected inputs for {@link computeAuthorities}. `authority-collector.ts` reads them from
 * disk, the SDK, and the registry. Tests supply them directly.
 */
export interface AuthorityInputs {
  /** Version at which the hand-written contract stand-in ships (package version). */
  readonly strategosContractsVersion: string;
  /** Source of the hand-written Strategos.Contracts stand-in schema module. */
  readonly strategosContractsSource: string;
  /** The MCP wire protocol version the projection targets. */
  readonly mcpProtocolVersion: string;
  /** The RAW `@modelcontextprotocol/server` dependency spec (for floating detection). */
  readonly mcpSdkVersionSpec: string;
  /** The flattened `<tool>.<action>` ActionId list (order-independent). */
  readonly actionIds: readonly string[];
  /** The declared compatibility-policy version. */
  readonly compatibilityPolicyVersion: string;
  /** Source of the compatibility policy implementation. */
  readonly compatibilityPolicySource: string;
  /** The invariant-catalog schema version (frontmatter `schema-version`). */
  readonly invariantCatalogSchemaVersion: string;
  /** Source of the target invariant catalog. */
  readonly invariantCatalogSource: string;
  /** The closed contract-surface version (`CONTRACT_SURFACE_VERSION`). */
  readonly contractSurfaceVersion: string;
  /** Canonical serialization of the closed contract surface. */
  readonly contractSurfaceSource: string;
}

/**
 * Computes the live authority values from the inputs. The same inputs give the same digests on
 * any machine.
 */
export function computeAuthorities(inputs: AuthorityInputs): AuthorityValue[] {
  return [
    {
      id: 'strategos-contracts',
      kind: 'schema',
      version: inputs.strategosContractsVersion,
      versionSpec: inputs.strategosContractsVersion,
      digest: digestText(inputs.strategosContractsSource),
      source:
        'digest: src/architecture/invariant-schema.ts (hand-written stand-in, still in ' +
        'use — the published InvariantEntry and CheckNode reject both live catalogs, ' +
        'lvlup-sw/strategos#231). version: the @lvlup-sw/strategos-contracts dependency ' +
        'spec, RECORDED for review and never compared',
    },
    {
      id: 'mcp-protocol',
      kind: 'protocol',
      version: inputs.mcpProtocolVersion,
      versionSpec: inputs.mcpProtocolVersion,
      digest: null,
      source: '@modelcontextprotocol/server LATEST_PROTOCOL_VERSION',
    },
    {
      id: 'mcp-sdk',
      kind: 'package',
      version: inputs.mcpSdkVersionSpec,
      versionSpec: inputs.mcpSdkVersionSpec,
      digest: null,
      source: 'package.json dependencies["@modelcontextprotocol/server"]',
    },
    {
      id: 'action-id-registry',
      kind: 'registry',
      version: null,
      versionSpec: null,
      digest: digestIdentifierSet(inputs.actionIds),
      source: 'registry.ts TOOL_REGISTRY — flattened, deduped, sorted ActionIds',
    },
    {
      id: 'compatibility-policy',
      kind: 'policy',
      version: inputs.compatibilityPolicyVersion,
      versionSpec: inputs.compatibilityPolicyVersion,
      digest: digestText(inputs.compatibilityPolicySource),
      source: 'src/lib/plugin-compat.ts pinned at COMPATIBILITY_POLICY_VERSION',
    },
    {
      id: 'invariant-catalog',
      kind: 'catalog',
      version: inputs.invariantCatalogSchemaVersion,
      versionSpec: inputs.invariantCatalogSchemaVersion,
      digest: digestText(inputs.invariantCatalogSource),
      source: '.exarchos/invariants.md pinned at frontmatter schema-version',
    },
    {
      id: 'contract-surface',
      kind: 'schema',
      version: inputs.contractSurfaceVersion,
      versionSpec: inputs.contractSurfaceVersion,
      digest: digestText(inputs.contractSurfaceSource),
      source:
        'src/contract/{error-families,envelope,request-context,compatibility}.ts ' +
        'closed contract surface (P03-02), pinned at CONTRACT_SURFACE_VERSION',
    },
  ];
}

export type ViolationKind =
  | 'lock-unapproved'
  | 'missing'
  | 'unapproved'
  | 'floating'
  | 'mismatch';

export interface AuthorityViolation {
  /** The offending authority id, or `<lock>` for whole-lock violations. */
  readonly authority: AuthorityId | '<lock>';
  readonly kind: ViolationKind;
  readonly message: string;
}

export interface AuthorityVerdict {
  /** `true` only when there are no violations, so generation and release can continue. */
  readonly ok: boolean;
  readonly violations: AuthorityViolation[];
  /** Human-readable summary. */
  readonly report: string;
}

/**
 * Verifies the live authorities against an approved lock, and fails closed. It checks each
 * authority in this order: missing, floating, unapproved, mismatch. It collects every violation,
 * so one run reports every problem.
 *
 * A floating spec in the live value or in the lock pin is a violation. The version is compared
 * only when neither side has a digest. A digest moves exactly when the frozen content moves, so
 * the version of a digest authority is provenance for the reviewer. The `strategos-contracts`
 * version and digest come from different sources, and a version comparison fails on every
 * release (lvlup-sw/exarchos#1837).
 */
export function verifyAuthorities(
  live: readonly AuthorityValue[],
  lock: AuthorityLock,
): AuthorityVerdict {
  const violations: AuthorityViolation[] = [];

  if (lock.approved !== true) {
    violations.push({
      authority: '<lock>',
      kind: 'lock-unapproved',
      message: 'authority lockfile is not approved (lock.approved !== true)',
    });
  }

  const liveById = new Map<AuthorityId, AuthorityValue>(live.map((a) => [a.id, a]));

  for (const id of AUTHORITY_IDS) {
    const value = liveById.get(id);
    const pin = lock.authorities[id];

    if (!pin) {
      violations.push({
        authority: id,
        kind: 'missing',
        message: `no pin for required authority '${id}' in the lockfile`,
      });
      continue;
    }

    if (value?.versionSpec != null && isFloatingVersionSpec(value.versionSpec)) {
      violations.push({
        authority: id,
        kind: 'floating',
        message:
          `authority '${id}' has a floating version spec '${value.versionSpec}' — ` +
          'pin an exact version before generation/release',
      });
    }
    if (pin.version != null && isFloatingVersionSpec(pin.version)) {
      violations.push({
        authority: id,
        kind: 'floating',
        message: `lock pin for '${id}' records a floating version '${pin.version}'`,
      });
    }

    if (pin.approved !== true) {
      violations.push({
        authority: id,
        kind: 'unapproved',
        message: `authority '${id}' pin is not approved (approved !== true)`,
      });
    }

    if (value) {
      if (value.digest !== pin.digest) {
        violations.push({
          authority: id,
          kind: 'mismatch',
          message:
            `authority '${id}' digest mismatch: live ${String(value.digest)} != ` +
            `locked ${String(pin.digest)}`,
        });
      }
      const versionIsTheOnlySignal = value.digest === null && pin.digest === null;
      if (versionIsTheOnlySignal && value.version !== pin.version) {
        violations.push({
          authority: id,
          kind: 'mismatch',
          message:
            `authority '${id}' version mismatch: live ${String(value.version)} != ` +
            `locked ${String(pin.version)}`,
        });
      }
    } else {
      violations.push({
        authority: id,
        kind: 'missing',
        message: `authority '${id}' could not be measured from the live tree`,
      });
    }
  }

  const ok = violations.length === 0;
  const report = buildReport(ok, violations, live.length);
  return { ok, violations, report };
}

function buildReport(
  ok: boolean,
  violations: readonly AuthorityViolation[],
  liveCount: number,
): string {
  if (ok) {
    return `contract authority OK — ${liveCount} authorities pinned and approved`;
  }
  const lines = [`contract authority BLOCKED — ${violations.length} violation(s):`];
  for (const v of violations) {
    lines.push(`  [${v.kind}] ${v.authority}: ${v.message}`);
  }
  return lines.join('\n');
}

export interface BuildLockOptions {
  /** The person, release, or work package that approves this snapshot. */
  readonly approvedBy: string;
  /** Optional human note, such as regeneration instructions. */
  readonly note?: string;
  /**
   * When `false`, the lock and every pin are unapproved. Tests use it to prove that the freeze
   * blocks an unapproved snapshot. Defaults to `true`.
   */
  readonly approved?: boolean;
}

/**
 * Builds a lockfile object from the live authorities. A run of the generator CLI is the approval:
 * the lock is approved unless {@link BuildLockOptions.approved} is `false`.
 */
export function buildAuthorityLock(
  live: readonly AuthorityValue[],
  opts: BuildLockOptions,
): AuthorityLock {
  const approved = opts.approved ?? true;
  const authorities: Record<string, AuthorityPin> = {};
  for (const a of live) {
    authorities[a.id] = {
      kind: a.kind,
      version: a.version,
      versionSpec: a.versionSpec,
      digest: a.digest,
      source: a.source,
      approved,
    };
  }
  return {
    lockVersion: 1,
    approved,
    approvedBy: opts.approvedBy,
    ...(opts.note ? { note: opts.note } : {}),
    authorities,
  };
}
