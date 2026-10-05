/**
 * Signed extension manifest, the admission contract of an extension.
 * The signed body holds a content digest, a monotonic version counter for anti-rollback, quotas, and an isolation policy.
 * A detached signature over the canonical body binds them to a trust root.
 * The digest uses the `ContentDigestV1` schema of the content-addressed store.
 * This module copies the timing-safe comparison of the store, because the verifier of the store is private.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ContentDigestV1Schema,
  type ContentDigestV1,
} from '../../workflow/admission/types.js';
import { canonicalBytes, type CanonicalJsonValue } from './canonical.js';
import { ExtensionQuotaSchema } from './quota.js';
import { IsolationPolicySchema } from './isolation.js';
import {
  SIGNATURE_ALGORITHM,
  signDetached,
  type DetachedSignature,
} from './trust-root.js';

/** Opaque, bounded id with no path or whitespace characters. It has the same pattern as the admission stable ids. */
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
 * The signed portion of a manifest, which the signature covers.
 * It is a separate schema, so signing and verification derive the same canonical bytes.
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

/**
 * Canonical signed-body bytes for a manifest body.
 * The cast is sound, because zod validates the body as a strict JSON-safe object and the canonicalizer only reads it.
 */
export function canonicalBodyBytes(body: ExtensionManifestBodyV1): Buffer {
  return canonicalBytes(body as unknown as CanonicalJsonValue);
}

/** Canonical signed-body bytes derived from a full manifest (signature stripped). */
export function canonicalManifestBytes(manifest: ExtensionManifestV1): Buffer {
  const { signature, ...body } = manifest;
  void signature;
  return canonicalBodyBytes(body as ExtensionManifestBodyV1);
}

/**
 * Build a signed manifest from a body and the private key of a signer.
 * It signs the canonical bytes of the body, then validates the result, so a malformed body fails at authoring time.
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
 * Timing-safe check that `bytes` hash to `digest`. V1 digests are always sha256.
 * A length guard comes before `timingSafeEqual`, so a size mismatch returns false and does not throw.
 */
export function verifyContentDigest(bytes: Buffer, digest: ContentDigestV1): boolean {
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(digest.value, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
