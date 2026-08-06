// ─── Contract authority pins + lockfile contract (P03-01) ────────────────────
//
// PROGRAM-03 head. Freezes the authorities that every downstream generator
// (P03-02 contract compiler, P03-03 MCP binding gen, P03-04 CLI gen, P03-05
// shared admission IR, …) must build against, so generation and release are
// pinned to an APPROVED snapshot rather than whatever floats in at build time.
//
// ## The authority set
//
//   strategos-contracts   version + digest  — hand-written Strategos.Contracts
//                                              stand-in schema module.
//   mcp-protocol          version           — the MCP wire protocol version.
//   mcp-sdk               version           — the pinned @modelcontextprotocol
//                                              /sdk dependency (exact, no range).
//   action-id-registry    digest            — the stable ActionId set.
//   compatibility-policy  version + digest  — the semver compatibility policy.
//   invariant-catalog     version + digest  — the target invariant catalog.
//
// ## The freeze rule (exit proof)
//
// `verifyAuthorities` fails CLOSED when any authority is:
//   • FLOATING     — no pin, or a version range instead of an exact pin;
//   • UNAPPROVED   — the lock, or an individual pin, is not marked approved;
//   • MISMATCHED   — the live digest/version differs from the locked one;
//   • MISSING      — no pin exists for a required authority.
//
// This module is PURE: it takes already-collected authority VALUES + a parsed
// lock and returns a verdict. The impure collection (reading files, the SDK
// constant, and the registry) lives in `authority-collector.ts`. Keeping the
// verification pure makes each fail-closed rule unit-testable without a repo.
//
// Relationship to `orchestrate/contract-drift.ts`: that gate detects breaking
// SCHEMA changes between a merge-base and HEAD by running external codegen/diff
// tools. This module is the complementary FREEZE layer — it pins the authority
// versions/digests a generator consumes. The two are orthogonal: drift compares
// two tree states; the freeze compares the live tree to an approved lock.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import {
  digestText,
  digestIdentifierSet,
  isFloatingVersionSpec,
  DIGEST_RE,
} from './authority-digest.js';

// ─── Authority identity ─────────────────────────────────────────────────────

/**
 * The frozen authorities, in canonical order.
 *
 * `contract-surface` (P03-02) freezes the CLOSED envelope/error/security/
 * compatibility contract surface (`error-families.ts`, `envelope.ts`,
 * `request-context.ts`, `compatibility.ts`) as a content-addressed digest so a
 * new stable error code, a changed exit mapping, a new output-carrier kind, or
 * a re-classified change class trips the freeze and demands re-approval.
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

// ─── Live authority value ───────────────────────────────────────────────────

/**
 * A LIVE-computed authority value (measured from the current tree). Compared
 * against the lock's {@link AuthorityPin} of the same id.
 */
export interface AuthorityValue {
  readonly id: AuthorityId;
  readonly kind: AuthorityKind;
  /** Human-facing pinned version (e.g. `1.29.0`), or `null` for digest-only. */
  readonly version: string | null;
  /**
   * The RAW version spec as declared in source (e.g. a package.json dependency
   * range). Used for floating detection. `null` for authorities that have no
   * version dimension (pure digest).
   */
  readonly versionSpec: string | null;
  /** Content digest `sha256:<hex>`, or `null` for version-only authorities. */
  readonly digest: string | null;
  /** Provenance: what was measured, for lock review. */
  readonly source: string;
}

// ─── Lockfile wire contract ─────────────────────────────────────────────────

/** A single pinned + approved authority entry in the lockfile. */
export const AuthorityPinSchema = z
  .object({
    kind: AuthorityKindSchema,
    version: z.string().nullable(),
    versionSpec: z.string().nullable(),
    digest: z.string().regex(DIGEST_RE).nullable(),
    source: z.string(),
    /**
     * Explicit per-authority approval marker. `false` (or a whole-lock
     * `approved: false`) means the pin is recorded but NOT approved — the
     * freeze blocks generation/release until a human re-runs the generator to
     * approve the current digests.
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
    /** Who/what approved this snapshot (work-package id, release, etc.). */
    approvedBy: z.string(),
    /** Optional human note (e.g. regeneration instructions). */
    note: z.string().optional(),
    /** Keyed by {@link AuthorityId}; presence of each required id is verified. */
    authorities: z.record(z.string(), AuthorityPinSchema),
  })
  .strict();
