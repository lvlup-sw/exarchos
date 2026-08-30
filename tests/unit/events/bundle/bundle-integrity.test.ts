/**
 * checkRunBundleIntegrity — the verdict logic, exercised over a fake event
 * source so every arm is reachable without a substrate.
 *
 * The seeded violations are the point of this file. A resolvability check that
 * has never been shown to go red is a check whose green means nothing, so each
 * failing arm here starts from a passing configuration and breaks exactly one
 * thing: one blob deleted, one blob corrupted, one settled stream stripped of
 * its references, one reference made unparseable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  checkRunBundleIntegrity,
  type BundleEventSource,
} from '../../../../src/events/bundle/integrity.js';
import { RunBundleStore } from '../../../../src/events/bundle/run-bundle-store.js';
import {
  BUNDLE_REF_FIELD,
  SETTLED_EVENT_TYPES,
} from '../../../../src/events/bundle/digest-references.js';
import { ArtifactIdSchema } from '../../../../src/workflow/admission/types.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const FS_TIMEOUT_MS = 15_000;
const SETTLED_TYPE = SETTLED_EVENT_TYPES[0] ?? 'orchestrate.intent_executed';

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
): WorkflowEvent {
  return {
    streamId,
    sequence,
    type,
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    schemaVersion: '1.0',
    ...(data === undefined ? {} : { data }),
  };
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
          event('feat-a', 2, SETTLED_TYPE, { [BUNDLE_REF_FIELD]: [one, two] }),
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
    'BundleIntegrity_SettledStreamWithZeroReferences_IsAViolationNotEmpty',
    async () => {
      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started'),
          event('feat-a', 2, SETTLED_TYPE, { leafId: 'some-leaf' }),
        ],
      });

      const result = await checkRunBundleIntegrity(source, store);

      // Referencing nothing is the cheapest way to pass a resolvability check.
      // Settlement without custody must therefore be red, not 'empty'.
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.referenceCount).toBe(0);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.kind).toBe('settled-stream-without-references');
      expect(result.violations[0]?.sequence).toBe(2);
    },
    FS_TIMEOUT_MS,
  );

  it(
    'BundleIntegrity_SettledStreamWithAResolvableReference_IsClear',
    async () => {
      // The sibling of the case above: the same settled stream passes once it
      // actually references bytes, so the violation there is about the missing
      // custody rather than about settlement itself.
      const one = await seedRef('run-bundle:settled', 'settled payload');
      const source = fakeSource({
        'feat-a': [
          event('feat-a', 1, 'workflow.started'),
          event('feat-a', 2, SETTLED_TYPE, { [BUNDLE_REF_FIELD]: [one] }),
        ],
      });

      const result = await checkRunBundleIntegrity(source, store);

      expect(result.ok === true ? result.referenceCount : -1).toBe(1);
      expect(result.ok).toBe(true);
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
});
