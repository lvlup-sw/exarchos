// ─── Signed revocation list with freshness (P03-08) ───────────────────────
//
// Revocation is only safe if you can prove the revocation data is (a) authentic
// and (b) current. Both are fail-closed:
//   - AUTHENTIC: the list is signed by a trust root. A forged "fresh but empty"
//     list must not be able to suppress a real revocation, so an unsigned or
//     unverifiable list is treated as no usable revocation data at all.
//   - CURRENT (freshness): even a validly signed list is rejected if it is
//     missing, future-dated, past its own expiry, or older than the freshness
//     horizon. If you cannot prove the list is current you must fail closed —
//     never fail open by admitting because "no revocation said no".
//
// Timestamps are epoch milliseconds (injected clock) so freshness arithmetic is
// deterministic and timezone-free.

import { z } from 'zod';
import { canonicalBytes, type CanonicalJsonValue } from './canonical.js';
import {
  ExtensionIdSchema,
  ExtensionSignatureV1Schema,
  type ExtensionId,
} from './manifest.js';
import {
  signDetached,
  SIGNATURE_ALGORITHM,
  type DetachedSignature,
  type TrustRootSet,
} from './trust-root.js';

/** One revoked identity. Omitting `version` revokes every version. */
export const RevocationEntryV1Schema = z
  .object({
    extensionId: ExtensionIdSchema,
    version: z.number().int().nonnegative().optional(),
  })
  .strict()
  .readonly();
export type RevocationEntryV1 = z.infer<typeof RevocationEntryV1Schema>;

/** The signed portion of a revocation list. */
export const RevocationListBodyV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    /** When the list was issued, epoch milliseconds. */
    issuedAt: z.number().int().nonnegative(),
    /** When the list stops being valid, epoch milliseconds. */
    expiresAt: z.number().int().nonnegative(),
    revoked: z.array(RevocationEntryV1Schema).readonly(),
  })
  .strict()
  .readonly();
export type RevocationListBodyV1 = z.infer<typeof RevocationListBodyV1Schema>;

/** A complete signed revocation list. */
export const RevocationListV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    revoked: z.array(RevocationEntryV1Schema).readonly(),
    signature: ExtensionSignatureV1Schema,
  })
  .strict()
  .readonly();
export type RevocationListV1 = z.infer<typeof RevocationListV1Schema>;

/** Canonical signed-body bytes for a revocation-list body. */
export function canonicalRevocationBytes(body: RevocationListBodyV1): Buffer {
  return canonicalBytes(body as unknown as CanonicalJsonValue);
}

/** Canonical signed-body bytes derived from a full revocation list. */
export function canonicalRevocationListBytes(list: RevocationListV1): Buffer {
  const { signature, ...body } = list;
  void signature;
  return canonicalRevocationBytes(body as RevocationListBodyV1);
}

/** Build a signed revocation list from a body and signer key (publishers/tests). */
export function buildSignedRevocationList(
  body: RevocationListBodyV1,
  signer: { readonly keyId: string; readonly privateKeyPem: string },
): RevocationListV1 {
  const value = signDetached(signer.privateKeyPem, canonicalRevocationBytes(body));
  const signature: DetachedSignature = {
    keyId: signer.keyId,
    algorithm: SIGNATURE_ALGORITHM,
    value,
  };
  return RevocationListV1Schema.parse({ ...body, signature });
}

/**
 * Outcome of evaluating revocation for one extension identity.
 * - `clear`: usable, current, authentic list that does not list this identity.
 * - `revoked`: the identity is on a usable, current, authentic list.
 * - `unavailable`: no usable revocation data — missing, unverifiable, or stale;
 *    admission must fail closed on this, never fall through to admitting.
 */
export type RevocationEvaluation =
  | { readonly status: 'clear' }
  | { readonly status: 'revoked'; readonly detail: string }
  | { readonly status: 'unavailable'; readonly detail: string };

export interface RevocationContext {
  readonly list: RevocationListV1 | undefined;
  readonly trustRoots: TrustRootSet;
  readonly nowMillis: number;
  readonly freshnessHorizonMillis: number;
}

/**
 * Decide whether `extensionId`@`version` may be admitted with respect to the
 * revocation data in `context`. Authenticity and freshness are checked before
 * membership, so a stale or forged list can never mask a real revocation and,
 * equally, can never be trusted to clear one.
 */
export function evaluateRevocation(
  context: RevocationContext,
  extensionId: ExtensionId,
  version: number,
): RevocationEvaluation {
  const { list, trustRoots, nowMillis, freshnessHorizonMillis } = context;

  if (!list) {
    return { status: 'unavailable', detail: 'no revocation list available' };
  }

  const verification = trustRoots.verify(
    list.signature,
    canonicalRevocationListBytes(list),
  );
  if (!verification.trusted) {
    return {
      status: 'unavailable',
      detail: `revocation list signature not trusted: ${verification.detail}`,
    };
  }

  if (list.issuedAt > nowMillis) {
    return {
      status: 'unavailable',
      detail: `revocation list is future-dated (issuedAt ${list.issuedAt} > now ${nowMillis})`,
    };
  }
  if (nowMillis > list.expiresAt) {
    return {
      status: 'unavailable',
      detail: `revocation list expired at ${list.expiresAt} (now ${nowMillis})`,
    };
  }
  if (nowMillis - list.issuedAt > freshnessHorizonMillis) {
    return {
      status: 'unavailable',
      detail: `revocation list is stale: age ${nowMillis - list.issuedAt}ms exceeds horizon ${freshnessHorizonMillis}ms`,
    };
  }

  for (const entry of list.revoked) {
    if (entry.extensionId !== extensionId) continue;
    if (entry.version === undefined || entry.version === version) {
      return {
        status: 'revoked',
        detail:
          entry.version === undefined
            ? `extension ${extensionId} is revoked (all versions)`
            : `extension ${extensionId} version ${entry.version} is revoked`,
      };
    }
  }

  return { status: 'clear' };
}
