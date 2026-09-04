/**
 * checkRunBundleIntegrity — the verdict logic, exercised over a fake event
 * source so every arm is reachable without a substrate.
 *
 * The seeded violations are the point of this file. A resolvability check that
 * has never been shown to go red is a check whose green means nothing, so each
 * failing arm here starts from a passing configuration and breaks exactly one
 * thing: one blob deleted, one blob corrupted, one settled stream stripped of
 * its references, one reference made unparseable.
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
// Literals, not reads of the constants under test: a settlement type or an
// epoch derived from the module would rename these fixtures along with any
// drift in it. The membership case at the bottom is what binds the two.
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
  it('BundleIntegrity_NoStreams_ReportsEmptyNotClear', async () => {
    const result = await checkRunBundleIntegrity(fakeSource({}), store);

    // EMPTY is a distinct claim from CLEAR: nothing was checked, so the check
    // is not evidence that anything is intact.
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

      // DENOMINATOR FIRST. A `ok: true` from a sweep that read no references
      // is indistinguishable from a sweep that verified three.
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

  it(
    'BundleIntegrity_RepeatedDigest_ProbesTheStoreOncePerDistinctDigest',
    async () => {
      const shared = await seedRef('run-bundle:shared', 'shared payload');
      const other = await seedRef('run-bundle:other', 'other payload');

      // The same digest referenced four times across two streams. Each probe
      // re-reads and re-hashes the blob, and the sweep runs under a wall-clock
      // bound whose expiry is reported as `incomplete` — so repeating a probe
      // the store already answered spends the budget that bound is protecting.
      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [shared, other] }),
          event('feat-a', 2, 'workflow.started', { [BUNDLE_REF_FIELD]: [shared] }),
        ],
        'feat-b': [event('feat-b', 1, 'workflow.started', { [BUNDLE_REF_FIELD]: [shared] })],
      });

      const probe = vi.spyOn(store, 'has');
      const result = await checkRunBundleIntegrity(source, store);

      // DENOMINATOR FIRST. Memoizing the probe must not shrink the count of
      // references the sweep reports having checked — otherwise "one probe" and
      // "one reference" become indistinguishable.
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
      // The denominator survives the failure: two of three still resolved.
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

      // Referencing nothing is the cheapest way to pass a resolvability check.
      // Settlement under custody without a reference must therefore be red,
      // not 'empty'.
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.referenceCount).toBe(0);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.kind).toBe('settlement-without-references');
      expect(result.violations[0]?.sequence).toBe(2);
    },
    FS_TIMEOUT_MS,
  );

  it(
    'BundleIntegrity_PreCustodySettlementWithZeroReferences_IsCountedNotCondemned',
    async () => {
      // The same record, stamped with the payload version a producer wrote
      // before custody existed. It settled without a bundle by contract: the
      // sweep reports having seen it and checks nothing, so an upgraded ledger
      // full of such rows is EMPTY with a count, never a violation.
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

  it(
    'BundleIntegrity_SettlementWithAnUnreadableVersionStamp_IsHeldToTheCustodyRule',
    async () => {
      // A stamp the comparison cannot read is not a way out of the rule. Each
      // of these converts through `Number()` to a small integer that sorts
      // before the epoch, so a parser that trusted the conversion would exempt
      // every one of them.
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

  it(
    'BundleIntegrity_SecondSettlementWithoutReferences_IsAViolationAfterAReferencedOne',
    async () => {
      // The rule is per record. A stream whose first settlement carried a
      // reference must not answer for a later settlement that carried none —
      // that is exactly the masking a per-stream tally would allow.
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

  it(
    'BundleIntegrity_SettledStreamWithAResolvableReference_IsClear',
    async () => {
      // The sibling of the violation case: the same settled stream passes once
      // it actually references bytes, so the violation there is about the
      // missing custody rather than about settlement itself.
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

  it(
    'BundleIntegrity_UnreadableBlob_IsNamedOnItsReferenceAndTheSweepContinues',
    async () => {
      // A fault the store cannot turn into a content verdict — a permissions
      // error — is recorded against the reference it was probing and the
      // sweep goes on. One EACCES must not erase a violation already found,
      // and must not read as a sweep that ran out of time.
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
      // All three references entered the denominator: the sweep finished.
      expect(result.referenceCount).toBe(3);
      expect(result.violations.map((v) => [v.kind, v.sequence])).toEqual([
        ['blob-missing', 1],
        ['unreadable-blob', 2],
      ]);
      expect(result.violations[1]?.detail).toContain('EACCES');
    },
    FS_TIMEOUT_MS,
  );

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
    // A reference nobody could parse was never probed, so it does not join the
    // denominator — it is reported instead.
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

  it(
    'BundleIntegrity_SettledStreamWithOnlyMalformedReferences_ReportsBothViolations',
    async () => {
      // The two arms interact here: the malformed entry is named, and because
      // nothing parseable survived it, the stream also settled while
      // referencing nothing. Reporting only one of the two would let a writer
      // hide a custody gap behind a parse error.
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

  it(
    'BundleIntegrity_AbortMidStream_LeavesTheRemainingEventsUnprobed',
    async () => {
      // Rejecting is only half the claim. A sweep that walked every remaining
      // event and threw at the end would satisfy `rejects` while doing all the
      // work the bound was supposed to prevent, so the probe count is the
      // assertion that actually pins "stops" rather than "discards".
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

      // ONE stream, so the between-streams check can never fire: whatever stops
      // this sweep has to be the per-event check.
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

  it(
    'BundleIntegrity_AbortMidEvent_LeavesTheRemainingReferencesUnprobed',
    async () => {
      // ONE stream holding ONE event, so neither the between-streams nor the
      // per-event check can fire once the walk is inside it: only the
      // per-reference check can stop the probes.
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

  it(
    'BundleIntegrity_AbortDuringAPendingProbe_AbandonsTheRead',
    async () => {
      // The checks between probes cannot reach a probe that is already in
      // flight. The signal is handed to the read itself, so a probe that
      // blocks — a slow or hung filesystem — is abandoned on cancellation
      // rather than holding the sweep open until it happens to return.
      const controller = new AbortController();
      const one = await seedRef('run-bundle:one', 'payload one');

      // A read that only ever settles through the signal it was handed.
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

      // A sweep that does not thread the signal never settles here; the race
      // turns that into a named failure instead of a suite timeout.
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

  it('BundleIntegrity_AbortBetweenStreams_LeavesTheRemainingStreamsUnqueried', async () => {
    // The sibling bound. Every stream here is empty, so no per-event check can
    // fire and only the between-streams check can stop the walk.
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

  it('BundleIntegrity_ReferenceFreeLedger_StillLetsATimerAbortIt', async () => {
    // Every abort case above arms the signal from inside the sweep's own
    // callbacks. A caller's TIMEOUT is a timer, and a timer needs the event
    // loop; a ledger with many streams and nothing to probe never awaits a
    // read that yields, so unless the walk yields on its own the flag is read
    // every stream and never set. This case arms the abort from a real timer
    // and asserts the walk stopped short.
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

  it('BundleIntegrity_SettlementEndpoints_AreTheLiteralTypeAndEpochTheseFixturesUse', () => {
    // The fixtures above spell the settlement type and the custody epoch as
    // literals. This is the one place they meet the constants the oracle and
    // the producer read, so a drift in either reddens here rather than
    // renaming the fixtures along with it.
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

  it('SettlementCustody_UnreadableStamps_AreCustodialNotExempt', () => {
    // `Number('')` is 0, `Number('1e0')` is 1, `Number(' 1')` is 1 and the
    // empty component of `1.` or `1..0` is 0: each of these converts to a
    // small integer that would sort before the epoch if the conversion were
    // trusted. A component that is not a run of decimal digits fails the read
    // outright, so the row is held to the rule rather than exempted by a stamp
    // nobody wrote deliberately.
    for (const stamp of ['', '1.', '.1', '1..0', '1e0', ' 1', '1 ', '0x1', '+1']) {
      expect(settlementCustody(settled(stamp)), JSON.stringify(stamp)).toBe('custodial');
    }
    // Stamps no numeric reading rescues either: a boundary pin, not a
    // discriminator between the text check and a numeric one.
    for (const stamp of ['-1', '1,1', 'latest']) {
      expect(settlementCustody(settled(stamp)), JSON.stringify(stamp)).toBe('custodial');
    }
  });
});
