// ─── Extension trust: signed manifests, admission, isolation (P03-08) ──────
//
// Public surface for the extension trust boundary. Source coverage: API-009.
// Admission fails closed for untrusted, revoked, stale-revocation, rollback,
// over-quota, or mutated extensions — before any execution — and loads content
// exactly once to resist TOCTOU. See `admission.ts` for the composed gate.

export {
  canonicalBytes,
  canonicalJson,
  CanonicalJsonError,
  type CanonicalJsonValue,
} from './canonical.js';

export {
  SIGNATURE_ALGORITHM,
  TrustRootSet,
  signDetached,
  type DetachedSignature,
  type SignatureAlgorithm,
  type SignatureVerification,
  type TrustRootConfig,
} from './trust-root.js';

export {
  ExtensionIdSchema,
  ExtensionManifestBodyV1Schema,
  ExtensionManifestV1Schema,
  ExtensionSignatureV1Schema,
  TrustKeyIdSchema,
  buildSignedManifest,
  canonicalBodyBytes,
  canonicalManifestBytes,
  parseManifest,
  verifyContentDigest,
  type ExtensionId,
  type ExtensionManifestBodyV1,
  type ExtensionManifestV1,
  type ExtensionSignatureV1,
  type ManifestParse,
  type TrustKeyId,
} from './manifest.js';

export {
  ExtensionQuotaSchema,
  evaluateContentQuota,
  evaluateDeclaredQuota,
  type ExtensionQuota,
  type QuotaEvaluation,
} from './quota.js';

export {
  IsolationPolicySchema,
  evaluateIsolation,
  type IsolationEvaluation,
  type IsolationPolicy,
} from './isolation.js';

export {
  RevocationEntryV1Schema,
  RevocationListBodyV1Schema,
  RevocationListV1Schema,
  buildSignedRevocationList,
  canonicalRevocationBytes,
  canonicalRevocationListBytes,
  evaluateRevocation,
  type RevocationContext,
  type RevocationEntryV1,
  type RevocationEvaluation,
  type RevocationListBodyV1,
  type RevocationListV1,
} from './revocation.js';

export {
  FileVersionLedger,
  InMemoryVersionLedger,
  type VersionLedger,
} from './version-ledger.js';

export {
  admitExtension,
  executeExtension,
  type AdmissionContext,
  type AdmissionOutcome,
  type AdmissionRejection,
  type AdmissionRequest,
  type AdmittedExtension,
  type ExtensionAdmissionCode,
} from './admission.js';
