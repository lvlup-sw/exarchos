// ─── Trust roots + detached signature verification (P03-08) ───────────────
//
// A trust root is a configured public key that anchors trust. An extension
// manifest (and a revocation list) is admitted only if its signature chains to
// one of these roots. This is a direct-anchor chain: a root signs the leaf
// (manifest/revocation) itself — a chain of length one, the same model a single
// self-issued CA uses when it signs leaves directly. The set is explicit and
// injected, so a test constructs its own roots and no ambient/implicit key is
// ever trusted.
//
// Ed25519 is used via `node:crypto` (`sign`/`verify` with a `null` digest
// algorithm, which is how Node signs with EdDSA). No crypto is hand-rolled.

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

/** The one signature algorithm P03-08 accepts. */
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
 * An explicit, immutable set of trust roots. Constructed from configuration so
 * tests inject their own anchors; there is no default/global root set, so trust
 * is never ambient. Duplicate key ids are rejected at construction — a silently
 * shadowed root is a trust-boundary bug.
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
   * Verify `signature` over `signedBytes` chains to a configured root. Fails
   * closed for every failure shape — unknown key id, algorithm mismatch,
   * malformed signature, or bytes that do not verify — never throwing to the
   * caller, so a verification error can never be mistaken for a pass.
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
      // A malformed key/signature makes `verify` throw; treat as untrusted.
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
 * Produce a detached Ed25519 signature over `signedBytes` with the private key
 * matching a configured root. Used by legitimate publishers (and tests) — the
 * signing side of {@link TrustRootSet.verify}.
 */
export function signDetached(privateKeyPem: string, signedBytes: Buffer): string {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, signedBytes, key).toString('base64');
}
