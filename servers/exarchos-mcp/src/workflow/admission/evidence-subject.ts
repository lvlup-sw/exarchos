import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ADMISSION_RUNTIME_CONTRACT_VERSION,
  ArtifactIdSchema,
  CommitIdSchema,
  DiffIdSchema,
  EvidenceSubjectV1Schema,
  PhaseAttemptIdSchema,
  TaskIdSchema,
  WaveIdSchema,
  WorkflowIdSchema,
  type ContentDigestV1,
  type EvidenceSubjectV1,
} from './types.js';

export type EvidenceSubjectValidationCode =
  | 'MISSING_SUBJECT_COMPONENT'
  | 'MALFORMED_SUBJECT'
  | 'MISSING_DIGEST_COMPONENT'
  | 'UNSUPPORTED_DIGEST_ALGORITHM'
  | 'MALFORMED_DIGEST'
  | 'MALFORMED_CONTENT'
  | 'DIGEST_MISMATCH';

/** A fail-closed boundary error suitable for admission indeterminate mapping. */
export class EvidenceSubjectValidationError extends Error {
  constructor(
    readonly code: EvidenceSubjectValidationCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EvidenceSubjectValidationError';
  }
}

const EvidenceSubjectIdentityV1Schema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('workflow'), workflowId: WorkflowIdSchema })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('phase-attempt'),
      phaseAttemptId: PhaseAttemptIdSchema,
    })
    .strict()
    .readonly(),
  z.object({ kind: z.literal('wave'), waveId: WaveIdSchema }).strict().readonly(),
  z.object({ kind: z.literal('task'), taskId: TaskIdSchema }).strict().readonly(),
  z.object({ kind: z.literal('commit'), commitId: CommitIdSchema }).strict().readonly(),
  z.object({ kind: z.literal('diff'), diffId: DiffIdSchema }).strict().readonly(),
  z
    .object({ kind: z.literal('artifact'), artifactId: ArtifactIdSchema })
    .strict()
    .readonly(),
]);

export type EvidenceSubjectIdentityV1 = z.infer<
  typeof EvidenceSubjectIdentityV1Schema
>;

export type NormalizedEvidenceSubjectContent =
  | null
  | boolean
  | number
  | string
  | readonly NormalizedEvidenceSubjectContent[]
  | { readonly [key: string]: NormalizedEvidenceSubjectContent };

const ID_FIELD_BY_KIND = {
  workflow: 'workflowId',
  'phase-attempt': 'phaseAttemptId',
  wave: 'waveId',
  task: 'taskId',
  commit: 'commitId',
  diff: 'diffId',
  artifact: 'artifactId',
} as const;

function malformedContent(message: string): never {
  throw new EvidenceSubjectValidationError('MALFORMED_CONTENT', message);
}

/**
 * Normalize JSON evidence without consulting mutable runtime state.
 *
 * Object keys are NFC-normalized and sorted, strings are NFC/newline
 * normalized, and negative zero is represented as zero. Non-JSON values,
 * non-finite numbers, key collisions after normalization, and cycles fail
 * closed instead of inheriting JSON.stringify's lossy behavior.
 */
export function normalizeEvidenceSubjectContent(
  input: unknown,
): NormalizedEvidenceSubjectContent {
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, path: string): NormalizedEvidenceSubjectContent => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.replace(/\r\n?/gu, '\n').normalize('NFC');
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return malformedContent(`${path} must contain only finite numbers`);
      }
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') {
      return malformedContent(`${path} contains a non-JSON value`);
    }
    if (ancestors.has(value)) {
      return malformedContent(`${path} contains a cycle`);
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[index];
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value')
          ) {
            return malformedContent(`${path} must not contain sparse array entries`);
          }
        }
        const extraKeys = Reflect.ownKeys(value).filter(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)),
        );
        if (extraKeys.length > 0) {
          return malformedContent(`${path} contains non-JSON array properties`);
        }
        const normalized = Array.from(
          { length: value.length },
          (_, index) => visit(descriptors[index]!.value, `${path}[${index}]`),
        );
        return Object.freeze(normalized);
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return malformedContent(`${path} must be a plain JSON object`);
      }

      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== 'string')) {
        return malformedContent(`${path} contains non-JSON symbol keys`);
      }
      const entries = ownKeys.map((key) => {
        const descriptor = descriptors[key as string];
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          return malformedContent(`${path}.${String(key)} must be JSON data`);
        }
        return [(key as string).normalize('NFC'), descriptor.value] as const;
      });
      entries.sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );

      const normalized = Object.create(null) as Record<
        string,
        NormalizedEvidenceSubjectContent
      >;
      for (const [key, child] of entries) {
        if (Object.hasOwn(normalized, key)) {
          return malformedContent(
            `${path} contains duplicate keys after Unicode normalization`,
          );
        }
        normalized[key] = visit(child, `${path}.${key}`);
      }
      return Object.freeze(normalized);
    } finally {
      ancestors.delete(value);
    }
  };

  return visit(input, 'content');
}

