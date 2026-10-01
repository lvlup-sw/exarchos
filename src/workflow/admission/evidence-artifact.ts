import { TextDecoder } from 'node:util';
import { join } from 'node:path';
import {
  ContentAddressedStore,
  ContentAddressedStoreError,
  type ContentAddressedStoreIo,
} from '../../storage/artifacts/content-addressed-store.js';
import { EVIDENCE_ARTIFACT_DIRNAME } from '../../utils/paths.js';
import {
  canonicalizeEvidenceSubject,
  createEvidenceSubject,
  EvidenceSubjectValidationError,
  normalizeEvidenceSubjectContent,
  verifyEvidenceSubject,
  type NormalizedEvidenceSubjectContent,
} from './evidence-subject.js';
import {
  ADMISSION_RUNTIME_CONTRACT_VERSION,
  EvidenceArtifactReferenceV1Schema,
  type EvidenceArtifactReferenceV1,
  type EvidenceSubjectV1,
} from './types.js';

export {
  EvidenceArtifactReferenceV1Schema,
  type EvidenceArtifactReferenceV1,
} from './types.js';

type ArtifactEvidenceSubjectV1 = Extract<
  EvidenceSubjectV1,
  { readonly kind: 'artifact' }
>;
type ArtifactEvidenceSubjectIdentityV1 = Omit<
  ArtifactEvidenceSubjectV1,
  'digest'
>;

export type EvidenceArtifactErrorCode =
  | 'CONTENT_NOT_FOUND'
  | 'UNSUPPORTED_DIGEST_ALGORITHM'
  | 'MALFORMED_REFERENCE'
  | 'PATH_TRAVERSAL'
  | 'DIGEST_MISMATCH';

/** Fail-closed artifact boundary error suitable for admission diagnostics. */
export class EvidenceArtifactResolutionError extends Error {
  constructor(
    readonly code: EvidenceArtifactErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EvidenceArtifactResolutionError';
  }
}

export interface EvidenceArtifactMetadata {
  readonly mediaType: string;
}

function malformedReference(message: string, cause?: unknown): never {
  throw new EvidenceArtifactResolutionError(
    'MALFORMED_REFERENCE',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function parseReference(input: unknown): EvidenceArtifactReferenceV1 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return malformedReference('evidence artifact reference must be an object');
  }

  const subject = (input as { subject?: unknown }).subject;
  if (subject !== null && typeof subject === 'object' && !Array.isArray(subject)) {
    const digest = (subject as { digest?: unknown }).digest;
    if (digest !== null && typeof digest === 'object' && !Array.isArray(digest)) {
      const algorithm = (digest as { algorithm?: unknown }).algorithm;
      if (algorithm !== undefined && algorithm !== 'sha256') {
        throw new EvidenceArtifactResolutionError(
          'UNSUPPORTED_DIGEST_ALGORITHM',
          `unsupported evidence artifact digest algorithm: ${String(algorithm)}`,
        );
      }
    }
  }

  const parsed = EvidenceArtifactReferenceV1Schema.safeParse(input);
  if (!parsed.success) {
    return malformedReference('evidence artifact reference is malformed', parsed.error);
  }
  return parsed.data;
}

function mapStoreError(error: unknown): never {
  if (!(error instanceof ContentAddressedStoreError)) throw error;
  const code =
    error.code === 'MALFORMED_DIGEST' ? 'MALFORMED_REFERENCE' : error.code;
  throw new EvidenceArtifactResolutionError(code, error.message, {
    cause: error,
  });
}

/**
 * Stores a report as its canonical subject envelope and returns only a reference that is safe for an event.
 * The SHA-256 of the stored bytes is the subject digest, so the store adds no second digest.
 */
