import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { publishTempFile } from '../utils/atomic-write.js';
import {
  ContentDigestV1Schema,
  type ContentDigestV1,
} from '../workflow/admission/types.js';

export type ContentAddressedStoreErrorCode =
  | 'CONTENT_NOT_FOUND'
  | 'UNSUPPORTED_DIGEST_ALGORITHM'
  | 'MALFORMED_DIGEST'
  | 'DIGEST_MISMATCH';

/** Explicit failures from the repository-local content-addressed artifact store. */
export class ContentAddressedStoreError extends Error {
  constructor(
    readonly code: ContentAddressedStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ContentAddressedStoreError';
  }
}

function parseDigest(input: unknown): ContentDigestV1 {
  if (
    input !== null &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.hasOwn(input, 'algorithm') &&
    (input as { algorithm?: unknown }).algorithm !== 'sha256'
  ) {
    throw new ContentAddressedStoreError(
      'UNSUPPORTED_DIGEST_ALGORITHM',
      `unsupported content digest algorithm: ${String((input as { algorithm?: unknown }).algorithm)}`,
    );
  }

  const parsed = ContentDigestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new ContentAddressedStoreError(
      'MALFORMED_DIGEST',
      'content digest must be sha256 with 64 lowercase hexadecimal characters',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function sha256(content: Uint8Array): ContentDigestV1 {
  return ContentDigestV1Schema.parse({
    algorithm: 'sha256',
    value: createHash('sha256').update(content).digest('hex'),
  });
}

function digestsMatch(left: ContentDigestV1, right: ContentDigestV1): boolean {
  return timingSafeEqual(
    Buffer.from(left.value, 'hex'),
    Buffer.from(right.value, 'hex'),
  );
}

/**
 * Filesystem-backed repository artifact store.
 *
 * Content is addressed at `<root>/sha256/<first-two-hex>/<remaining-hex>`.
 * Writes use the repository's atomic publish primitive; reads always hash the
 * persisted bytes before returning them.
 */
export class ContentAddressedStore {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = path.resolve(rootDirectory);
  }

  private pathFor(digest: ContentDigestV1): string {
    return path.join(
      this.rootDirectory,
      digest.algorithm,
      digest.value.slice(0, 2),
      digest.value.slice(2),
    );
  }

  async put(content: Uint8Array): Promise<ContentDigestV1> {
    const bytes = Buffer.from(content);
    const digest = sha256(bytes);
    const target = this.pathFor(digest);
    await fs.mkdir(path.dirname(target), { recursive: true });

    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await publishTempFile(temporary, target);
    return digest;
  }

  async resolve(digestInput: unknown): Promise<Buffer> {
    const digest = parseDigest(digestInput);
    const target = this.pathFor(digest);

    let content: Buffer;
    try {
      content = await fs.readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ContentAddressedStoreError(
          'CONTENT_NOT_FOUND',
          `content not found for ${digest.algorithm}:${digest.value}`,
          { cause: error },
        );
      }
      throw error;
    }

    const actual = sha256(content);
    if (!digestsMatch(digest, actual)) {
      throw new ContentAddressedStoreError(
        'DIGEST_MISMATCH',
        `persisted content digest mismatch for ${digest.algorithm}:${digest.value}`,
      );
    }
    return content;
  }
}
