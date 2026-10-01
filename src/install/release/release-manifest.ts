/**
 * Signed, source-linked release manifest. An installer reads it to verify a download.
 * It lists each published asset with a raw-byte digest. It also holds the source identity, the contract identity, and the {@link InstallIdentity} record of the freshness gate.
 *
 * An Ed25519 signature over the canonical JSON proves who published the manifest.
 * The embedded identities show what the build used. `installer-verify.ts` checks both, so a valid signature over the wrong source fails.
 *
 * Asset digests hash raw bytes with no line-ending normalization.
 * A native binary is not text, and an installer hashes the downloaded file as it is.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalBytes, CanonicalJsonError, type CanonicalJsonValue } from '../../runtime/extensions/canonical.js';
import {
  SIGNATURE_ALGORITHM,
  signDetached,
  type DetachedSignature,
} from '../../runtime/extensions/trust-root.js';
import { DigestSchema, InstallIdentitySchema, type InstallIdentity } from '../install-identity.js';
import {
  SourceIdentitySchema,
  ContractIdentitySchema,
  type SourceIdentity,
  type ContractIdentity,
} from './build-identity.js';

/** The single manifest schema version. Bump on any breaking shape change. */
export const MANIFEST_VERSION = 1 as const;

/**
 * Digest the exact bytes of a published asset as `sha256:<hex>`, with no line-ending normalization.
 * An installer computes the same digest over the file it downloaded.
 */
export function digestAssetBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** One published release asset. `name` is the release filename, for example `exarchos-linux-x64` or `exarchos-windows-x64.exe`. */
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
    /** The install-identity record that the freshness gate reads. */
    install: InstallIdentitySchema,
    /** Every published asset. The schema requires at least one, because an empty manifest verifies nothing. */
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

/**
 * Recursively project a JSON-shaped value into a {@link CanonicalJsonValue}.
 * It drops undefined members. A function, a symbol, or a non-finite number throws, so the signed bytes are deterministic.
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

/** The canonical JSON projection of a manifest, which is the signed value. */
export function manifestToCanonical(manifest: ReleaseManifest): CanonicalJsonValue {
  return toCanonical(manifest);
}

/**
 * The signed bytes: the key-sorted canonical JSON of the manifest body, without the signature.
 * The signer and the verifier derive them from the parsed manifest, so transport whitespace does not matter.
 */
export function manifestSigningBytes(manifest: ReleaseManifest): Buffer {
  return canonicalBytes(manifestToCanonical(manifest));
}

/** Inputs to assemble a full {@link ReleaseManifest} at build time. */
export interface BuildReleaseManifestInputs {
  readonly version: string;
  readonly source: SourceIdentity;
  readonly contract: ContractIdentity;
  readonly install: InstallIdentity;
  readonly assets: ReadonlyArray<ReleaseAsset>;
}

/**
 * Assemble and validate a {@link ReleaseManifest} from the build inputs.
 * The function is pure, so two builds from the same inputs give the same `manifestSigningBytes`.
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

/** Build a {@link ReleaseAsset} from the exact bytes of a published file, with a raw-byte `sha256:` digest. */
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

/** Sign a manifest with a publisher private key. The function validates the manifest first, so a malformed manifest is never signed. */
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
 * Parse and schema-validate a signed manifest from JSON text. Malformed input throws.
 * A returned value has a valid shape, but its signature is not verified yet.
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
