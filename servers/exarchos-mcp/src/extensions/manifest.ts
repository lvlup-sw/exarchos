// ─── Signed extension manifest (P03-08) ───────────────────────────────────
//
// The manifest is the extension's admission contract. Its signed body carries
// an immutable content digest, a monotonic version counter (anti-rollback),
// declared quotas, and a declared isolation policy. A detached signature over
// the canonical body binds all of it to a trust root.
//
// The content digest reuses the repository's `ContentDigestV1` schema (the same
// sha256 shape the content-addressed artifact store validates) rather than
// redefining a parallel digest format. The digest comparison mirrors the
// store's timing-safe approach; it is not re-derived here because the store's
// verifier is private and lives behind a file-ownership boundary this package
// must not edit.

import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ContentDigestV1Schema,
  type ContentDigestV1,
} from '../workflow/admission/types.js';
import { canonicalBytes, type CanonicalJsonValue } from './canonical.js';
import { ExtensionQuotaSchema } from './quota.js';
import { IsolationPolicySchema } from './isolation.js';
import {
  SIGNATURE_ALGORITHM,
  signDetached,
  type DetachedSignature,
} from './trust-root.js';

// Opaque, provider-neutral ids: non-empty, bounded, no path-like or
// whitespace-sensitive shapes. Same shape family as the admission stable-id
// vocabulary so extension identities read consistently across the codebase.
const StableTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'ids may contain only letters, digits, dot, underscore, colon, and hyphen',
  );

export const ExtensionIdSchema = StableTokenSchema.brand<'ExtensionId'>();
export type ExtensionId = z.infer<typeof ExtensionIdSchema>;

export const TrustKeyIdSchema = StableTokenSchema.brand<'TrustKeyId'>();
export type TrustKeyId = z.infer<typeof TrustKeyIdSchema>;

/** Detached signature carried by a manifest or revocation list. */
export const ExtensionSignatureV1Schema = z
  .object({
    keyId: TrustKeyIdSchema,
    algorithm: z.literal(SIGNATURE_ALGORITHM),
    value: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'signature must be base64'),
  })
  .strict()
  .readonly();
export type ExtensionSignatureV1 = z.infer<typeof ExtensionSignatureV1Schema>;

/**
 * The signed portion of a manifest — everything the signature covers. Kept as a
 * standalone schema so the canonical bytes are derived identically whether we
 * are signing a fresh body or re-deriving them to verify a parsed manifest.
 */
export const ExtensionManifestBodyV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    extensionId: ExtensionIdSchema,
    /** Monotonic version counter. Anti-rollback compares these numerically. */
    version: z.number().int().nonnegative(),
    /** Immutable content digest the loaded bytes must match. */
    contentDigest: ContentDigestV1Schema,
    quota: ExtensionQuotaSchema,
    isolation: IsolationPolicySchema,
  })
  .strict()
  .readonly();
export type ExtensionManifestBodyV1 = z.infer<typeof ExtensionManifestBodyV1Schema>;

/** A complete signed manifest: the signed body plus its detached signature. */
export const ExtensionManifestV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    extensionId: ExtensionIdSchema,
    version: z.number().int().nonnegative(),
    contentDigest: ContentDigestV1Schema,
    quota: ExtensionQuotaSchema,
    isolation: IsolationPolicySchema,
    signature: ExtensionSignatureV1Schema,
  })
  .strict()
  .readonly();
export type ExtensionManifestV1 = z.infer<typeof ExtensionManifestV1Schema>;

/** Outcome of parsing an untrusted manifest object. */
export type ManifestParse =
  | { readonly ok: true; readonly manifest: ExtensionManifestV1 }
  | { readonly ok: false; readonly detail: string };

/** Schema-validate an untrusted manifest object. Never throws. */
export function parseManifest(input: unknown): ManifestParse {
  const parsed = ExtensionManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, detail: parsed.error.message };
  }
  return { ok: true, manifest: parsed.data };
}

/** Canonical signed-body bytes for a manifest body. */
export function canonicalBodyBytes(body: ExtensionManifestBodyV1): Buffer {
  // The body is a strict, JSON-safe object (validated by zod); the canonicalizer
  // only reads it, so the cast to the canonical-value shape is sound.
  return canonicalBytes(body as unknown as CanonicalJsonValue);
}

/** Canonical signed-body bytes derived from a full manifest (signature stripped). */
export function canonicalManifestBytes(manifest: ExtensionManifestV1): Buffer {
  const { signature, ...body } = manifest;
  void signature;
  return canonicalBodyBytes(body as ExtensionManifestBodyV1);
}

/**
 * Build a signed manifest from a body and a signer's private key. The signing
 * counterpart to verification: it canonicalizes the body, signs those exact
 * bytes, and re-validates the assembled manifest so a malformed body is caught
 * at authoring time.
 */
export function buildSignedManifest(
  body: ExtensionManifestBodyV1,
  signer: { readonly keyId: string; readonly privateKeyPem: string },
): ExtensionManifestV1 {
  const value = signDetached(signer.privateKeyPem, canonicalBodyBytes(body));
  const signature: DetachedSignature = {
    keyId: signer.keyId,
    algorithm: SIGNATURE_ALGORITHM,
    value,
  };
  return ExtensionManifestV1Schema.parse({ ...body, signature });
}

/**
 * Timing-safe check that `bytes` hash to `digest`. Mirrors the content-
 * addressed store's comparison (raw-buffer `timingSafeEqual`, length-guarded so
 * it never throws on a size mismatch). V1 digests are always sha256.
 */
export function verifyContentDigest(bytes: Buffer, digest: ContentDigestV1): boolean {
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(digest.value, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
