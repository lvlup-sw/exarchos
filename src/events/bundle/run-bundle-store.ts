/**
 * The run-bundle store: content-addressed custody for bytes that a ledger event
 * references by digest.
 *
 * It wraps the content-addressed artifact store, which owns path containment,
 * durable atomic writes, and re-hashed reads. This layer adds a root under the
 * state directory, a non-throwing probe for the integrity oracle, and write ordering.
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
 * Verdict of a resolvability probe. Absent bytes (`missing`) and corrupted bytes
 * (`mismatch`) are different failures with different repairs.
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
   * Bind a store to the run-bundle root of a state directory. Production code
   * must use only this constructor, so bundle bytes and their ledger share one root.
   */
  static forStateDir(stateDir: string, io?: ContentAddressedStoreIo): RunBundleStore {
    return new RunBundleStore(path.join(stateDir, RUN_BUNDLE_DIRNAME), io);
  }

  /** Absolute root the blobs live under. Path only — no filesystem handle. */
  get root(): string {
    return this.rootDirectory;
  }

  /**
   * Persist bytes and return their digest. If the bytes do not hash to
   * `expected`, the write fails before anything reaches disk.
   */
  async put(bytes: Uint8Array, expected?: ContentDigestV1): Promise<ContentDigestV1> {
    return expected === undefined
      ? this.blobs.put(bytes)
      : this.blobs.put(bytes, expected);
  }

  /**
   * Read the bytes behind a digest, re-hashing them first. Throws
   * `ContentAddressedStoreError` for an absent or corrupted blob. Use {@link has}
   * for a verdict instead of an exception.
   */
  async resolve(digest: ContentDigestV1, signal?: AbortSignal): Promise<Buffer> {
    return this.blobs.resolve(digest, signal);
  }

  /**
   * Non-throwing resolvability probe, and the only read path of the integrity oracle.
   *
   * Only the two content failures become a verdict. Any other error propagates,
   * so an environment fault does not look like a custody violation. A cancelled
   * `signal` rejects a pending probe with an `AbortError`.
   */
  async has(digest: ContentDigestV1, signal?: AbortSignal): Promise<BundleResolution> {
    try {
      await this.blobs.resolve(digest, signal);
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
   * Make the bytes durable before `commit` writes any ledger reference to them.
   *
   * `put` returns after the fsync and the atomic rename, so the digest is
   * resolvable when `commit` runs. A crash between the two leaves an orphan blob.
   * An orphan is harmless and is not an integrity violation.
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
