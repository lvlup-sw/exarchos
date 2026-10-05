/**
 * Tests for the verdict logic of `checkRunBundleIntegrity`, over a fake event source.
 *
 * Each failing case starts from a passing configuration and breaks one thing.
 * A check that never fails gives no evidence when it passes.
 *
 * @oracle-sources: ../../../../src/events/bundle/integrity.ts, the violation kinds written out as literals in each case from the declared taxonomy — never read back off the result the case is judging
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  checkRunBundleIntegrity,
  type BundleEventSource,
} from '../../../../src/events/bundle/integrity.js';
import { RunBundleStore } from '../../../../src/events/bundle/run-bundle-store.js';
import {
  BUNDLE_REF_FIELD,
  SETTLED_EVENT_TYPES,
  SETTLEMENT_ENDPOINTS,
  settlementCustody,
} from '../../../../src/events/bundle/digest-references.js';
import { ArtifactIdSchema } from '../../../../src/workflow/admission/types.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const FS_TIMEOUT_MS = 15_000;
/**
 * The settlement type and the custody epoch are literals, not reads of the constants in `digest-references.ts`.
 * A drift in a constant then fails the membership case and does not rename the fixtures.
 */
const SETTLED_TYPE = 'orchestrate.intent_executed';
/** The payload version from which a settlement must reference bytes. */
const CUSTODIAL_VERSION = '1.1';
/** A payload version written before custody existed. */
const PRE_CUSTODY_VERSION = '1.0';

