// ─── Signed, source-linked release manifest (P05-01) ──────────────────────
//
// The manifest is the single artifact an installer consumes to answer
// "is this the release I think it is, produced by whom I trust, from the
// source and contract I expect, and did the bytes I downloaded survive?"
//
// It enumerates every published asset with a RAW-byte digest, and embeds:
//   - `source`   — the build's git commit + source-tree digest (P05-01).
//   - `contract` — the frozen contract-authority identity (P03-01 roll-up).
//   - `install`  — the exact {@link InstallIdentity} record P05-04's freshness
//                  gate consumes, so the build-time and install-time identity
//                  formats are one and the same (no rival record).
//
// The whole manifest is signed with the P03-08 Ed25519 + canonical-JSON model
// (`signDetached` / `TrustRootSet.verify` over `canonicalBytes`). Signing
// establishes AUTHENTICITY (a trusted publisher produced it); the embedded
// source/contract/asset identities establish WHAT was built, which the
// installer checks against what it expects. Those are orthogonal — a valid
// signature over the wrong source is still rejected (see `installer-verify.ts`).
//
// ── Asset digests are RAW bytes, deliberately ────────────────────────────
// P03-01 / P05-04 digest *text* artifacts with line-ending normalization so
// Windows and Linux agree. A native binary is NOT text: normalizing CRLF-like
// byte pairs inside it would corrupt the digest and diverge from what an
// installer computes with `sha512sum` / `Get-FileHash`. So `digestAssetBytes`
// hashes the exact bytes with no normalization — that is the number the
// installer can reproduce over the file it downloaded.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalBytes, CanonicalJsonError, type CanonicalJsonValue } from '../extensions/canonical.js';
import {
  SIGNATURE_ALGORITHM,
  signDetached,
  type DetachedSignature,
} from '../extensions/trust-root.js';
import { DigestSchema, InstallIdentitySchema, type InstallIdentity } from '../install/install-identity.js';
import {
  SourceIdentitySchema,
  ContractIdentitySchema,
  type SourceIdentity,
  type ContractIdentity,
} from './build-identity.js';

/** The single manifest schema version. Bump on any breaking shape change. */
export const MANIFEST_VERSION = 1 as const;

// ─── Raw-byte asset digest ────────────────────────────────────────────────────

/**
 * Digest the EXACT bytes of a published asset, `sha256:<hex>`, with no
 * line-ending normalization. This is the digest an installer reproduces over
 * the file it downloaded, so it must be over raw bytes (unlike the normalized
 * text digests used for the contract / install-identity records).
 */
export function digestAssetBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

// ─── Manifest wire contract ───────────────────────────────────────────────────

/** One published release asset. `name` is the release filename an installer
 * downloads (e.g. `exarchos-linux-x64`, `exarchos-windows-x64.exe`). */
export const ReleaseAssetSchema = z
  .object({
    name: z.string().min(1),
    os: z.enum(['linux', 'darwin', 'windows']),
    arch: z.enum(['x64', 'arm64']),
    /** Size in bytes of the exact published file. */
    size: z.number().int().nonnegative(),
    /** Raw-byte `sha256:<hex>` digest of the exact published file. */
    digest: DigestSchema,
  })
  .strict();
export type ReleaseAsset = z.infer<typeof ReleaseAssetSchema>;

