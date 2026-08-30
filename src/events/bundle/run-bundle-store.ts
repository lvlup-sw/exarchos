/**
 * The run-bundle store: content-addressed custody for bytes a ledger event
 * references by digest.
 *
 * This is composition over the repository's content-addressed artifact store,
 * not a second implementation of one. That store already owns the properties
 * this layer depends on — containment of every digest-derived path, a staged
 * write that is fsynced before an atomic rename publishes it, and a read that
 * re-hashes the persisted bytes before returning them. What this layer adds is
 * a named root under the state directory, a non-throwing resolvability probe
 * for the integrity oracle, and the write-ordering primitive below.
 */

import path from 'node:path';
import {
  ContentAddressedStore,
  ContentAddressedStoreError,
  type ContentAddressedStoreIo,
} from '../../storage/artifacts/content-addressed-store.js';
import { RUN_BUNDLE_DIRNAME } from '../../utils/paths.js';
import type { ArtifactId, ContentDigestV1 } from '../../workflow/admission/types.js';
import type { BundleRefV1 } from './digest-references.js';

/**
 * Verdict of a resolvability probe. Distinguishing `missing` from `mismatch`
 * matters to the oracle: absent bytes and corrupted bytes are different
 * failures with different repairs, and collapsing them would report a
 * truncated blob as a deletion.
 */
export type BundleResolution = 'ok' | 'missing' | 'mismatch';

export class RunBundleStore {
  private readonly blobs: ContentAddressedStore;
  private readonly rootDirectory: string;

  constructor(root: string, io?: ContentAddressedStoreIo) {
    this.rootDirectory = path.resolve(root);
    this.blobs =
      io === undefined
        ? new ContentAddressedStore(this.rootDirectory)
        : new ContentAddressedStore(this.rootDirectory, io);
  }

  /**
   * Bind a store to the run-bundle root of a state directory. This is the only
   * construction production code should use, so bundle bytes and the event
   * ledger that names them cannot end up under different roots.
   */
  static forStateDir(stateDir: string, io?: ContentAddressedStoreIo): RunBundleStore {
    return new RunBundleStore(path.join(stateDir, RUN_BUNDLE_DIRNAME), io);
  }

  /** Absolute root the blobs live under. Path only — no filesystem handle. */
  get root(): string {
    return this.rootDirectory;
  }

  /**
   * Persist bytes and return their digest. When `expected` is supplied the
   * write is rejected before anything reaches disk if the bytes do not hash
   * to it.
   */
  async put(bytes: Uint8Array, expected?: ContentDigestV1): Promise<ContentDigestV1> {
    return expected === undefined
      ? this.blobs.put(bytes)
      : this.blobs.put(bytes, expected);
  }

  /**
   * Read the bytes behind a digest, re-hashing them first. Throws
   * `ContentAddressedStoreError` for an absent or corrupted blob — callers
   * that want a verdict instead of an exception use {@link has}.
   */
  async resolve(digest: ContentDigestV1): Promise<Buffer> {
    return this.blobs.resolve(digest);
  }

  /**
   * Non-throwing resolvability probe — the integrity oracle's only read path.
   *
   * Only the two explicit content failures are converted to a verdict.
   * Anything else (a permissions error, a malformed digest that somehow
   * escaped schema parsing) propagates, because reporting an unreadable
   * directory as a missing blob would let an environment fault masquerade as
   * a custody violation.
   */
  async has(digest: ContentDigestV1): Promise<BundleResolution> {
    try {
      await this.blobs.resolve(digest);
      return 'ok';
    } catch (error) {
      if (error instanceof ContentAddressedStoreError) {
        if (error.code === 'CONTENT_NOT_FOUND') return 'missing';
        if (error.code === 'DIGEST_MISMATCH') return 'mismatch';
      }
      throw error;
    }
  }

  /**
   * Write ordering for bundle custody: the bytes are made durable BEFORE any
   * ledger reference to them is committed.
   *
   * `put` returns only after the staged file has been fsynced and atomically
   * renamed into place, so by the time `commit` runs the digest it is handed
   * is already resolvable. A crash between the two therefore leaves an orphan
   * blob that nothing references — collectable, and harmless to read — and can
   * never leave a committed reference pointing at bytes that were never
   * written. Orphans are tolerated by design and are not integrity violations;
   * the reverse order has no such benign failure.
   */
  async putThenReference<T>(
    artifactId: ArtifactId,
    bytes: Uint8Array,
    commit: (ref: BundleRefV1) => Promise<T>,
  ): Promise<T> {
    const digest = await this.put(bytes);
    return commit({ artifactId, digest });
  }
}
