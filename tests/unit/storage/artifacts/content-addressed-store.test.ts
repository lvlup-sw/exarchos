import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishTempFile } from '../../../../src/utils/atomic-write.js';
import {
  ContentAddressedStore,
  ContentAddressedStoreError,
  type ContentAddressedStoreIo,
} from '../../../../src/storage/artifacts/content-addressed-store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Lists every file under `root`, temp files included. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

/** Real filesystem IO, except that the rename inside `publish` always throws. */
function ioWithFailingPublish(): ContentAddressedStoreIo {
  return {
    mkdir: (directory, options) => mkdir(directory, options),
    writeFile: async (file, data) => {
      const handle = await open(file, 'wx');
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
    },
    readFile: (file) => readFile(file),
    publish: (temporary, target) =>
      publishTempFile(temporary, target, {
        rename: () => {
          throw Object.assign(new Error('injected publish failure'), {
            code: 'EINJECT',
          });
        },
        unlink: (file: string) => unlink(file),
      }),
    unlink: (file) => unlink(file),
  };
}

describe('ContentAddressedStore', () => {
  let root: string;
  let store: ContentAddressedStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'exarchos-cas-'));
    store = new ContentAddressedStore(root);
  });

  afterEach(async () => {
    await rmrfAsync(root);
  });

  it('ContentAddressedStore_RoundTrip_ReturnsExactBytes', async () => {
    const bytes = Buffer.from('gate-evidence-payload', 'utf8');
    const digest = await store.put(bytes);
    expect(digest).toEqual({ algorithm: 'sha256', value: sha256Hex(bytes) });
    await expect(store.resolve(digest)).resolves.toEqual(bytes);
  });

  it('ContentAddressedStore_WriteWithMatchingDeclaredDigest_Succeeds', async () => {
    const bytes = Buffer.from('declared-and-correct', 'utf8');
    const declared = { algorithm: 'sha256', value: sha256Hex(bytes) };
    const digest = await store.put(bytes, declared);
    expect(digest).toEqual(declared);
    await expect(store.resolve(declared)).resolves.toEqual(bytes);
  });

  /** The store must reject a wrong declared digest before it stages a file. */
  it('ContentAddressedStore_WriteWithWrongDeclaredDigest_IsRejectedAndWritesNothing', async () => {
    const bytes = Buffer.from('bytes-do-not-match-claim', 'utf8');
    const correct = sha256Hex(bytes);
    const wrong = `${correct[0] === '0' ? '1' : '0'}${correct.slice(1)}`;

    await expect(
      store.put(bytes, { algorithm: 'sha256', value: wrong }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'ContentAddressedStoreError',
        code: 'DIGEST_MISMATCH',
      }),
    );

    expect(await listFiles(root)).toEqual([]);
  });

  it('ContentAddressedStore_WriteWithUnsupportedDeclaredAlgorithm_IsRejected', async () => {
    const bytes = Buffer.from('sha512-not-supported', 'utf8');
    await expect(
      store.put(bytes, { algorithm: 'sha512', value: sha256Hex(bytes) }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_DIGEST_ALGORITHM' }),
    );
    expect(await listFiles(root)).toEqual([]);
  });

  it('ContentAddressedStore_ReadDetectsCorruption_WithoutReturningBytes', async () => {
    const bytes = Buffer.from('will-be-tampered', 'utf8');
    const digest = await store.put(bytes);
    const [blob] = await listFiles(root);
    await writeFile(blob!, Buffer.from('tampered'));

    await expect(store.resolve(digest)).rejects.toEqual(
      expect.objectContaining({ code: 'DIGEST_MISMATCH' }),
    );
  });

  it('ContentAddressedStore_MissingContent_IsRejectedExplicitly', async () => {
    const digest = { algorithm: 'sha256', value: sha256Hex(Buffer.from('absent')) };
    await expect(store.resolve(digest)).rejects.toEqual(
      expect.objectContaining({ code: 'CONTENT_NOT_FOUND' }),
    );
  });

  /** The spy on `readFile` proves that no hostile digest reaches the filesystem. */
  it('ContentAddressedStore_TraversalDigests_AreRejectedAndNeverTouchDisk', async () => {
    const readFileSpy = vi.fn(readFile);
    const guarded = new ContentAddressedStore(root, {
      mkdir: (directory, options) => mkdir(directory, options),
      writeFile: async () => {
        throw new Error('writeFile must not run for a hostile digest');
      },
      readFile: readFileSpy,
      publish: async () => {
        throw new Error('publish must not run for a hostile digest');
      },
      unlink: (file) => unlink(file),
    });

    const hostile: readonly unknown[] = [
      { algorithm: 'sha256', value: '../../etc/passwd' },
      { algorithm: 'sha256', value: '..' },
      { algorithm: 'sha256', value: 'a/../../b' },
      { algorithm: 'sha256', value: 'C:\\Windows\\System32' },
      { algorithm: 'sha256', value: '\\\\server\\share' },
      { algorithm: 'sha256', value: '../'.repeat(20) },
      { algorithm: 'sha256', value: 'x'.repeat(64) + '/../../escape' },
    ];

    for (const digest of hostile) {
      await expect(guarded.resolve(digest)).rejects.toBeInstanceOf(
        ContentAddressedStoreError,
      );
    }
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  /** After the failed publish, the target must not resolve and no temp file must stay. */
  it('ContentAddressedStore_PartialPublishFailure_LeavesNoReadableArtifact', async () => {
    const failing = new ContentAddressedStore(root, ioWithFailingPublish());
    const bytes = Buffer.from('never-fully-published', 'utf8');
    const digest = { algorithm: 'sha256', value: sha256Hex(bytes) } as const;

    await expect(failing.put(bytes)).rejects.toThrow('injected publish failure');

    await expect(store.resolve(digest)).rejects.toEqual(
      expect.objectContaining({ code: 'CONTENT_NOT_FOUND' }),
    );
    expect(await listFiles(root)).toEqual([]);
  });

  it('ContentAddressedStore_PartialPublishFailure_PreservesPriorCompleteArtifact', async () => {
    const bytes = Buffer.from('prior-complete-artifact', 'utf8');
    const digest = await store.put(bytes);
    const before = await listFiles(root);
    expect(before).toHaveLength(1);

    const failing = new ContentAddressedStore(root, ioWithFailingPublish());
    await expect(failing.put(bytes)).rejects.toThrow('injected publish failure');

    await expect(store.resolve(digest)).resolves.toEqual(bytes);
    expect(await listFiles(root)).toEqual(before);
  });

  /** Sixteen writers of the same bytes must leave one complete blob and no temp file. */
  it('ContentAddressedStore_ConcurrentWritesSameContent_ResolveToOneCanonicalArtifact', async () => {
    const bytes = Buffer.from('shared-content-many-writers', 'utf8');
    const expected = sha256Hex(bytes);

    const digests = await Promise.all(
      Array.from({ length: 16 }, () => store.put(Buffer.from(bytes))),
    );

    for (const digest of digests) {
      expect(digest).toEqual({ algorithm: 'sha256', value: expected });
    }
    const files = await listFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith('.tmp')).toBe(false);
    await expect(store.resolve(digests[0]!)).resolves.toEqual(bytes);
  });

  it('ContentAddressedStore_ConcurrentWritesDistinctContent_AllResolveIndependently', async () => {
    const payloads = Array.from({ length: 12 }, (_, i) =>
      Buffer.from(`distinct-artifact-${i}`, 'utf8'),
    );
    const digests = await Promise.all(payloads.map((p) => store.put(p)));

    await Promise.all(
      digests.map((digest, i) =>
        expect(store.resolve(digest)).resolves.toEqual(payloads[i]),
      ),
    );
    const files = await listFiles(root);
    expect(files).toHaveLength(payloads.length);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  /** The published bytes are at the digest path, and no `.tmp` sibling exists. */
  it('ContentAddressedStore_PublishedBlobReplacesTempAtomically', async () => {
    const bytes = Buffer.from('atomic-publish-target', 'utf8');
    const digest = await store.put(bytes);
    const files = await listFiles(root);
    expect(files).toHaveLength(1);
    const info = await stat(files[0]!);
    expect(info.isFile()).toBe(true);
    expect(path.basename(files[0]!)).toBe(digest.value.slice(2));
  });
});