export const ReleaseManifestSchema = z
  .object({
    manifestVersion: z.literal(MANIFEST_VERSION),
    /** The release version string (root `package.json` version). */
    version: z.string().min(1),
    source: SourceIdentitySchema,
    contract: ContractIdentitySchema,
    /** The P05-04 install-identity record the freshness gate consumes. */
    install: InstallIdentitySchema,
    /** Every published asset. At least one — an empty manifest verifies nothing. */
    assets: z.array(ReleaseAssetSchema).min(1),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

/** A detached signature over the canonical manifest bytes. */
export const ManifestSignatureSchema = z
  .object({
    keyId: z.string().min(1),
    algorithm: z.literal(SIGNATURE_ALGORITHM),
    value: z.string().min(1),
  })
  .strict();

export const SignedReleaseManifestSchema = z
  .object({
    manifest: ReleaseManifestSchema,
    signature: ManifestSignatureSchema,
  })
  .strict();
export type SignedReleaseManifest = z.infer<typeof SignedReleaseManifestSchema>;

// ─── Canonicalization (what actually gets signed) ─────────────────────────────

/**
 * Recursively project a JSON-shaped value into a {@link CanonicalJsonValue}.
 * Rejects anything without a canonical JSON form (undefined members are
 * dropped; functions / symbols / non-finite numbers throw) so the signed bytes
 * are total and deterministic.
 */
function toCanonical(value: unknown): CanonicalJsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number cannot be canonicalized: ${String(value)}`);
      }
      return value;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`value of type ${typeof value} has no canonical JSON form`);
  }
  if (Array.isArray(value)) {
    return value.map((item) => toCanonical(item));
  }
  const out: Record<string, CanonicalJsonValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    out[key] = toCanonical(child);
  }
  return out;
}

/** The canonical JSON projection of a manifest — the exact value that is signed. */
export function manifestToCanonical(manifest: ReleaseManifest): CanonicalJsonValue {
  return toCanonical(manifest);
}

/**
 * The exact bytes a signature is computed/verified over: the canonical
 * (key-sorted) JSON of the manifest body. The signature is NOT part of these
 * bytes. Both signer and verifier derive them from the parsed manifest, so
 * transport formatting/whitespace is irrelevant.
 */
export function manifestSigningBytes(manifest: ReleaseManifest): Buffer {
  return canonicalBytes(manifestToCanonical(manifest));
}

// ─── Build-side assembly ──────────────────────────────────────────────────────

/** Inputs to assemble a full {@link ReleaseManifest} at build time. */
export interface BuildReleaseManifestInputs {
  readonly version: string;
  readonly source: SourceIdentity;
  readonly contract: ContractIdentity;
  readonly install: InstallIdentity;
  readonly assets: ReadonlyArray<ReleaseAsset>;
}

/**
 * Assemble + validate a {@link ReleaseManifest} from collected build inputs.
 * Pure and deterministic: identical inputs always yield an identical (Zod-
 * validated) manifest, so two independent builds from the same source produce
 * byte-identical `manifestSigningBytes`.
 */
export function buildReleaseManifest(inputs: BuildReleaseManifestInputs): ReleaseManifest {
  return ReleaseManifestSchema.parse({
    manifestVersion: MANIFEST_VERSION,
    version: inputs.version,
    source: inputs.source,
    contract: inputs.contract,
    install: inputs.install,
    assets: [...inputs.assets],
  });
}

/**
 * Build a {@link ReleaseAsset} from the exact bytes of a published file. The
 * digest is the raw-byte `sha256:` an installer reproduces over its download.
 */
export function releaseAssetFromBytes(
  name: string,
  os: ReleaseAsset['os'],
  arch: ReleaseAsset['arch'],
  bytes: Uint8Array,
): ReleaseAsset {
  return ReleaseAssetSchema.parse({
    name,
    os,
    arch,
    size: bytes.length,
    digest: digestAssetBytes(bytes),
  });
}

// ─── Sign / serialize / parse ─────────────────────────────────────────────────

/**
 * Sign a manifest with a publisher private key, producing a
 * {@link SignedReleaseManifest}. The manifest is validated first so a malformed
 * manifest can never be signed.
 */
export function signReleaseManifest(
  manifest: ReleaseManifest,
  keyId: string,
  privateKeyPem: string,
): SignedReleaseManifest {
  const validated = ReleaseManifestSchema.parse(manifest);
  const signature: DetachedSignature = {
    keyId,
    algorithm: SIGNATURE_ALGORITHM,
    value: signDetached(privateKeyPem, manifestSigningBytes(validated)),
  };
  return SignedReleaseManifestSchema.parse({ manifest: validated, signature });
}

/** Serialize a signed manifest to deterministic canonical JSON text. */
export function serializeSignedManifest(signed: SignedReleaseManifest): string {
  return canonicalBytes(toCanonical(signed)).toString('utf8');
}

/**
 * Parse + schema-validate a signed manifest from JSON text. Fails closed on any
 * malformed input (bad JSON, missing fields, wrong types) — a caller that gets
 * a value back can rely on its shape before signature verification.
 */
export function parseSignedManifest(text: string): SignedReleaseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`release manifest is not valid JSON: ${message}`);
  }
  return SignedReleaseManifestSchema.parse(raw);
}
