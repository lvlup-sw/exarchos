/**
 * `EventStore.runBundleIntegrityCheck`, the bundle oracle, against a real store.
 *
 * The main case is the replay counterexample. The operation-claim fast path of the appender
 * returns the recorded result of a settled operation and reads no bundle byte.
 * As a result, replay reports success after a referenced artifact is deleted. Only the oracle names the loss.
 *
 * Each case opens a real SQLite store in a temp directory, so each case sets `FS_TIMEOUT_MS`.
 *
 * @oracle-sources: ../../../src/events/store.ts, the blob files themselves on disk under the temp state dir — deleted and rewritten directly so custody is judged against the filesystem rather than against the ledger that named it
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readFile, unlink } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { EventStore } from '../../../src/events/store.js';
import { RunBundleStore } from '../../../src/events/bundle/run-bundle-store.js';
import {
  BUNDLE_REF_FIELD,
  SETTLED_EVENT_TYPES,
} from '../../../src/events/bundle/digest-references.js';
import { ArtifactIdSchema } from '../../../src/workflow/admission/types.js';
import type { StorageBackend } from '../../../src/storage/backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const FS_TIMEOUT_MS = 15_000;
const SETTLED_TYPE = SETTLED_EVENT_TYPES[0] ?? 'orchestrate.intent_executed';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'store-bundle-integrity-test-'));
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

function blobPath(root: string, digest: { algorithm: string; value: string }): string {
  return path.join(root, digest.algorithm, digest.value.slice(0, 2), digest.value.slice(2));
}

describe('EventStore.runBundleIntegrityCheck', () => {
  /** The empty verdict has no `violations` field. An empty array reads as a check that found no fault. */
  it(
    'BundleIntegrityCheck_FreshStore_ReportsEmptyNotClear',
    async () => {
      const store = new EventStore(tempDir);

      const result = await store.runBundleIntegrityCheck();

      expect(result.ok).toBe('empty');
      if (result.ok === 'empty') {
        expect(result.referenceCount).toBe(0);
        expect(result.scannedStreamCount).toBeGreaterThanOrEqual(0);
      }
      expect(Object.hasOwn(result, 'violations')).toBe(false);
    },
    FS_TIMEOUT_MS,
  );

  it(
    'BundleIntegrityCheck_SeededResolvableReference_ReportsClear',
    async () => {
      const store = new EventStore(tempDir);
      const bundles = RunBundleStore.forStateDir(tempDir);

      const committed = await bundles.putThenReference(
        ArtifactIdSchema.parse('run-bundle:seeded'),
        Buffer.from('seeded bundle payload', 'utf8'),
        async (ref) =>
          store.append('feat-bundle', {
            type: SETTLED_TYPE,
            data: { [BUNDLE_REF_FIELD]: [ref] },
          }),
      );
      expect(committed.sequence).toBeGreaterThan(0);

      const result = await store.runBundleIntegrityCheck();

      expect(
        result.ok === true || result.ok === false ? result.referenceCount : -1,
        'the sweep did not check the one reference that was seeded',
      ).toBe(1);
      expect(result.ok).toBe(true);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * The replay counterexample. The operation settles through the atomic trail with a claim.
   * Replay returns the recorded claim and does not open the bundle, so it stays green after the blob is deleted.
   * The oracle then names the missing blob.
   * A completed sweep has no `incomplete` marker, so the marker on the timeout verdict discriminates.
   */
  it(
    'BundleIntegrityCheck_DeletedBlob_IsNamedWhileClaimReplayStaysGreen',
    async () => {
      const store = new EventStore(tempDir);
      const bundles = RunBundleStore.forStateDir(tempDir);
      const digest = await bundles.put(Buffer.from('artifact that will vanish', 'utf8'));
      const ref = { artifactId: ArtifactIdSchema.parse('run-bundle:vanishing'), digest };

      const operationId = 'op-bundle-replay';
      await store.appendTrailAtomically(
        'feat-bundle',
        [{ type: SETTLED_TYPE, data: { [BUNDLE_REF_FIELD]: [ref] } }],
        operationId,
      );

      const clear = await store.runBundleIntegrityCheck();
      expect(clear.ok, 'the seeded reference must resolve before it is broken').toBe(true);

      await unlink(blobPath(bundles.root, digest));

      await expect(
        store.appendTrailAtomically(
          'feat-bundle',
          [{ type: SETTLED_TYPE, data: { [BUNDLE_REF_FIELD]: [ref] } }],
          operationId,
        ),
      ).resolves.toBeUndefined();
      const afterReplay = await store.query('feat-bundle');
      expect(
        afterReplay.filter((e) => e.type === SETTLED_TYPE),
        'the replay must be a claim hit, not a second append',
      ).toHaveLength(1);

      const result = await store.runBundleIntegrityCheck();
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.referenceCount).toBe(1);
      expect(result.violations.map((v) => v.kind)).toEqual(['blob-missing']);
      expect(result.violations[0]?.digest).toBe(`sha256:${digest.value}`);
      expect(result.details).toContain('run-bundle violation');
      expect(result.incomplete).toBeUndefined();
    },
    FS_TIMEOUT_MS,
  );

  it(
    'BundleIntegrityCheck_BackendWithoutStreamEnumeration_ReportsSkipped',
    async () => {
      const backend: Partial<StorageBackend> = { queryEvents: () => [] };
      const store = new EventStore(tempDir, {
        backend: backend as unknown as StorageBackend,
      });

      const result = await store.runBundleIntegrityCheck();

      expect(result.ok).toBe('skipped');
      if (result.ok === 'skipped') {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    },
    FS_TIMEOUT_MS,
  );

  /**
   * The skip guard reads `listStreams` on one backend object. The sweep must enumerate through that same object.
   * The injected backend returns one known stream, so `scannedStreamCount` proves which enumerator ran.
   */
  it(
    'BundleIntegrityCheck_SweepEnumeratesTheSameBackendTheSkipGuardTested',
    async () => {
      const backend: Partial<StorageBackend> = {
        listStreams: () => ['guarded-enumerator-stream'],
        queryEvents: () => [],
      };
      const store = new EventStore(tempDir, {
        backend: backend as unknown as StorageBackend,
      });

      const result = await store.runBundleIntegrityCheck();

      expect(result.ok, 'the injected backend enumerates, so this must not skip').toBe(
        'empty',
      );
      if (result.ok !== 'empty') return;
      expect(result.scannedStreamCount).toBe(1);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * The reads of the injected bundle store never settle, so the method itself must apply the time bound.
   * A sweep that timed out measured nothing. Its verdict is `incomplete` and holds no counts,
   * so it cannot have the shape of a completed sweep.
   */
  it(
    'BundleIntegrityCheck_SweepExceedsBudget_ReportsTimeout',
    async () => {
      const store = new EventStore(tempDir);
      const bundles = RunBundleStore.forStateDir(tempDir);
      const digest = await bundles.put(Buffer.from('slow read', 'utf8'));
      await store.append('feat-bundle', {
        type: SETTLED_TYPE,
        data: {
          [BUNDLE_REF_FIELD]: [
            { artifactId: ArtifactIdSchema.parse('run-bundle:slow'), digest },
          ],
        },
      });

      const stalled = new RunBundleStore(bundles.root, {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readFile: () => new Promise<Buffer>(() => {}),
        publish: async () => undefined,
        unlink: async () => undefined,
      });

      const result = await store.runBundleIntegrityCheck({
        timeoutMs: 25,
        bundleStore: stalled,
      });

      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.details).toContain('timed out after 25ms');
      expect(result.violations).toEqual([]);
      expect(
        result.incomplete,
        'a timed-out sweep must mark itself incomplete',
      ).toBe(true);
      expect('referenceCount' in result).toBe(false);
      expect('scannedStreamCount' in result).toBe(false);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * The signal belongs to the caller and outlives each sweep. A `{ once: true }` listener detaches only on abort,
   * so a sweep that completes normally must remove its listeners.
   * A retained listener also holds the reject closure of a promise that cannot settle.
   */
  it(
    'BundleIntegrityCheck_ReusedSignalAcrossSweeps_LeavesNoListenersBehind',
    async () => {
      const store = new EventStore(tempDir);
      const controller = new AbortController();

      for (let i = 0; i < 5; i += 1) {
        await store.runBundleIntegrityCheck({ signal: controller.signal });
      }

      expect(
        getEventListeners(controller.signal, 'abort'),
        'a sweep that completed without aborting left a listener on the caller\'s signal',
      ).toHaveLength(0);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * A caller abort in the middle of a sweep rejects two arms of the race: the sweep and the external-abort arm.
   * Only one arm wins. The process-level `unhandledRejection` hook proves that the other arm is not reported.
   * The 20 ms wait lets a late rejection arrive before the assertion.
   */
  it(
    'BundleIntegrityCheck_ExternalAbortMidSweep_RejectsOnceWithNoUnhandledRejection',
    async () => {
      const store = new EventStore(tempDir);
      const bundles = RunBundleStore.forStateDir(tempDir);
      const refs = await Promise.all(
        ['one', 'two', 'three'].map(async (label) => ({
          artifactId: ArtifactIdSchema.parse(`run-bundle:${label}`),
          digest: await bundles.put(Buffer.from(`payload ${label}`, 'utf8')),
        })),
      );
      await store.append('feat-bundle', {
        type: SETTLED_TYPE,
        data: { [BUNDLE_REF_FIELD]: refs },
      });

      const controller = new AbortController();
      const probe = vi.fn(async (file: string) => {
        controller.abort();
        return readFile(file);
      });
      const probing = new RunBundleStore(bundles.root, {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readFile: probe,
        publish: async () => undefined,
        unlink: async () => undefined,
      });

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        await expect(
          store.runBundleIntegrityCheck({ signal: controller.signal, bundleStore: probing }),
        ).rejects.toThrow(/aborted/);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      expect(unhandled, 'a losing arm of the race surfaced as an unhandled rejection').toEqual([]);
      expect(probe, 'the sweep kept probing after the caller aborted').toHaveBeenCalledTimes(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    },
    FS_TIMEOUT_MS,
  );

  /** A caller abort is an exception, not a verdict. A cancelled sweep must not look like a clean sweep. */
  it(
    'BundleIntegrityCheck_PreAbortedSignal_RejectsWithAbortError',
    async () => {
      const store = new EventStore(tempDir);
      const controller = new AbortController();
      controller.abort();

      await expect(
        store.runBundleIntegrityCheck({ signal: controller.signal }),
      ).rejects.toThrow(/aborted/);
    },
    FS_TIMEOUT_MS,
  );
});