let tempDir: string;
let store: RunBundleStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'bundle-integrity-test-'));
  store = RunBundleStore.forStateDir(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

function fakeSource(streams: Record<string, WorkflowEvent[]>): BundleEventSource {
  return {
    listStreams: () => Object.keys(streams),
    query: async (streamId) => streams[streamId] ?? [],
  };
}

function event(
  streamId: string,
  sequence: number,
  type: string,
  data?: Record<string, unknown>,
  schemaVersion: string = PRE_CUSTODY_VERSION,
): WorkflowEvent {
  return {
    streamId,
    sequence,
    type,
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    schemaVersion,
    ...(data === undefined ? {} : { data }),
  };
}

/** A settlement record written under the custody contract. */
function settlement(streamId: string, sequence: number, data?: Record<string, unknown>): WorkflowEvent {
  return event(streamId, sequence, SETTLED_TYPE, data, CUSTODIAL_VERSION);
}

function blobPath(root: string, digest: { algorithm: string; value: string }): string {
  return path.join(root, digest.algorithm, digest.value.slice(0, 2), digest.value.slice(2));
}

async function seedRef(label: string, payload: string) {
  const digest = await store.put(Buffer.from(payload, 'utf8'));
  return { artifactId: ArtifactIdSchema.parse(label), digest };
}

describe('checkRunBundleIntegrity', () => {
  /** `empty` is not `true`. The sweep checked nothing, so the result is no evidence that the store is intact. */
  it('BundleIntegrity_NoStreams_ReportsEmptyNotClear', async () => {
    const result = await checkRunBundleIntegrity(fakeSource({}), store);

    expect(result.ok).toBe('empty');
    if (result.ok === 'empty') {
      expect(result.referenceCount).toBe(0);
      expect(result.scannedStreamCount).toBe(0);
    }
  });

  it('BundleIntegrity_DigestlessStreams_ReportsEmpty', async () => {
    const source = fakeSource({
      'feat-a': [event('feat-a', 1, 'workflow.started')],
      'feat-b': [event('feat-b', 1, 'workflow.started', { unrelated: 'payload' })],
    });

    const result = await checkRunBundleIntegrity(source, store);

    expect(result.ok).toBe('empty');
    if (result.ok === 'empty') {
      expect(result.scannedStreamCount).toBe(2);
      expect(result.referenceCount).toBe(0);
    }
  });

  /**
   * The case asserts the two counts before the verdict.
   * A clear verdict alone does not show how many references the sweep checked.
   */
  it(
    'BundleIntegrity_AllReferencesResolve_ReportsClearWithItsDenominator',
    async () => {
      const one = await seedRef('run-bundle:one', 'payload one');
      const two = await seedRef('run-bundle:two', 'payload two');
      const three = await seedRef('run-bundle:three', 'payload three');

      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started'),
          settlement('feat-a', 2, { [BUNDLE_REF_FIELD]: [one, two] }),
        ],
        'feat-b': [event('feat-b', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [three] })],
      });

      const result = await checkRunBundleIntegrity(source, store);

      expect(
        result.ok === true || result.ok === false ? result.referenceCount : -1,
        'the sweep checked a different number of references than were seeded',
      ).toBe(3);
      expect(
        result.ok === true || result.ok === false ? result.scannedStreamCount : -1,
        'the sweep did not enumerate both seeded streams',
      ).toBe(2);
      expect(result.ok, 'every seeded blob resolves, so the verdict must be clear').toBe(true);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * Four references in two streams name two distinct digests. Each probe reads and hashes the blob again.
   * So a repeated probe spends the time bound of the caller for an answer that the store already gave.
   * The memo must not decrease the reference count, or one probe looks the same as one reference.
   */
  it(
    'BundleIntegrity_RepeatedDigest_ProbesTheStoreOncePerDistinctDigest',
    async () => {
      const shared = await seedRef('run-bundle:shared', 'shared payload');
      const other = await seedRef('run-bundle:other', 'other payload');

      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [shared, other] }),
          event('feat-a', 2, 'workflow.started', { [BUNDLE_REF_FIELD]: [shared] }),
        ],
        'feat-b': [event('feat-b', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [shared] })],
      });

      const probe = vi.spyOn(store, 'has');
      const result = await checkRunBundleIntegrity(source, store);

      expect(
        result.ok === true || result.ok === false ? result.referenceCount : -1,
        'memoization must not collapse the reference denominator',
      ).toBe(4);
      expect(result.ok, 'every seeded blob resolves, so the verdict must be clear').toBe(true);
      expect(probe, 'the store was probed more than once per distinct digest').toHaveBeenCalledTimes(
        2,
      );
    },
    FS_TIMEOUT_MS,
  );

  it(
    'BundleIntegrity_DeletedBlob_ReportsBlobMissingAndKeepsDenominator',
    async () => {
      const one = await seedRef('run-bundle:one', 'payload one');
      const two = await seedRef('run-bundle:two', 'payload two');
      const three = await seedRef('run-bundle:three', 'payload three');
      await unlink(blobPath(store.root, two.digest));

      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [one, two] }),
          event('feat-a', 2, 'workflow.started', { [BUNDLE_REF_FIELD]: [three] }),
        ],
      });

      const result = await checkRunBundleIntegrity(source, store);

      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.referenceCount).toBe(3);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.kind).toBe('blob-missing');
      expect(result.violations[0]?.digest).toBe(`sha256:${two.digest.value}`);
      expect(result.violations[0]?.streamId).toBe('feat-a');
      expect(result.violations[0]?.sequence).toBe(1);
    },
    FS_TIMEOUT_MS,
  );

  it(
    'BundleIntegrity_CorruptedBlob_ReportsDigestMismatch',
    async () => {
      const one = await seedRef('run-bundle:one', 'payload one');
      await writeFile(
        blobPath(store.root, one.digest),
        Buffer.from('entirely different bytes under the same name', 'utf8'),
      );

      const source = fakeSource({
        'feat-a': [event('feat-a', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [one] })],
      });

      const result = await checkRunBundleIntegrity(source, store);

      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.referenceCount).toBe(1);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.kind).toBe('digest-mismatch');
      expect(result.violations[0]?.digest).toBe(`sha256:${one.digest.value}`);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * A writer can pass a resolvability check when it references nothing.
   * So a custodial settlement with no reference is a violation, not `empty`.
   */
  it(
    'BundleIntegrity_CustodialSettlementWithZeroReferences_IsAViolationNotEmpty',
    async () => {
      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started'),
          settlement('feat-a', 2, { leafId: 'some-leaf' }),
        ],
      });

      const result = await checkRunBundleIntegrity(source, store);

      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.referenceCount).toBe(0);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.kind).toBe('settlement-without-references');
      expect(result.violations[0]?.sequence).toBe(2);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * The same record with a pre-custody payload version settled without a bundle by contract.
   * The sweep counts the record and checks nothing, so the result is `empty` and not a violation.
   */
  it(
    'BundleIntegrity_PreCustodySettlementWithZeroReferences_IsCountedNotCondemned',
    async () => {
      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started'),
          event('feat-a', 2, SETTLED_TYPE, { leafId: 'some-leaf' }, PRE_CUSTODY_VERSION),
        ],
      });

      const result = await checkRunBundleIntegrity(source, store);

      expect(result.ok).toBe('empty');
      if (result.ok !== 'empty') return;
      expect(result.preCustodySettlementCount).toBe(1);
      expect(result.referenceCount).toBe(0);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * An unreadable version stamp does not exempt a settlement from the custody rule.
   * A parser that trusts `Number()` for each component reads each of these stamps as a version before the epoch.
   */
  it(
    'BundleIntegrity_SettlementWithAnUnreadableVersionStamp_IsHeldToTheCustodyRule',
    async () => {
      for (const stamp of ['', '1.', '1..0', '1e0']) {
        const source = fakeSource({
          'feat-a': [event('feat-a', 1, SETTLED_TYPE, { leafId: 'some-leaf' }, stamp)],
        });

        const result = await checkRunBundleIntegrity(source, store);

        expect(result.ok, `stamp ${JSON.stringify(stamp)}`).toBe(false);
        if (result.ok !== false) continue;
        expect(result.violations.map((violation) => violation.kind)).toEqual([
          'settlement-without-references',
        ]);
      }
    },
    FS_TIMEOUT_MS,
  );

  /**
   * The rule applies to each record. A count per stream lets the first referenced
   * settlement hide a later settlement that has no reference.
   */
  it(
    'BundleIntegrity_SecondSettlementWithoutReferences_IsAViolationAfterAReferencedOne',
    async () => {
      const one = await seedRef('run-bundle:first', 'first payload');
      const source = fakeSource({
        'feat-a': [
          settlement('feat-a', 1, { [BUNDLE_REF_FIELD]: [one] }),
          settlement('feat-a', 2, { leafId: 'ran-again' }),
          settlement('feat-a', 3, { leafId: 'and-again' }),
        ],
      });

      const result = await checkRunBundleIntegrity(source, store);

      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.referenceCount).toBe(1);
      expect(result.violations.map((v) => [v.kind, v.sequence])).toEqual([
        ['settlement-without-references', 2],
        ['settlement-without-references', 3],
      ]);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * The settled stream of the `CustodialSettlementWithZeroReferences` case passes when its settlement references bytes.
   * So that violation is about the missing reference, not about the settlement.
   */
  it(
    'BundleIntegrity_SettledStreamWithAResolvableReference_IsClear',
    async () => {
      const one = await seedRef('run-bundle:settled', 'settled payload');
      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started'),
          settlement('feat-a', 2, { [BUNDLE_REF_FIELD]: [one] }),
        ],
      });

      const result = await checkRunBundleIntegrity(source, store);

      expect(result.ok === true ? result.referenceCount : -1).toBe(1);
      expect(result.ok).toBe(true);
      if (result.ok === true) expect(result.preCustodySettlementCount).toBe(0);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * A store fault that is not a content verdict, here `EACCES`, becomes a violation on its reference.
   * The sweep keeps the earlier violation, is not `incomplete`, and counts all three references.
   */
  it(
    'BundleIntegrity_UnreadableBlob_IsNamedOnItsReferenceAndTheSweepContinues',
    async () => {
      const first = await seedRef('run-bundle:first', 'first payload');
      const denied = await seedRef('run-bundle:denied', 'denied payload');
      const third = await seedRef('run-bundle:third', 'third payload');
      await unlink(blobPath(store.root, first.digest));

      const deniedPath = blobPath(store.root, denied.digest);
      const faulting = new RunBundleStore(store.root, {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readFile: async (file: string) => {
          if (file === deniedPath) {
            const error = new Error('EACCES: permission denied');
            (error as NodeJS.ErrnoException).code = 'EACCES';
            throw error;
          }
          return readFile(file);
        },
        publish: async () => undefined,
        unlink: async () => undefined,
      });
      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [first] }),
          event('feat-a', 2, 'workflow.started', { [BUNDLE_REF_FIELD]: [denied] }),
          event('feat-a', 3, 'workflow.started', { [BUNDLE_REF_FIELD]: [third] }),
        ],
      });

      const result = await checkRunBundleIntegrity(source, faulting);

      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.incomplete).toBeUndefined();
      expect(result.referenceCount).toBe(3);
      expect(result.violations.map((v) => [v.kind, v.sequence])).toEqual([
        ['blob-missing', 1],
        ['unreadable-blob', 2],
      ]);
      expect(result.violations[1]?.detail).toContain('EACCES');
    },
    FS_TIMEOUT_MS,
  );

  /** The sweep does not probe an entry that fails to parse. The entry is a violation and adds nothing to the reference count. */
  it('BundleIntegrity_UnparseableReference_ReportsMalformed', async () => {
    const source = fakeSource({
      'feat-a': [
        event('feat-a', 1, 'workflow.started', {
          [BUNDLE_REF_FIELD]: [{ artifactId: 'x' }],
        }),
      ],
    });

    const result = await checkRunBundleIntegrity(source, store);

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.referenceCount).toBe(0);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('malformed-reference');
  });

  it('BundleIntegrity_NonArrayReferenceField_ReportsMalformed', async () => {
    const source = fakeSource({
      'feat-a': [
        event('feat-a', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: 'not-an-array' }),
      ],
    });

    const result = await checkRunBundleIntegrity(source, store);

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations[0]?.kind).toBe('malformed-reference');
  });

  /**
   * The malformed entry is one violation. The settlement then has no parsed reference, which is a second violation.
   * A report of only the first lets a parse error hide a custody gap.
   */
  it(
    'BundleIntegrity_SettledStreamWithOnlyMalformedReferences_ReportsBothViolations',
    async () => {
      const source = fakeSource({
        'feat-a': [
          settlement('feat-a', 1, {
            [BUNDLE_REF_FIELD]: [{ artifactId: 'x' }],
          }),
        ],
      });

      const result = await checkRunBundleIntegrity(source, store);

      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.referenceCount).toBe(0);
      expect([...result.violations].map((v) => v.kind).sort()).toEqual([
        'malformed-reference',
        'settlement-without-references',
      ]);
    },
    FS_TIMEOUT_MS,
  );

  it('BundleIntegrity_AbortedSignal_StopsTheSweep', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = fakeSource({
      'feat-a': [event('feat-a', 1, 'workflow.started')],
    });

    await expect(
      checkRunBundleIntegrity(source, store, controller.signal),
    ).rejects.toThrow(/aborted/);
  });

  /**
   * The probe count proves that the sweep stops. A sweep that walks every event and then throws also rejects.
   * The source holds one stream, so the check between streams cannot stop this sweep.
   */
  it(
    'BundleIntegrity_AbortMidStream_LeavesTheRemainingEventsUnprobed',
    async () => {
      const controller = new AbortController();
      const one = await seedRef('run-bundle:one', 'payload one');
      const two = await seedRef('run-bundle:two', 'payload two');
      const three = await seedRef('run-bundle:three', 'payload three');

      const probe = vi.fn(async (file: string) => {
        controller.abort();
        return readFile(file);
      });
      const probing = new RunBundleStore(store.root, {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readFile: probe,
        publish: async () => undefined,
        unlink: async () => undefined,
      });

      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [one] }),
          event('feat-a', 2, 'workflow.started', { [BUNDLE_REF_FIELD]: [two] }),
          event('feat-a', 3, 'workflow.started', { [BUNDLE_REF_FIELD]: [three] }),
        ],
      });

      await expect(
        checkRunBundleIntegrity(source, probing, controller.signal),
      ).rejects.toThrow(/aborted/);
      expect(
        probe,
        'the sweep kept probing blobs after the signal aborted mid-stream',
      ).toHaveBeenCalledTimes(1);
    },
    FS_TIMEOUT_MS,
  );

  /** The source holds one stream with one event, so only the checks around each reference probe can stop the sweep. */
  it(
    'BundleIntegrity_AbortMidEvent_LeavesTheRemainingReferencesUnprobed',
    async () => {
      const controller = new AbortController();
      const one = await seedRef('run-bundle:one', 'payload one');
      const two = await seedRef('run-bundle:two', 'payload two');
      const three = await seedRef('run-bundle:three', 'payload three');

      const probe = vi.fn(async (file: string) => {
        controller.abort();
        return readFile(file);
      });
      const probing = new RunBundleStore(store.root, {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readFile: probe,
        publish: async () => undefined,
        unlink: async () => undefined,
      });

      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started', {
            [BUNDLE_REF_FIELD]: [one, two, three],
          }),
        ],
      });

      await expect(
        checkRunBundleIntegrity(source, probing, controller.signal),
      ).rejects.toThrow(/aborted/);
      expect(
        probe,
        'the sweep kept probing references after the signal aborted mid-event',
      ).toHaveBeenCalledTimes(1);
    },
    FS_TIMEOUT_MS,
  );

  /**
   * The checks between probes cannot stop a probe that is in progress, so the sweep passes the signal to the read.
   * The fake read settles only through that signal. A sweep that does not pass the signal never settles.
   * The race reports that sweep as `hung`, not as a suite timeout.
   */
  it(
    'BundleIntegrity_AbortDuringAPendingProbe_AbandonsTheRead',
    async () => {
      const controller = new AbortController();
      const one = await seedRef('run-bundle:one', 'payload one');

      const probe = vi.fn(
        (_file: string, signal?: AbortSignal) =>
          new Promise<Buffer>((_, reject) => {
            signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      const hanging = new RunBundleStore(store.root, {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readFile: probe,
        publish: async () => undefined,
        unlink: async () => undefined,
      });
      const source = fakeSource({
        'feat-a': [event('feat-a', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [one] })],
      });

      const sweep = checkRunBundleIntegrity(source, hanging, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(probe, 'the read never started').toHaveBeenCalledTimes(1);
      controller.abort();

      const outcome = await Promise.race([
        sweep.then(
          () => 'resolved',
          (err: unknown) => (err instanceof Error ? err.name : 'rejected'),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
      ]);
      expect(outcome, 'the pending probe was not abandoned on cancellation').toBe('AbortError');
    },
    FS_TIMEOUT_MS,
  );

  /** Every stream is empty, so only the check between streams can stop the sweep. */
  it('BundleIntegrity_AbortBetweenStreams_LeavesTheRemainingStreamsUnqueried', async () => {
    const controller = new AbortController();
    let queries = 0;
    const source: BundleEventSource = {
      listStreams: () => ['feat-a', 'feat-b', 'feat-c'],
      query: async () => {
        queries += 1;
        controller.abort();
        return [];
      },
    };

    await expect(
      checkRunBundleIntegrity(source, store, controller.signal),
    ).rejects.toThrow(/aborted/);
    expect(
      queries,
      'the sweep queried further streams after the signal aborted',
    ).toBe(1);
  });

  /**
   * No abort case above needs the sweep to yield. Each sets the signal before the sweep, from a callback
   * of the sweep, or during a pending read. The timeout of a caller is a timer, and a timer needs the
   * event loop. A ledger with many streams and no reference awaits no read that yields.
   * So the sweep must yield, or the timer never fires. This case aborts from a real timer.
   */
  it('BundleIntegrity_ReferenceFreeLedger_StillLetsATimerAbortIt', async () => {
    const controller = new AbortController();
    const streamCount = 20_000;
    let queries = 0;
    const source: BundleEventSource = {
      listStreams: () => Array.from({ length: streamCount }, (_, i) => `feat-${i}`),
      query: async () => {
        queries += 1;
        return [];
      },
    };
    setTimeout(() => controller.abort(), 1);

    await expect(
      checkRunBundleIntegrity(source, store, controller.signal),
    ).rejects.toThrow(/aborted/);
    expect(queries, 'the timer never got a turn: the walk ran to the end').toBeLessThan(streamCount);
  });

  /** The membership case: the only case that compares the fixture literals with the constants of the module. */
  it('BundleIntegrity_SettlementEndpoints_AreTheLiteralTypeAndEpochTheseFixturesUse', () => {
    expect(SETTLED_EVENT_TYPES).toContain(SETTLED_TYPE);
    expect(SETTLEMENT_ENDPOINTS.find((endpoint) => endpoint.type === SETTLED_TYPE)?.custodyFromSchemaVersion).toBe(
      CUSTODIAL_VERSION,
    );
  });
});

describe('settlementCustody', () => {
  const settled = (schemaVersion: string): WorkflowEvent =>
    event('feat-a', 1, SETTLED_TYPE, { leafId: 'some-leaf' }, schemaVersion);

  it('SettlementCustody_ReadableStamps_CompareNumericallyPerComponent', () => {
    for (const stamp of ['1.0', '0.9', '1', '1.0.99']) {
      expect(settlementCustody(settled(stamp)), stamp).toBe('pre-custody');
    }
    for (const stamp of ['1.1', '1.10', '2', '01.1', '1.1.0']) {
      expect(settlementCustody(settled(stamp)), stamp).toBe('custodial');
    }
    expect(settlementCustody(event('feat-a', 1, 'workflow.started', undefined, '0.1'))).toBe(
      'not-a-settlement',
    );
  });

  /**
   * A parser that trusts `Number()` for each component reads each stamp of the first loop as a version before the epoch.
   * A component that is not a run of decimal digits makes the stamp unreadable, and an unreadable stamp is custodial.
   * The second loop pins the boundary: a minus sign, a comma, and a word are also custodial.
   */
  it('SettlementCustody_UnreadableStamps_AreCustodialNotExempt', () => {
    for (const stamp of ['', '1.', '.1', '1..0', '1e0', ' 1', '1 ', '0x1', '+1']) {
      expect(settlementCustody(settled(stamp)), JSON.stringify(stamp)).toBe('custodial');
    }
    for (const stamp of ['-1', '1,1', 'latest']) {
      expect(settlementCustody(settled(stamp)), JSON.stringify(stamp)).toBe('custodial');
    }
  });
});
