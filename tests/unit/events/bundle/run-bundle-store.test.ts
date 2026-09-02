/**
 * RunBundleStore — content-addressed custody for run-bundle bytes, and the
 * write ordering that makes a crash between "bytes written" and "reference
 * committed" a collectable orphan rather than a dangling digest.
 *
 * These cases touch a real temp directory, so they carry an explicit per-test
 * timeout rather than leaning on the tier default, which is sized for
 * in-memory work.
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
  it(
    'RunBundleStore_PutThenResolve_RoundTripsBytes',
    async () => {
      const bytes = Buffer.from('run bundle payload', 'utf8');

      const digest = await store.put(bytes);

      expect(digest.algorithm).toBe('sha256');
      expect(digest.value).toMatch(/^[a-f0-9]{64}$/);
      expect((await store.resolve(digest)).equals(bytes)).toBe(true);
      // The root is derived from the state dir, not from wherever the caller
      // happened to be — the ledger and the bytes must share a directory.
      expect(store.root).toBe(path.resolve(path.join(tempDir, RUN_BUNDLE_DIRNAME)));
    },
    FS_TIMEOUT_MS,
  );

  it(
    'RunBundleStore_Has_SeparatesOkFromMissingFromMismatch',
    async () => {
      const bytes = Buffer.from('probe me', 'utf8');
      const digest = await store.put(bytes);
      const target = blobPath(store.root, digest);

      // Baseline first: without this the two failure verdicts below could be
      // produced by a probe that never returns 'ok' at all.
      await expect(store.has(digest)).resolves.toBe('ok');

      // Corruption: the bytes are there but are no longer what was promised.
      const original = await readFile(target);
      await writeFile(target, Buffer.from('tampered payload of a different length', 'utf8'));
      await expect(store.has(digest)).resolves.toBe('mismatch');

      // Deletion.
      await writeFile(target, original);
      await unlink(target);
      await expect(store.has(digest)).resolves.toBe('missing');
    },
    FS_TIMEOUT_MS,
  );

  it(
    'RunBundleStore_ProbeHitsEnvironmentFault_RethrowsRatherThanReportingMissing',
    async () => {
      const digest = await store.put(Buffer.from('readable until it is not', 'utf8'));

      // An unreadable directory is an environment fault, not a custody
      // violation. Collapsing it to 'missing' would have the oracle accuse the
      // ledger of losing bytes that are sitting right there.
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
      // And the same bytes are still resolvable through a store that can read
      // them, so the rejection above is about the fault and not about the blob.
      await expect(store.has(digest)).resolves.toBe('ok');
    },
    FS_TIMEOUT_MS,
  );

  it(
    'RunBundleStore_PutThenReference_BlobIsDurableBeforeCommitRuns',
    async () => {
      const bytes = Buffer.from('ordered write', 'utf8');
      const artifactId = ArtifactIdSchema.parse('run-bundle:ordering');

      // The commit callback reads the blob back through the store. If the
      // reference were committed first this read would fail, which is exactly
      // the dangling-digest window the ordering exists to eliminate.
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

      // A failed commit is the crash window. The surviving artefact must be an
      // orphan blob nothing references, never a reference with no bytes. The
      // probe uses the digest the failed commit was handed and does NOT re-put
      // the bytes first — re-putting would manufacture the blob this case
      // exists to find already present.
      expect(captured).toBeDefined();
      if (captured === undefined) return;
      await expect(store.has(captured)).resolves.toBe('ok');
    },
    FS_TIMEOUT_MS,
  );
});
