// ─── Extension admission — the fail-closed gate before execution (P03-08) ──
//
// Admission is the single choke point every extension passes before it can run.
// It composes the six independent, independently-seedable failure modes the
// P03-08 exit proof enumerates — each one fails CLOSED, before execution:
//
//   1. UNTRUSTED         signature does not chain to a configured trust root
//   2. REVOKED           extension is on a current, authentic revocation list
//   3. STALE_REVOCATION  revocation data is missing/forged/expired/stale
//   4. ROLLBACK          version is below the admitted high-water mark
//   5. OVER_QUOTA        declared quota exceeds budget, or content exceeds quota
//   6. MUTATED           content does not match the manifest's immutable digest
//
// plus MALFORMED_MANIFEST and ISOLATION_VIOLATION (structural fail-closed
// reasons) and CONTENT_UNAVAILABLE (the one-shot loader failed).
//
// TOCTOU RESISTANCE. The extension bytes are loaded EXACTLY ONCE, via the
// caller's `loadContentOnce`. The digest is verified on those exact in-memory
// bytes and the admitted result carries *those* bytes. Nothing here re-opens
// the source by path after verification, so a file mutated between check and
// use cannot be executed: execution runs the verified buffer or nothing.
// `executeExtension` takes only an already-admitted extension and its buffer,
// so there is structurally no path to re-read from.

import type { AgentPosture } from '../agents/spec.js';
import {
  canonicalManifestBytes,
  parseManifest,
  verifyContentDigest,
  type ExtensionManifestV1,
} from './manifest.js';
import { evaluateIsolation } from './isolation.js';
import {
  evaluateContentQuota,
  evaluateDeclaredQuota,
  type ExtensionQuota,
} from './quota.js';
import {
  evaluateRevocation,
  type RevocationListV1,
} from './revocation.js';
import type { TrustRootSet } from './trust-root.js';
import type { VersionLedger } from './version-ledger.js';

/** Every fail-closed reason admission can return. */
export type ExtensionAdmissionCode =
  | 'MALFORMED_MANIFEST'
  | 'UNTRUSTED'
  | 'ISOLATION_VIOLATION'
  | 'OVER_QUOTA'
  | 'REVOKED'
  | 'STALE_REVOCATION'
  | 'ROLLBACK'
  | 'CONTENT_UNAVAILABLE'
  | 'MUTATED';

/** A structured admission rejection. */
export interface AdmissionRejection {
  readonly code: ExtensionAdmissionCode;
  readonly detail: string;
}

// Module-private brand. An `AdmittedExtension` can only be produced by
// `admitExtension` in this module — the symbol is not exported, so external
// code cannot name the property to forge one. That is what makes "admitted"
// unforgeable rather than merely a naming convention.
const ADMITTED_BRAND: unique symbol = Symbol('exarchos.extension.admitted');

/**
 * A verified, admitted extension. Carries the manifest and the EXACT verified
 * in-memory bytes admission hashed — the only bytes that may be executed.
 */
export interface AdmittedExtension {
  readonly [ADMITTED_BRAND]: true;
  readonly manifest: ExtensionManifestV1;
  readonly content: Buffer;
}

/** Discriminated admission outcome. Execution is reachable only via `ok`. */
export type AdmissionOutcome =
  | { readonly ok: true; readonly admitted: AdmittedExtension }
  | { readonly ok: false; readonly rejection: AdmissionRejection };

/** The untrusted inputs describing one admission attempt. */
export interface AdmissionRequest {
  /** Untrusted manifest object (schema-validated inside admission). */
  readonly manifest: unknown;
  /** One-shot loader for the extension bytes. Invoked at most once. */
  readonly loadContentOnce: () => Promise<Buffer>;
  /** Host trust tier the extension will run under. */
  readonly posture: AgentPosture;
  /** Injected clock, epoch milliseconds. */
  readonly nowMillis: number;
}

/** The trusted host configuration admission decides against. */
export interface AdmissionContext {
  readonly trustRoots: TrustRootSet;
  readonly revocationList: RevocationListV1 | undefined;
  readonly quotaBudget: ExtensionQuota;
  readonly freshnessHorizonMillis: number;
  readonly versionLedger: VersionLedger;
}

