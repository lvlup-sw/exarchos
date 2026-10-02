import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { publishTempFile } from '../../utils/atomic-write.js';
import {
  ArtifactPathError,
  resolveContainedArtifactPath,
} from './artifact-path.js';
import {
  ContentDigestV1Schema,
  type ContentDigestV1,
} from '../../workflow/admission/types.js';

export type ContentAddressedStoreErrorCode =
  | 'CONTENT_NOT_FOUND'
  | 'UNSUPPORTED_DIGEST_ALGORITHM'
  | 'MALFORMED_DIGEST'
  | 'DIGEST_MISMATCH'
  | 'PATH_TRAVERSAL';

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

/**
 * Filesystem seam for the store. {@link resolveContainedArtifactPath} proves
 * every path contained before the store calls these functions, so an
 * implementation does not validate keys again. Tests inject it to force a failure
 * in the middle of a publish.
 */
export interface ContentAddressedStoreIo {
  mkdir(directory: string, options: { readonly recursive: true }): Promise<unknown>;
  writeFile(file: string, data: Buffer): Promise<void>;
  /**
   * A cancelled `signal` stops a pending read. The default passes it to
   * `fs.readFile`, which rejects with an `AbortError`.
   */
  readFile(file: string, signal?: AbortSignal): Promise<Buffer>;
  publish(temporary: string, target: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

/**
 * Default IO. The staged write does open, fsync, and close, so the bytes are
 * durable before the rename publishes them. Publish uses the atomic-publish
 * primitive of the repository.
 */
const DEFAULT_IO: ContentAddressedStoreIo = {
  mkdir: (directory, options) => fs.mkdir(directory, options),
  writeFile: async (file, data) => {
    const handle = await fs.open(file, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  readFile: (file, signal) => (signal === undefined ? fs.readFile(file) : fs.readFile(file, { signal })),
  publish: (temporary, target) => publishTempFile(temporary, target),
  unlink: (file) => fs.unlink(file),
};

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
 * Filesystem-backed repository artifact store at `<root>/sha256/<first-two-hex>/<remaining-hex>`.
 *
 * A write stages a temp file and publishes it with an atomic rename. A reader
 * sees the old or the new complete artifact, never a partial one. A read hashes
 * the persisted bytes before it returns them. The store proves every digest path
 * contained before any filesystem access.
 */
export class ContentAddressedStore {
  private readonly rootDirectory: string;
  private readonly io: ContentAddressedStoreIo;

  constructor(rootDirectory: string, io: ContentAddressedStoreIo = DEFAULT_IO) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.io = io;
  }

  private pathFor(digest: ContentDigestV1): string {
    try {
      return resolveContainedArtifactPath(this.rootDirectory, [
        digest.algorithm,
        digest.value.slice(0, 2),
        digest.value.slice(2),
      ]);
    } catch (error) {
      if (error instanceof ArtifactPathError) {
        throw new ContentAddressedStoreError('PATH_TRAVERSAL', error.message, {
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Persist `content` and return its digest. If the content does not hash to
   * `expectedDigest`, the store throws before it writes anything.
   *
   * If the write or the publish fails, the store tries to unlink the staged temp
   * file. A cleanup failure never hides the original error.
   */
  async put(
    content: Uint8Array,
    expectedDigest?: unknown,
  ): Promise<ContentDigestV1> {
    const bytes = Buffer.from(content);
    const digest = sha256(bytes);

    if (expectedDigest !== undefined) {
      const declared = parseDigest(expectedDigest);
      if (!digestsMatch(declared, digest)) {
        throw new ContentAddressedStoreError(
          'DIGEST_MISMATCH',
          `content does not match its declared digest ${declared.algorithm}:${declared.value}`,
        );
      }
    }

    const target = this.pathFor(digest);
    await this.io.mkdir(path.dirname(target), { recursive: true });

    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.io.writeFile(temporary, bytes);
      await this.io.publish(temporary, target);
    } catch (error) {
      try {
        await this.io.unlink(temporary);
      } catch {
      }
      throw error;
    }
    return digest;
  }

  async resolve(digestInput: unknown, signal?: AbortSignal): Promise<Buffer> {
    const digest = parseDigest(digestInput);
    const target = this.pathFor(digest);

    let content: Buffer;
    try {
      content = await this.io.readFile(target, signal);
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
