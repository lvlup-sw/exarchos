import { TextDecoder } from 'node:util';
import { z } from 'zod';
import {
  ContentAddressedStore,
  ContentAddressedStoreError,
} from '../../artifacts/content-addressed-store.js';
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
  EvidenceSubjectV1Schema,
  type EvidenceSubjectV1,
} from './types.js';

type ArtifactEvidenceSubjectV1 = Extract<
  EvidenceSubjectV1,
  { readonly kind: 'artifact' }
>;
type ArtifactEvidenceSubjectIdentityV1 = Omit<
  ArtifactEvidenceSubjectV1,
  'digest'
>;

const ArtifactEvidenceSubjectV1Schema = EvidenceSubjectV1Schema.refine(
  (subject): subject is ArtifactEvidenceSubjectV1 => subject.kind === 'artifact',
  'evidence artifact references require an artifact subject',
);

export const EvidenceArtifactReferenceV1Schema = z
  .object({
    contractVersion: z.literal(ADMISSION_RUNTIME_CONTRACT_VERSION),
    subject: ArtifactEvidenceSubjectV1Schema,
    mediaType: z.string().trim().min(1).max(255),
    byteLength: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export type EvidenceArtifactReferenceV1 = z.infer<
  typeof EvidenceArtifactReferenceV1Schema
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
 * Persist a canonical JSON report and return event-safe metadata only.
 *
 * The stored bytes are the Task 004 canonical subject envelope. Its SHA-256 is
 * therefore the subject digest itself; no second digest dialect is introduced.
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

/**
 * Resolve and verify an evidence report without policy, clock, LLM, or VCS I/O.
 */
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
