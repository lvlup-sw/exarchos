// ─── Installer-side release verification (P05-01) ──────────────────────────
//
// The fail-closed gate an installer runs before trusting a downloaded release.
// It rejects, independently and each fail-closed, four distinct attacks/faults:
//
//   1. manifest-signature — the signed manifest does not chain to a configured
//                           trust root (tampered body, wrong/unknown key, or a
//                           malformed signature). Checked FIRST: nothing in a
//                           manifest can be trusted until its signature is.
//   2. source-mismatch    — a validly-signed manifest describes a different
//                           source (commit / tree digest) than the installer
//                           expects. A valid signature over the WRONG source is
//                           still rejected: signature ≠ provenance.
//   3. contract-mismatch  — a validly-signed manifest was built against a
//                           different frozen contract authority (P03-01) than
//                           the installer expects.
//   4. asset-digest       — a file the installer actually downloaded does not
//                           match (or is absent from) the signed manifest's
//                           record for it.
//
// Each dimension is independently seedable: a manifest with exactly one fault
// is rejected for exactly that reason, in the priority order above. Everything
// is fail-closed — no throw escapes to be mistaken for a pass, and an empty set
// of presented assets is a rejection (there is nothing to have verified).
//
// The `expectedSource` / `expectedContract` are what the installer pins (e.g.
// baked into the bootstrap or the currently-installed binary). Verifying them
// against a signed manifest mirrors P05-04's freshness philosophy: an
// authenticated statement of identity is compared to an independently expected
// identity, and any divergence blocks.

import type { TrustRootSet } from '../../runtime/extensions/trust-root.js';
import type { SourceIdentity, ContractIdentity } from './build-identity.js';
import {
  manifestSigningBytes,
  type ReleaseAsset,
  type SignedReleaseManifest,
} from './release-manifest.js';

/** The four independently-seedable rejection reasons, plus malformed input. */
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
  /** Trust anchors the signature must chain to (P03-08). */
  readonly trustRoots: TrustRootSet;
  /** The source identity the installer expects (pinned provenance). */
  readonly expectedSource: SourceIdentity;
  /** The contract-authority identity the installer expects (P03-01 roll-up). */
  readonly expectedContract: ContractIdentity;
  /**
   * Digests of the files the installer actually downloaded, keyed by asset
   * name. Every entry must be covered by, and match, the signed manifest.
   * Must be non-empty — an installer that verified nothing has not verified.
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

  // 1. Authenticity FIRST — a manifest's own claims mean nothing unsigned.
  const verification = trustRoots.verify(signature, manifestSigningBytes(manifest));
  if (!verification.trusted) {
    return reject('manifest-signature', verification.detail);
  }

  // 2. Source provenance — reject a validly-signed manifest for the wrong source.
  if (!sourceMatches(manifest.source, expectedSource)) {
    return reject(
      'source-mismatch',
      `source identity mismatch: manifest ${manifest.source.commit}#${manifest.source.treeDigest} ` +
        `!= expected ${expectedSource.commit}#${expectedSource.treeDigest}`,
    );
  }

  // 3. Contract authority — reject a build against a different frozen contract.
  if (manifest.contract.digest !== expectedContract.digest) {
    return reject(
      'contract-mismatch',
      `contract identity mismatch: manifest ${manifest.contract.digest} ` +
        `!= expected ${expectedContract.digest}`,
    );
  }

  // 4. Asset integrity — every downloaded file must be covered by and match the
  //    signed manifest. An empty presentation verifies nothing → reject.
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