export async function storeEvidenceArtifact(
  store: ContentAddressedStore,
  identityInput: ArtifactEvidenceSubjectIdentityV1,
  content: unknown,
  metadata: EvidenceArtifactMetadata,
): Promise<EvidenceArtifactReferenceV1> {
  if (identityInput.kind !== 'artifact') {
    return malformedReference('evidence artifact identity must have kind artifact');
  }

  const subject = createEvidenceSubject(identityInput, content);
  const canonical = canonicalizeEvidenceSubject(identityInput, content);
  const bytes = Buffer.from(canonical, 'utf8');
  const storedDigest = await store.put(bytes);
  if (
    storedDigest.algorithm !== subject.digest.algorithm ||
    storedDigest.value !== subject.digest.value
  ) {
    throw new EvidenceArtifactResolutionError(
      'DIGEST_MISMATCH',
      'artifact store returned a digest different from the canonical evidence subject',
    );
  }

  const parsed = EvidenceArtifactReferenceV1Schema.safeParse({
    contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
    subject,
    mediaType: metadata.mediaType,
    byteLength: bytes.byteLength,
  });
  if (!parsed.success) {
    return malformedReference('evidence artifact metadata is malformed', parsed.error);
  }
  return parsed.data;
}

/** Resolves and verifies an evidence report. It reads no policy, clock, LLM, or VCS. */
export async function resolveEvidenceArtifact(
  store: ContentAddressedStore,
  referenceInput: unknown,
): Promise<NormalizedEvidenceSubjectContent> {
  const reference = parseReference(referenceInput);

  let bytes: Buffer;
  try {
    bytes = await store.resolve(reference.subject.digest);
  } catch (error) {
    return mapStoreError(error);
  }

  if (bytes.byteLength !== reference.byteLength) {
    throw new EvidenceArtifactResolutionError(
      'DIGEST_MISMATCH',
      'evidence artifact byte length does not match its reference',
    );
  }

  let persisted: unknown;
  let canonical: string;
  try {
    canonical = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    persisted = JSON.parse(canonical);
  } catch (error) {
    throw new EvidenceArtifactResolutionError(
      'DIGEST_MISMATCH',
      'evidence artifact content is not a canonical JSON subject',
      { cause: error },
    );
  }

  if (
    persisted === null ||
    typeof persisted !== 'object' ||
    Array.isArray(persisted) ||
    !Object.hasOwn(persisted, 'content')
  ) {
    throw new EvidenceArtifactResolutionError(
      'DIGEST_MISMATCH',
      'evidence artifact content is missing its canonical subject envelope',
    );
  }

  const content = (persisted as { content: unknown }).content;
  try {
    verifyEvidenceSubject(reference.subject, content);
    const { digest: _digest, ...identity } = reference.subject;
    if (canonicalizeEvidenceSubject(identity, content) !== canonical) {
      throw new EvidenceArtifactResolutionError(
        'DIGEST_MISMATCH',
        'evidence artifact content is not canonically encoded',
      );
    }
  } catch (error) {
    if (error instanceof EvidenceArtifactResolutionError) throw error;
    if (
      error instanceof EvidenceSubjectValidationError &&
      error.code === 'DIGEST_MISMATCH'
    ) {
      throw new EvidenceArtifactResolutionError(
        'DIGEST_MISMATCH',
        error.message,
        { cause: error },
      );
    }
    throw new EvidenceArtifactResolutionError(
      'MALFORMED_REFERENCE',
      'evidence artifact subject is malformed',
      { cause: error },
    );
  }

  return normalizeEvidenceSubjectContent(content);
}

/**
 * Binds an artifact store to the evidence root of a state directory. Production code must use only this constructor.
 * A reference names a digest and no root. If a producer and a reader use different roots, a stored blob looks absent.
 */
export function evidenceArtifactStore(
  stateDir: string,
  io?: ContentAddressedStoreIo,
): ContentAddressedStore {
  const root = join(stateDir, EVIDENCE_ARTIFACT_DIRNAME);
  return io === undefined ? new ContentAddressedStore(root) : new ContentAddressedStore(root, io);
}

/** A blob source for the durable-evidence check. `resolve` throws when the reference does not resolve. */
export interface EvidenceArtifactResolver {
  resolve(reference: unknown): Promise<void>;
}

/** The production resolver for a state directory. */
export function evidenceArtifactResolver(stateDir: string): EvidenceArtifactResolver {
  const store = evidenceArtifactStore(stateDir);
  return {
    async resolve(reference: unknown): Promise<void> {
      await resolveEvidenceArtifact(store, reference);
    },
  };
}
