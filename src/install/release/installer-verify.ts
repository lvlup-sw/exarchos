/**
 * The fail-closed check that an installer runs before it trusts a downloaded
 * release. It rejects four faults, in this order:
 *
 *   1. manifest-signature: the signature does not chain to a trust root.
 *   2. source-mismatch: the signed manifest names another commit or tree
 *      digest. A valid signature over the wrong source is still rejected.
 *   3. contract-mismatch: the manifest names another contract authority digest.
 *   4. asset-digest: a downloaded file is absent from the manifest or has
 *      another digest. An empty set of downloaded assets is also rejected.
 *
 * A manifest with one fault is rejected for that reason.
 */

import type { TrustRootSet } from '../../runtime/extensions/trust-root.js';
import type { SourceIdentity, ContractIdentity } from './build-identity.js';
import {
  manifestSigningBytes,
  type ReleaseAsset,
  type SignedReleaseManifest,
} from './release-manifest.js';

/** The four rejection reasons. */
export type RejectionReason =
  | 'manifest-signature'
  | 'source-mismatch'
  | 'contract-mismatch'
  | 'asset-digest';

/** A digest the installer computed over a file it actually downloaded. */
export interface ObservedAsset {
  /** Raw-byte `sha256:<hex>` of the downloaded file (see `digestAssetBytes`). */
  readonly digest: string;
}

export interface VerifyReleaseInputs {
  /** The signed manifest, already parsed/validated (`parseSignedManifest`). */
  readonly signed: SignedReleaseManifest;
  /** Trust anchors that the signature must chain to. */
  readonly trustRoots: TrustRootSet;
  /** The source identity the installer expects (pinned provenance). */
  readonly expectedSource: SourceIdentity;
  /** The contract authority identity that the installer expects. */
  readonly expectedContract: ContractIdentity;
  /**
   * Digests of the downloaded files, keyed by asset name. Each entry must be in
   * the signed manifest with the same digest. The map must not be empty.
   */
  readonly observedAssets: ReadonlyMap<string, ObservedAsset>;
}

/** Result of a release verification — discriminated on `ok`. */
export type VerifyReleaseResult =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly reason: RejectionReason; readonly detail: string };

function reject(reason: RejectionReason, detail: string): VerifyReleaseResult {
  return { ok: false, reason, detail };
}

function sourceMatches(a: SourceIdentity, b: SourceIdentity): boolean {
  return a.commit === b.commit && a.treeDigest === b.treeDigest;
}

function findAsset(assets: readonly ReleaseAsset[], name: string): ReleaseAsset | undefined {
  return assets.find((asset) => asset.name === name);
}

/**
 * Verify a downloaded release against what the installer expects. Fail-closed
 * on every dimension, in a fixed priority order (signature → source → contract
 * → assets) so a single seeded fault is reported as exactly that fault.
 */
export function verifyReleaseInstall(inputs: VerifyReleaseInputs): VerifyReleaseResult {
  const { signed, trustRoots, expectedSource, expectedContract, observedAssets } = inputs;
  const { manifest, signature } = signed;

  const verification = trustRoots.verify(signature, manifestSigningBytes(manifest));
  if (!verification.trusted) {
    return reject('manifest-signature', verification.detail);
  }

  if (!sourceMatches(manifest.source, expectedSource)) {
    return reject(
      'source-mismatch',
      `source identity mismatch: manifest ${manifest.source.commit}#${manifest.source.treeDigest} ` +
        `!= expected ${expectedSource.commit}#${expectedSource.treeDigest}`,
    );
  }

  if (manifest.contract.digest !== expectedContract.digest) {
    return reject(
      'contract-mismatch',
      `contract identity mismatch: manifest ${manifest.contract.digest} ` +
        `!= expected ${expectedContract.digest}`,
    );
  }

  if (observedAssets.size === 0) {
    return reject('asset-digest', 'no downloaded assets were presented for verification');
  }
  for (const [name, observed] of observedAssets) {
    const asset = findAsset(manifest.assets, name);
    if (!asset) {
      return reject('asset-digest', `downloaded asset '${name}' is not in the signed manifest`);
    }
    if (asset.digest !== observed.digest) {
      return reject(
        'asset-digest',
        `asset '${name}' digest mismatch: manifest ${asset.digest} != downloaded ${observed.digest}`,
      );
    }
  }

  return { ok: true, keyId: verification.keyId };
}
