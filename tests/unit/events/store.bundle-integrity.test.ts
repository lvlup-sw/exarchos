/**
 * EventStore.runBundleIntegrityCheck — the oracle against a real store.
 *
 * The case that carries this file is the replay counterexample. The appender's
 * operation-claim fast path returns a settled operation's recorded result
 * without reading a single bundle byte, so deleting a referenced artifact
 * leaves replay reporting success. That test asserts BOTH halves in one place:
 * replay still green, oracle red. If the oracle ever stops naming it, nothing
 * in the system does.
 *
 * These cases open a real SQLite store on a temp directory, so they carry an
 * explicit per-test timeout rather than the tier default.
 *
 * @oracle-sources: ../../../src/events/store.ts, the blob files themselves on disk under the temp state dir — deleted and rewritten directly so custody is judged against the filesystem rather than against the ledger that named it
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      // The empty verdict carries no violations field at all — an empty
      // violation array would read as "checked and found nothing wrong".
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

  it(
    'BundleIntegrityCheck_DeletedBlob_IsNamedWhileClaimReplayStaysGreen',
    async () => {
      const store = new EventStore(tempDir);
      const bundles = RunBundleStore.forStateDir(tempDir);
      const digest = await bundles.put(Buffer.from('artifact that will vanish', 'utf8'));
      const ref = { artifactId: ArtifactIdSchema.parse('run-bundle:vanishing'), digest };

      // Settle the operation through the claim-backed atomic trail, which is
      // the path whose replay short-circuits on the recorded claim.
      const operationId = 'op-bundle-replay';
      await store.appendTrailAtomically(
        'feat-bundle',
        [{ type: SETTLED_TYPE, data: { [BUNDLE_REF_FIELD]: [ref] } }],
        operationId,
      );

      const clear = await store.runBundleIntegrityCheck();
      expect(clear.ok, 'the seeded reference must resolve before it is broken').toBe(true);

      await unlink(blobPath(bundles.root, digest));

      // Half one: replay is still green. The claim fast path returns the
      // recorded result without ever opening the bundle, so the deletion is
      // invisible to it.
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

      // Half two: the oracle names what replay could not see.
      const result = await store.runBundleIntegrityCheck();
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.referenceCount).toBe(1);
      expect(result.violations.map((v) => v.kind)).toEqual(['blob-missing']);
      expect(result.violations[0]?.digest).toBe(`sha256:${digest.value}`);
      expect(result.details).toContain('run-bundle violation');
      // A sweep that ran to completion carries no incompleteness marker, so the
      // marker on the timeout verdict below actually discriminates.
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

  it(
    'BundleIntegrityCheck_SweepEnumeratesTheSameBackendTheSkipGuardTested',
    async () => {
      // The skip verdict is decided by looking at one object's `listStreams`.
      // If the sweep then enumerated through some other path, the guard would
      // be vouching for an enumerator that never runs. Injecting a backend
      // whose stream list is recognisable proves the sweep walked exactly the
      // enumerator the guard admitted.
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

      // A bundle store whose reads never settle. The wall-clock bound has to
      // come from the method itself, not from the filesystem being fast.
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
      // The zero counts on a timeout are placeholders for work never done. The
      // flag is what says so structurally — without it this verdict is
      // shape-identical to a completed sweep that found a zero-denominator
      // failure, and only the prose in `details` tells them apart.
      expect(
        result.incomplete,
        'a timed-out sweep must mark its counts as unmeasured',
      ).toBe(true);
      expect(result.referenceCount).toBe(0);
    },
    FS_TIMEOUT_MS,
  );

  it(
    'BundleIntegrityCheck_ReusedSignalAcrossSweeps_LeavesNoListenersBehind',
    async () => {
      const store = new EventStore(tempDir);
      const controller = new AbortController();

      // The caller owns this signal and outlives any one sweep. Every arm of
      // the race attaches to it, and `{ once: true }` detaches only on the
      // abort path — so a sweep that finishes normally is the case that leaks.
      // Each retained listener also pins the reject closure of a promise that
      // can no longer settle.
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

  it(
    'BundleIntegrityCheck_ExternalAbortMidSweep_RejectsOnceWithNoUnhandledRejection',
    async () => {
      // A mid-sweep caller abort settles TWO arms of the race with an
      // AbortError: the sweep itself and the external-abort rejection. Only one
      // can win, so this pins that the loser is never reported as an unhandled
      // rejection — `Promise.race` subscribes to every arm it is handed, and
      // the process-level hook is the observer that would catch a regression
      // to a shape (a detached `.then`, a late-created arm) that does not.
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
      let probes = 0;
      const probing = new RunBundleStore(bundles.root, {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readFile: async (file: string) => {
          probes += 1;
          controller.abort();
          return readFile(file);
        },
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
        // Give a losing arm's rejection every chance to surface before judging.
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      expect(unhandled, 'a losing arm of the race surfaced as an unhandled rejection').toEqual([]);
      expect(probes, 'the sweep kept probing after the caller aborted').toBe(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    },
    FS_TIMEOUT_MS,
  );

  it(
    'BundleIntegrityCheck_PreAbortedSignal_RejectsWithAbortError',
    async () => {
      const store = new EventStore(tempDir);
      const controller = new AbortController();
      controller.abort();

      // Caller-initiated cancellation is an exception, not a verdict — a
      // cancelled sweep must never be mistaken for a clean one.
      await expect(
        store.runBundleIntegrityCheck({ signal: controller.signal }),
      ).rejects.toThrow(/aborted/);
    },
    FS_TIMEOUT_MS,
  );
});
