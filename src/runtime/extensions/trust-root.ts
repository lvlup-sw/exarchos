/**
 * Trust roots and detached signature checks. A trust root is a configured
 * public key. An extension manifest or a revocation list is admitted only when
 * its signature chains to a root. The root signs the leaf directly, so the
 * chain has a length of one.
 *
 * Signing uses Ed25519 through `node:crypto`, with a `null` digest algorithm,
 * as Node requires for EdDSA.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

/** The only accepted signature algorithm. */
export const SIGNATURE_ALGORITHM = 'ed25519' as const;
export type SignatureAlgorithm = typeof SIGNATURE_ALGORITHM;

/** A detached signature naming the trust root that produced it. */
export interface DetachedSignature {
  readonly keyId: string;
  readonly algorithm: SignatureAlgorithm;
  /** Base64-encoded raw signature bytes. */
  readonly value: string;
}

/** Configuration for one trust root: an id and its public key in PEM (SPKI). */
export interface TrustRootConfig {
  readonly keyId: string;
  readonly algorithm: SignatureAlgorithm;
  readonly publicKeyPem: string;
}

/** Result of chaining a signature to the configured trust roots. */
export type SignatureVerification =
  | { readonly trusted: true; readonly keyId: string }
  | { readonly trusted: false; readonly detail: string };

/**
 * An explicit, immutable set of trust roots from configuration. There is no
 * default root set, so no key is trusted implicitly. The constructor throws on
 * a duplicate key id, because a shadowed root is a trust-boundary bug.
 */
export class TrustRootSet {
  private readonly roots: ReadonlyMap<
    string,
    { readonly algorithm: SignatureAlgorithm; readonly key: KeyObject }
  >;

  constructor(configs: readonly TrustRootConfig[]) {
    const roots = new Map<
      string,
      { readonly algorithm: SignatureAlgorithm; readonly key: KeyObject }
    >();
    for (const config of configs) {
      if (roots.has(config.keyId)) {
        throw new Error(`duplicate trust root keyId: ${config.keyId}`);
      }
      roots.set(config.keyId, {
        algorithm: config.algorithm,
        key: createPublicKey(config.publicKeyPem),
      });
    }
    this.roots = roots;
  }

  get size(): number {
    return this.roots.size;
  }

  has(keyId: string): boolean {
    return this.roots.has(keyId);
  }

  /**
   * Check that `signature` over `signedBytes` chains to a configured root. An
   * unknown key id, an algorithm mismatch, a malformed signature, or bytes that
   * do not verify give `trusted: false`. A throw from `node:crypto` also gives
   * `trusted: false`, so an error cannot pass as success.
   */
  verify(signature: DetachedSignature, signedBytes: Buffer): SignatureVerification {
    const root = this.roots.get(signature.keyId);
    if (!root) {
      return {
        trusted: false,
        detail: `no configured trust root for keyId ${signature.keyId}`,
      };
    }
    if (root.algorithm !== signature.algorithm) {
      return {
        trusted: false,
        detail: `trust root ${signature.keyId} is ${root.algorithm}, signature claims ${signature.algorithm}`,
      };
    }

    let ok = false;
    try {
      const signatureBytes = Buffer.from(signature.value, 'base64');
      ok = cryptoVerify(null, signedBytes, root.key, signatureBytes);
    } catch {
      return {
        trusted: false,
        detail: `signature verification error for keyId ${signature.keyId}`,
      };
    }

    return ok
      ? { trusted: true, keyId: signature.keyId }
      : {
          trusted: false,
          detail: `signature does not chain to trust root ${signature.keyId}`,
        };
  }
}

/**
 * Make a detached Ed25519 signature over `signedBytes` with the private key of
 * a root. This is the signing side of {@link TrustRootSet.verify}.
 */
export function signDetached(privateKeyPem: string, signedBytes: Buffer): string {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, signedBytes, key).toString('base64');
}