function reject(
  code: ExtensionAdmissionCode,
  detail: string,
): { readonly ok: false; readonly rejection: AdmissionRejection } {
  return { ok: false, rejection: { code, detail } };
}

/**
 * Admit an extension, or reject it fail-closed. On success the returned
 * `admitted.content` is the verified in-memory buffer; callers MUST execute
 * that buffer (via {@link executeExtension}) and never re-read the source.
 */
export async function admitExtension(
  request: AdmissionRequest,
  context: AdmissionContext,
): Promise<AdmissionOutcome> {
  // 1. Manifest must schema-validate.
  const parsed = parseManifest(request.manifest);
  if (!parsed.ok) {
    return reject('MALFORMED_MANIFEST', parsed.detail);
  }
  const manifest = parsed.manifest;

  // 2. Signature must chain to a configured trust root. Do this before any
  //    content is touched — an untrusted manifest's bytes are never loaded.
  const verification = context.trustRoots.verify(
    manifest.signature,
    canonicalManifestBytes(manifest),
  );
  if (!verification.trusted) {
    return reject('UNTRUSTED', verification.detail);
  }

  // 3. Declared isolation must stay inside the host posture's trust boundary.
  const isolation = evaluateIsolation(manifest.isolation, request.posture);
  if (!isolation.contained) {
    return reject('ISOLATION_VIOLATION', isolation.detail);
  }

  // 4. Declared quotas must fit the host budget (checked before load).
  const declaredQuota = evaluateDeclaredQuota(manifest.quota, context.quotaBudget);
  if (!declaredQuota.withinBudget) {
    return reject('OVER_QUOTA', declaredQuota.detail);
  }

  // 5. Revocation must be authentic AND current (freshness). Missing/stale/
  //    forged data fails closed; a listed identity is revoked.
  const revocation = evaluateRevocation(
    {
      list: context.revocationList,
      trustRoots: context.trustRoots,
      nowMillis: request.nowMillis,
      freshnessHorizonMillis: context.freshnessHorizonMillis,
    },
    manifest.extensionId,
    manifest.version,
  );
  if (revocation.status === 'revoked') {
    return reject('REVOKED', revocation.detail);
  }
  if (revocation.status === 'unavailable') {
    return reject('STALE_REVOCATION', revocation.detail);
  }

  // 6. Anti-rollback: reject a version below the admitted high-water mark.
  const highest = await context.versionLedger.highestAdmitted(manifest.extensionId);
  if (highest !== undefined && manifest.version < highest) {
    return reject(
      'ROLLBACK',
      `version ${manifest.version} is below admitted high-water mark ${highest} for ${manifest.extensionId}`,
    );
  }

  // 7. Load the content EXACTLY ONCE. Everything after verifies and executes
  //    these bytes; the source is never re-opened by path.
  let content: Buffer;
  try {
    content = await request.loadContentOnce();
  } catch (error) {
    return reject(
      'CONTENT_UNAVAILABLE',
      `failed to load extension content: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 8. The loaded bytes must match the manifest's immutable digest. This is the
  //    TOCTOU-critical check: it runs on the in-memory bytes, not the path.
  if (!verifyContentDigest(content, manifest.contentDigest)) {
    return reject(
      'MUTATED',
      `content does not match manifest digest ${manifest.contentDigest.algorithm}:${manifest.contentDigest.value}`,
    );
  }

  // 9. Actual content size must fit the declared quota and the host budget.
  const contentQuota = evaluateContentQuota(
    manifest.quota,
    context.quotaBudget,
    content.length,
  );
  if (!contentQuota.withinBudget) {
    return reject('OVER_QUOTA', contentQuota.detail);
  }

  // 10. Only now, with everything proven, raise the anti-rollback high-water
  //     mark. A rejected extension never advances the ledger.
  await context.versionLedger.recordAdmitted(manifest.extensionId, manifest.version);

  const admitted: AdmittedExtension = {
    [ADMITTED_BRAND]: true,
    manifest,
    content,
  };
  return { ok: true, admitted };
}

/**
 * Execute an admitted extension against the VERIFIED bytes. There is no path
 * parameter — `run` receives the exact buffer admission hashed, so a source
 * file mutated after admission can never influence what executes.
 */
export async function executeExtension<T>(
  admitted: AdmittedExtension,
  run: (content: Buffer) => T | Promise<T>,
): Promise<T> {
  return run(admitted.content);
}
