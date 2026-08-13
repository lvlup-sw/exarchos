// ─── Build-time source + contract identity (P05-01) ───────────────────────
//
// A release artifact must carry, in a form an installer can read back out,
// *what it was built from*:
//
//   - `source`   — the exact git commit plus a content digest of the source
//                  tree that produced the artifact. The commit pins provenance
//                  (anti-rollback / exact-revision), the tree digest catches a
//                  working tree that drifted from the recorded commit.
//   - `contract` — the frozen contract-authority identity from P03-01. Rather
//                  than recomputing a rival digest of the schema/registry/policy
//                  authorities, we roll up the digests P03-01 already pinned in
//                  its approved lockfile, using P03-01's own canonicalizing
//                  digest primitive (`digestParts`). Embedding is meant to be
//                  gated on `verifyContractAuthority().ok` so a floating,
//                  unapproved, or mismatched contract can never be stamped into
//                  a release.
//
// Both identities are DETERMINISTIC and line-ending / path-separator normalized
// (via the P05-04 `digestTree` and P03-01 `digestParts` primitives): the tree
// is authored on Windows (CRLF, `\`) but built/verified on Linux (LF, `/`), so
// a raw byte hash would diverge across platforms and every cross-platform
// release verification would false-fail.
//
// This module is PURE (no filesystem, no git, no clock): it takes already
// collected raw inputs — a commit string and path/content entries — and returns
// a validated record. A caller-side collector is responsible for shelling out
// to git and reading the tree.

import { z } from 'zod';
import { digestTree, DigestSchema, type DigestEntry } from '../install-identity.js';
import { digestParts } from '../../contract/authority-digest.js';
import { AUTHORITY_IDS, type AuthorityLock } from '../../contract/authority-pin.js';

// ─── Source identity ─────────────────────────────────────────────────────────

/** A full 40-hex git commit SHA. Releases are cut from tagged commits, so an
 * abbreviated or `uncommitted` marker is rejected — provenance must be exact. */
export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'expected a full 40-hex git commit SHA');

export const SourceIdentitySchema = z
  .object({
    /** The exact commit the artifact was built from. */
    commit: CommitShaSchema,
    /** Content-addressed digest of the built source tree (order-independent,
     * line-ending / path-separator normalized). */
    treeDigest: DigestSchema,
  })
  .strict();
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;

/** Raw materials for a source identity, before digesting. */
export interface RawSourceInputs {
  /** Full 40-hex commit SHA (e.g. `git rev-parse HEAD`). */
  readonly commit: string;
  /** Path/content entries for the source tree that produced the artifact. */
  readonly treeEntries: ReadonlyArray<DigestEntry>;
}

/**
 * Build a validated {@link SourceIdentity}. Pure + deterministic: identical
 * inputs (modulo line endings / path separators) always yield an identical
 * record on any platform. Throws (via Zod) if the commit is not a full SHA.
 */
export function buildSourceIdentity(raw: RawSourceInputs): SourceIdentity {
  return SourceIdentitySchema.parse({
    commit: raw.commit,
    treeDigest: digestTree(raw.treeEntries),
  });
}

// ─── Contract identity (rolled up from the P03-01 approved lock) ──────────────

export const ContractIdentitySchema = z
  .object({
    /** Roll-up digest over every frozen authority's pinned version + digest. */
    digest: DigestSchema,
    /** Who approved the underlying P03-01 lock (provenance, not trust). */
    approvedBy: z.string().min(1),
    /** Number of authorities folded into the digest (guards silent truncation). */
    authorityCount: z.number().int().positive(),
  })
  .strict();
export type ContractIdentity = z.infer<typeof ContractIdentitySchema>;

/**
 * Derive the contract identity from P03-01's approved authority lock.
 *
 * The digest is a deterministic roll-up of the authorities *in canonical order*
 * (`AUTHORITY_IDS`), each contributing `id|kind|version|versionSpec|digest`
 * with NUL separators so no two fields can collide. It reuses P03-01's
 * `digestParts` (which canonicalizes line endings) rather than a fresh hash
 * function, so this is an aggregation of the digests P03-01 already pinned — not
 * a rival contract digest. It is independent of lockfile whitespace/formatting:
 * only the pinned authority values matter.
 *
 * Fails closed: a lock missing any required authority throws, so a truncated
 * contract can never be embedded.
 */
export function contractIdentityFromLock(lock: AuthorityLock): ContractIdentity {
  const parts: string[] = [];
  for (const id of AUTHORITY_IDS) {
    const pin = lock.authorities[id];
    if (!pin) {
      throw new Error(`contract authority lock is missing required authority '${id}'`);
    }
    parts.push(
      [id, pin.kind, pin.version ?? '', pin.versionSpec ?? '', pin.digest ?? ''].join('\u0000'),
    );
  }
  return ContractIdentitySchema.parse({
    digest: digestParts(parts),
    approvedBy: lock.approvedBy,
    authorityCount: AUTHORITY_IDS.length,
  });
}