function serializeCanonicalJson(value: NormalizedEvidenceSubjectContent): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(',')}]`;
  }

  return `{${Object.entries(value)
    .map(
      ([key, child]) =>
        `${JSON.stringify(key)}:${serializeCanonicalJson(child)}`,
    )
    .join(',')}}`;
}

function parseIdentity(input: unknown): EvidenceSubjectIdentityV1 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EvidenceSubjectValidationError(
      'MISSING_SUBJECT_COMPONENT',
      'evidence subject identity must be an object',
    );
  }

  const record = input as Record<string, unknown>;
  if (typeof record.kind !== 'string') {
    throw new EvidenceSubjectValidationError(
      'MISSING_SUBJECT_COMPONENT',
      'evidence subject kind is required',
    );
  }
  const idField =
    ID_FIELD_BY_KIND[record.kind as keyof typeof ID_FIELD_BY_KIND];
  if (idField !== undefined && record[idField] === undefined) {
    throw new EvidenceSubjectValidationError(
      'MISSING_SUBJECT_COMPONENT',
      `${idField} is required for ${record.kind} evidence subjects`,
    );
  }

  const parsed = EvidenceSubjectIdentityV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new EvidenceSubjectValidationError(
      'MALFORMED_SUBJECT',
      'evidence subject identity is malformed',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function identityComponents(identity: EvidenceSubjectIdentityV1): {
  field: string;
  value: string;
} {
  const field = ID_FIELD_BY_KIND[identity.kind];
  return {
    field,
    value: identity[field as keyof typeof identity] as string,
  };
}

/**
 * Canonical bytes for subject-bound content.
 *
 * Top-level ordering is fixed as contractVersion, kind, variant ID, content.
 * Nested JSON objects use lexicographically sorted normalized keys.
 */
export function canonicalizeEvidenceSubject(
  identityInput: unknown,
  contentInput: unknown,
): string {
  const identity = parseIdentity(identityInput);
  const { field, value } = identityComponents(identity);
  const content = normalizeEvidenceSubjectContent(contentInput);

  return (
    `{"contractVersion":${JSON.stringify(ADMISSION_RUNTIME_CONTRACT_VERSION)}` +
    `,"kind":${JSON.stringify(identity.kind)}` +
    `,${JSON.stringify(field)}:${JSON.stringify(value)}` +
    `,"content":${serializeCanonicalJson(content)}}`
  );
}

function validateAlgorithm(algorithm: unknown): 'sha256' {
  if (algorithm !== 'sha256') {
    throw new EvidenceSubjectValidationError(
      'UNSUPPORTED_DIGEST_ALGORITHM',
      `unsupported evidence digest algorithm: ${String(algorithm)}`,
    );
  }
  return algorithm;
}

export function computeEvidenceSubjectDigest(
  identity: unknown,
  content: unknown,
  algorithm: unknown = 'sha256',
): ContentDigestV1 {
  const supportedAlgorithm = validateAlgorithm(algorithm);
  const value = createHash(supportedAlgorithm)
    .update(canonicalizeEvidenceSubject(identity, content), 'utf8')
    .digest('hex');
  return Object.freeze({ algorithm: supportedAlgorithm, value });
}

/** Construct a schema-validated, frozen, content-addressed evidence subject. */
export function createEvidenceSubject(
  identityInput: unknown,
  content: unknown,
  algorithm: unknown = 'sha256',
): EvidenceSubjectV1 {
  const identity = parseIdentity(identityInput);
  const digest = computeEvidenceSubjectDigest(identity, content, algorithm);
  return EvidenceSubjectV1Schema.parse({ ...identity, digest });
}

function validateDigest(input: unknown): ContentDigestV1 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EvidenceSubjectValidationError(
      'MISSING_DIGEST_COMPONENT',
      'evidence subject digest is required',
    );
  }

  const digest = input as Record<string, unknown>;
  if (!Object.hasOwn(digest, 'algorithm') || !Object.hasOwn(digest, 'value')) {
    throw new EvidenceSubjectValidationError(
      'MISSING_DIGEST_COMPONENT',
      'evidence subject digest requires algorithm and value',
    );
  }
  validateAlgorithm(digest.algorithm);
  if (typeof digest.value !== 'string' || !/^[a-f0-9]{64}$/.test(digest.value)) {
    throw new EvidenceSubjectValidationError(
      'MALFORMED_DIGEST',
      'sha256 evidence digest must be 64 lowercase hexadecimal characters',
    );
  }
  if (
    Object.keys(digest).length !== 2 ||
    Reflect.ownKeys(digest).length !== 2
  ) {
    throw new EvidenceSubjectValidationError(
      'MALFORMED_DIGEST',
      'evidence subject digest contains unsupported fields',
    );
  }

  return digest as ContentDigestV1;
}

/**
 * Verify persisted subject metadata against supplied content using real SHA-256.
 * The validated frozen subject is returned for direct use by admission callers.
 */
export function verifyEvidenceSubject(
  subjectInput: unknown,
  content: unknown,
): EvidenceSubjectV1 {
  if (
    subjectInput === null ||
    typeof subjectInput !== 'object' ||
    Array.isArray(subjectInput)
  ) {
    throw new EvidenceSubjectValidationError(
      'MISSING_SUBJECT_COMPONENT',
      'evidence subject is required',
    );
  }

  const record = subjectInput as Record<string, unknown>;
  const digest = validateDigest(record.digest);
  const { digest: _digest, ...identityInput } = record;
  const identity = parseIdentity(identityInput);

  const parsed = EvidenceSubjectV1Schema.safeParse(subjectInput);
  if (!parsed.success) {
    throw new EvidenceSubjectValidationError(
      'MALFORMED_SUBJECT',
      'evidence subject is malformed',
      { cause: parsed.error },
    );
  }

  const expected = computeEvidenceSubjectDigest(
    identity,
    content,
    digest.algorithm,
  );
  const matches = timingSafeEqual(
    Buffer.from(digest.value, 'hex'),
    Buffer.from(expected.value, 'hex'),
  );
  if (!matches) {
    throw new EvidenceSubjectValidationError(
      'DIGEST_MISMATCH',
      `evidence subject digest mismatch for ${identity.kind}`,
    );
  }

  return parsed.data;
}
