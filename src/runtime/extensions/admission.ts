/**
 * Extension admission: the fail-closed gate that each extension passes before
 * it runs. Each failure mode rejects before execution:
 * - `UNTRUSTED`: the signature does not chain to a configured trust root.
 * - `REVOKED`: a current, authentic revocation list holds the extension.
 * - `STALE_REVOCATION`: the revocation data is missing, forged or stale.
 * - `ROLLBACK`: the version is below the admitted high-water mark.
 * - `OVER_QUOTA`: a quota exceeds the budget, or the content exceeds a quota.
 * - `MUTATED`: the content does not match the manifest digest.
 * - `MALFORMED_MANIFEST` or `ISOLATION_VIOLATION`: a structural failure.
 * - `CONTENT_UNAVAILABLE`: the one-shot loader failed.
 *
 * The extension bytes load once, and the digest check runs on those bytes.
 * Execution gets the verified buffer, and no code reads the source again.
 */

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

/**
 * Module-private brand. The symbol is not exported, so only `admitExtension`
 * can produce an `AdmittedExtension`.
 */
const ADMITTED_BRAND: unique symbol = Symbol('exarchos.extension.admitted');

/**
 * A verified, admitted extension. It carries the manifest and the exact
 * in-memory bytes that admission hashed. Only these bytes can run.
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
 * Admit an extension, or reject it fail-closed. The checks run in this order:
 * schema, signature, isolation, declared quota, revocation, rollback, one
 * content load, digest, and content quota. No content loads before the
 * signature passes. The version ledger advances only after every check passes.
 * Callers must run `admitted.content` through {@link executeExtension}.
 */
export async function admitExtension(
  request: AdmissionRequest,
  context: AdmissionContext,
): Promise<AdmissionOutcome> {
  const parsed = parseManifest(request.manifest);
  if (!parsed.ok) {
    return reject('MALFORMED_MANIFEST', parsed.detail);
  }
  const manifest = parsed.manifest;

  const verification = context.trustRoots.verify(
    manifest.signature,
    canonicalManifestBytes(manifest),
  );
  if (!verification.trusted) {
    return reject('UNTRUSTED', verification.detail);
  }

  const isolation = evaluateIsolation(manifest.isolation, request.posture);
  if (!isolation.contained) {
    return reject('ISOLATION_VIOLATION', isolation.detail);
  }

  const declaredQuota = evaluateDeclaredQuota(manifest.quota, context.quotaBudget);
  if (!declaredQuota.withinBudget) {
    return reject('OVER_QUOTA', declaredQuota.detail);
  }

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

  const highest = await context.versionLedger.highestAdmitted(manifest.extensionId);
  if (highest !== undefined && manifest.version < highest) {
    return reject(
      'ROLLBACK',
      `version ${manifest.version} is below admitted high-water mark ${highest} for ${manifest.extensionId}`,
    );
  }

  let content: Buffer;
  try {
    content = await request.loadContentOnce();
  } catch (error) {
    return reject(
      'CONTENT_UNAVAILABLE',
      `failed to load extension content: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!verifyContentDigest(content, manifest.contentDigest)) {
    return reject(
      'MUTATED',
      `content does not match manifest digest ${manifest.contentDigest.algorithm}:${manifest.contentDigest.value}`,
    );
  }

  const contentQuota = evaluateContentQuota(
    manifest.quota,
    context.quotaBudget,
    content.length,
  );
  if (!contentQuota.withinBudget) {
    return reject('OVER_QUOTA', contentQuota.detail);
  }

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
