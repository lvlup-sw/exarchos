/**
 * Build-time source and contract identity of a release artifact.
 * The source identity is the exact git commit plus a digest of the source tree. The tree digest catches a tree that drifted from the commit.
 * The contract identity rolls up the digests in the approved contract-authority lock with `digestParts`. It is not a second contract digest.
 *
 * Both digests normalize line endings and path separators, so a Windows tree and a Linux build give the same value.
 * This module is pure. A caller collects the commit and the tree entries.
 */

import { z } from 'zod';
import { digestTree, DigestSchema, type DigestEntry } from '../install-identity.js';
import { digestParts } from '../../contract/authority-digest.js';
import { AUTHORITY_IDS, type AuthorityLock } from '../../contract/authority-pin.js';

/** A full 40-hex git commit SHA. The schema rejects an abbreviated SHA or an `uncommitted` marker, so provenance is exact. */
export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'expected a full 40-hex git commit SHA');

export const SourceIdentitySchema = z
  .object({
    /** The exact commit the artifact was built from. */
    commit: CommitShaSchema,
    /** Digest of the source tree. Entry order, line endings, and path separators do not change it. */
    treeDigest: DigestSchema,
  })
  .strict();
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;

/** Raw materials for a source identity, before digesting. */
export interface RawSourceInputs {
  /** Full 40-hex commit SHA, for example from `git rev-parse HEAD`. */
  readonly commit: string;
  /** Path/content entries for the source tree that produced the artifact. */
  readonly treeEntries: ReadonlyArray<DigestEntry>;
}

/** Build a validated {@link SourceIdentity}. Zod throws when the commit is not a full SHA. */
export function buildSourceIdentity(raw: RawSourceInputs): SourceIdentity {
  return SourceIdentitySchema.parse({
    commit: raw.commit,
    treeDigest: digestTree(raw.treeEntries),
  });
}

export const ContractIdentitySchema = z
  .object({
    /** Roll-up digest over every frozen authority's pinned version + digest. */
    digest: DigestSchema,
    /** The approver of the authority lock. It records provenance, not trust. */
    approvedBy: z.string().min(1),
    /** The number of authorities in the digest. It makes a truncation visible. */
    authorityCount: z.number().int().positive(),
  })
  .strict();
export type ContractIdentity = z.infer<typeof ContractIdentitySchema>;

/**
 * Derive the contract identity from the authority lock.
 * Each authority in `AUTHORITY_IDS` order adds `id`, `kind`, `version`, `versionSpec`, and `digest`, with NUL separators.
 * Only the pinned values count, so lockfile formatting does not change the digest.
 * A lock with a missing authority throws, so a truncated contract cannot go into a release.
 * This function does not check that the lock is approved. The caller must refuse an unapproved lock.
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
