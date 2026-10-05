/**
 * Tests for `RunBundleStore`: content-addressed custody for run-bundle bytes, and the write ordering.
 * With that ordering, a crash between the byte write and the reference commit leaves an orphan blob.
 * The crash never leaves a digest with no bytes.
 *
 * The cases use a real temp directory, so each case sets its own timeout.
 * The tier default fits in-memory work.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { RunBundleStore } from '../../../../src/events/bundle/run-bundle-store.js';
import type { BundleRefV1 } from '../../../../src/events/bundle/digest-references.js';
import { ArtifactIdSchema } from '../../../../src/workflow/admission/types.js';
import type { ContentDigestV1 } from '../../../../src/workflow/admission/types.js';
import { RUN_BUNDLE_DIRNAME } from '../../../../src/utils/paths.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const FS_TIMEOUT_MS = 15_000;

let tempDir: string;
let store: RunBundleStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'run-bundle-store-test-'));
  store = RunBundleStore.forStateDir(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

function blobPath(root: string, digest: ContentDigestV1): string {
  return path.join(root, digest.algorithm, digest.value.slice(0, 2), digest.value.slice(2));
}

describe('RunBundleStore', () => {
  /** The root comes from the state directory, because the ledger and the bytes must share one root. */
  it(
    'RunBundleStore_PutThenResolve_RoundTripsBytes',
    async () => {
      const bytes = Buffer.from('run bundle payload', 'utf8');

      const digest = await store.put(bytes);

      expect(digest.algorithm).toBe('sha256');
      expect(digest.value).toMatch(/^[a-f0-9]{64}$/);
      expect((await store.resolve(digest)).equals(bytes)).toBe(true);
      expect(store.root).toBe(path.resolve(path.join(tempDir, RUN_BUNDLE_DIRNAME)));
    },
    FS_TIMEOUT_MS,
  );

  /** The `ok` probe comes first. Without it, a probe that never returns `ok` also gives the two failure verdicts. */
  it(
    'RunBundleStore_Has_SeparatesOkFromMissingFromMismatch',
    async () => {
      const bytes = Buffer.from('probe me', 'utf8');
      const digest = await store.put(bytes);
      const target = blobPath(store.root, digest);

      await expect(store.has(digest)).resolves.toBe('ok');

      const original = await readFile(target);
      await writeFile(target, Buffer.from('tampered payload of a different length', 'utf8'));
      await expect(store.has(digest)).resolves.toBe('mismatch');

      await writeFile(target, original);
      await unlink(target);
      await expect(store.has(digest)).resolves.toBe('missing');
    },
    FS_TIMEOUT_MS,
  );

  /**
   * A read that fails with `EACCES` is an environment fault, not a custody violation.
   * A `missing` verdict makes the oracle report lost bytes that are on disk.
   * The last probe reads the same blob through the real store, so the rejection is about the fault.
   */
  it(
    'RunBundleStore_ProbeHitsEnvironmentFault_RethrowsRatherThanReportingMissing',
    async () => {
      const digest = await store.put(Buffer.from('readable until it is not', 'utf8'));

      const denied = new RunBundleStore(store.root, {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readFile: async () => {
          const error: NodeJS.ErrnoException = new Error('EACCES: permission denied, open');
          error.code = 'EACCES';
          throw error;
        },
        publish: async () => undefined,
        unlink: async () => undefined,
      });

      await expect(denied.has(digest)).rejects.toThrow(/EACCES/);
      await expect(store.has(digest)).resolves.toBe('ok');
    },
    FS_TIMEOUT_MS,
  );

  /** The commit callback reads the blob through the store. The read fails if the commit runs before the write. */
  it(
    'RunBundleStore_PutThenReference_BlobIsDurableBeforeCommitRuns',
    async () => {
      const bytes = Buffer.from('ordered write', 'utf8');
      const artifactId = ArtifactIdSchema.parse('run-bundle:ordering');

      const commit = vi.fn(async (ref: BundleRefV1) => {
        const readBack = await store.resolve(ref.digest);
        return readBack.toString('utf8');
      });

      const observed = await store.putThenReference(artifactId, bytes, commit);

      expect(observed).toBe('ordered write');
      expect(commit).toHaveBeenCalledTimes(1);
      const ref = commit.mock.calls[0]?.[0];
      expect(ref).toBeDefined();
    },
    FS_TIMEOUT_MS,
  );

  /**
   * A failed commit is the crash window. It must leave an orphan blob, never a reference with no bytes.
   * The probe uses the digest that the failed commit received and does not put the bytes again.
   * A second put creates the blob that this case must find already present.
   */
  it(
    'RunBundleStore_CommitThrows_LeavesCollectableOrphanBlob',
    async () => {
      const bytes = Buffer.from('orphaned bundle', 'utf8');
      const artifactId = ArtifactIdSchema.parse('run-bundle:orphan');
      let captured: ContentDigestV1 | undefined;

      await expect(
        store.putThenReference(artifactId, bytes, async (ref) => {
          captured = { algorithm: ref.digest.algorithm, value: ref.digest.value };
          throw new Error('ledger commit failed');
        }),
      ).rejects.toThrow('ledger commit failed');

      expect(captured).toBeDefined();
      if (captured === undefined) return;
      await expect(store.has(captured)).resolves.toBe('ok');
    },
    FS_TIMEOUT_MS,
  );
});