export type AuthorityLock = z.infer<typeof AuthorityLockSchema>;

// ─── Inputs → live authorities ──────────────────────────────────────────────

/**
 * The raw, already-collected inputs the pure compute layer needs. The impure
 * collector (`authority-collector.ts`) reads these from disk / the SDK / the
 * registry; tests supply them directly.
 */
export interface AuthorityInputs {
  /** Version at which the hand-written contract stand-in ships (package version). */
  readonly strategosContractsVersion: string;
  /** Source of the hand-written Strategos.Contracts stand-in schema module. */
  readonly strategosContractsSource: string;
  /** The MCP wire protocol version the projection targets. */
  readonly mcpProtocolVersion: string;
  /** The RAW `@modelcontextprotocol/sdk` dependency spec (for floating detection). */
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
  /** The P03-02 closed contract-surface version (`CONTRACT_SURFACE_VERSION`). */
  readonly contractSurfaceVersion: string;
  /** Canonical serialization of the P03-02 closed contract surface. */
  readonly contractSurfaceSource: string;
}

/**
 * Compute the six live authority values from raw inputs. Pure + deterministic:
 * same inputs → byte-identical digests on any machine.
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
        'src/architecture/invariant-schema.ts (hand-written Strategos.Contracts ' +
        'stand-in) pinned at the exarchos-mcp package version',
    },
    {
      id: 'mcp-protocol',
      kind: 'protocol',
      version: inputs.mcpProtocolVersion,
      versionSpec: inputs.mcpProtocolVersion,
      digest: null,
      source: '@modelcontextprotocol/sdk LATEST_PROTOCOL_VERSION',
    },
    {
      id: 'mcp-sdk',
      kind: 'package',
      version: inputs.mcpSdkVersionSpec,
      versionSpec: inputs.mcpSdkVersionSpec,
      digest: null,
      source: 'package.json dependencies["@modelcontextprotocol/sdk"]',
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

// ─── Verification (fail-closed) ─────────────────────────────────────────────

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
  /** `true` iff there are zero violations — generation/release may proceed. */
  readonly ok: boolean;
  readonly violations: AuthorityViolation[];
  /** Human-readable summary. */
  readonly report: string;
}

/**
 * Verify live authorities against an approved lock, failing CLOSED.
 *
 * Order of checks per authority: missing → floating → unapproved → mismatch.
 * All independent violations are collected (not short-circuited) so a single
 * run reports every problem the operator must fix.
 */
export function verifyAuthorities(
  live: readonly AuthorityValue[],
  lock: AuthorityLock,
): AuthorityVerdict {
  const violations: AuthorityViolation[] = [];

  // Whole-lock approval marker.
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

    // Floating: the LIVE spec is a range/dist-tag rather than an exact pin.
    if (value?.versionSpec != null && isFloatingVersionSpec(value.versionSpec)) {
      violations.push({
        authority: id,
        kind: 'floating',
        message:
          `authority '${id}' has a floating version spec '${value.versionSpec}' — ` +
          'pin an exact version before generation/release',
      });
    }
    // Floating: a range slipped into the lock itself.
    if (pin.version != null && isFloatingVersionSpec(pin.version)) {
      violations.push({
        authority: id,
        kind: 'floating',
        message: `lock pin for '${id}' records a floating version '${pin.version}'`,
      });
    }

    // Unapproved pin.
    if (pin.approved !== true) {
      violations.push({
        authority: id,
        kind: 'unapproved',
        message: `authority '${id}' pin is not approved (approved !== true)`,
      });
    }

    // Mismatch — only meaningful when we could measure the live value.
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
      if (value.version !== pin.version) {
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

// ─── Lock construction (generator/approval) ─────────────────────────────────

export interface BuildLockOptions {
  /** Who/what approves this snapshot (e.g. `'P03-01'`). */
  readonly approvedBy: string;
  /** Optional human note (regeneration instructions, etc.). */
  readonly note?: string;
  /**
   * When `false`, produce an UNAPPROVED lock (whole-lock + every pin
   * `approved: false`) — used to prove the freeze blocks unapproved snapshots.
   * Defaults to `true`.
   */
  readonly approved?: boolean;
}

/**
 * Build a lockfile object from live authorities. Running this (via the
 * generator CLI) is the APPROVAL gesture: the produced lock is `approved:true`
 * unless {@link BuildLockOptions.approved} is `false`.
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
