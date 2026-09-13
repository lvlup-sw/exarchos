// `prepare` end to end, against a real event store and a real content-addressed
// bundle store in a temporary directory.
//
// The load-bearing assertions are the ones no test of the pure compiler can
// make: that the record REFERENCES bytes actually in custody and those bytes
// read back as the capsule the receipt returned, that a retry is answered from
// the durable claim, and that every refusal leaves the store untouched.
//
// @oracle-sources: ../../../../src/verbs/prepare/handler.ts, the prepared bundle read back out of the content-addressed store and re-digested rather than compared with the in-process capsule

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { capsuleDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { deriveMcpCallerIdentity } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { WorkflowPreparedData } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import type { CatalogInvariant } from '../../../../src/verbs/prepare/bind-authority.js';
import { handlePrepare } from '../../../../src/verbs/prepare/handler.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import { findPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import type { PreparedCapsuleReceipt } from '../../../../src/verbs/prepare/types.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-prepare-unit';
const COMPILED_AT = '2026-09-12T00:00:00.000Z';

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-unit-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

function correlation(): ReturnType<typeof mintDispatchContext> {
  deriveMcpCallerIdentity({ sessionId: 'prepare-fixture' });
  return mintDispatchContext(undefined);
}

async function prepare(
  raw: Record<string, unknown>,
  catalog: readonly CatalogInvariant[] = [],
): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handlePrepare(raw, stateDir, wiring(), { catalogInvariants: () => catalog, now: () => COMPILED_AT }),
  );
}

function receiptOf(result: ToolResult): PreparedCapsuleReceipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!result.success) throw new Error('unreachable');
  return result.data as unknown as PreparedCapsuleReceipt;
}

interface SeedTask {
  readonly id: string;
  readonly status: string;
  readonly blockedBy?: readonly string[];
}

/** A feature workflow standing in `delegate` with the given plan. */
async function seedDelegatingFeature(tasks: readonly SeedTask[], streamId = STREAM): Promise<void> {
  await store.append(streamId, { type: 'workflow.started', data: { featureId: streamId, workflowType: 'feature' } });
  await store.append(streamId, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await store.append(streamId, {
    type: 'state.patched',
    data: {
      patch: {
        'artifacts.design': 'docs/specs/prepare-unit.md',
        tasks: tasks.map((t) => ({ id: t.id, title: `title of ${t.id}`, status: t.status, blockedBy: t.blockedBy ?? [] })),
      },
    },
  });
}

async function preparedRows(streamId = STREAM): Promise<Record<string, unknown>[]> {
  const events = await store.query(streamId);
  return events.filter((e) => e.type === 'workflow.prepared').map((e) => e.data as Record<string, unknown>);
}

async function bundleBlobCount(): Promise<number> {
  const root = store.bundleStore.root;
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else count += 1;
    }
  };
  await walk(root);
  return count;
}

const PLAN: readonly SeedTask[] = [
  { id: 'T-1', status: 'complete' },
  { id: 'T-2', status: 'pending', blockedBy: ['T-1'] },
  { id: 'T-3', status: 'pending' },
  { id: 'T-4', status: 'pending', blockedBy: ['T-3'] },
];

describe('prepare — the compilation endpoint', () => {
  it('Prepare_ADelegatingFeature_RecordsOneCapsuleWhoseBytesAreInCustody', async () => {
    await seedDelegatingFeature(PLAN);
    const receipt = receiptOf(await prepare({ featureId: STREAM }));

    expect(receipt.capsuleVersion).toBe(1);
    expect(receipt.workflowId).toBe(STREAM);
    expect(receipt.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['T-2', 'T-3', 'T-4']);
    expect(receipt.capsule.graph.dependencies).toEqual([{ from: 'T-3', to: 'T-4' }]);
    expect(receipt.capsuleDigest).toBe(capsuleDigest(receipt.capsule));
    expect(receipt.definitionVersion).toBe(lowerBuiltInDefinition('feature')?.definitionVersion);

    const rows = await preparedRows();
    expect(rows).toHaveLength(1);
    const record = WorkflowPreparedData.parse(rows[0]);
    expect(record.capsuleDigest).toBe(receipt.capsuleDigest);
    expect(record.taskCount).toBe(3);

    // Read back out of custody and re-digested: the record pins bytes that
    // really decode to the capsule the caller was handed.
    const found = await findPreparedCapsule(wiring(), STREAM, 1);
    expect(found.found).toBe(true);
    if (found.found) {
      expect(found.capsule).toEqual(receipt.capsule);
      expect(capsuleDigest(found.capsule)).toBe(record.capsuleDigest);
    }
  });

  it('Prepare_ARetryWithUnchangedInputs_ReturnsTheRecordedCapsuleAndAppendsNothing', async () => {
    await seedDelegatingFeature(PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const blobs = await bundleBlobCount();
    expect(blobs).toBe(1);

    const retried = receiptOf(await prepare({ featureId: STREAM }));
    expect(retried).toEqual(first);
    expect(await preparedRows()).toHaveLength(1);
    expect(await bundleBlobCount()).toBe(blobs);
  });

  it('Prepare_ChangedInputs_CompileTheNextVersion', async () => {
    await seedDelegatingFeature(PLAN);
    receiptOf(await prepare({ featureId: STREAM }));
    await store.append(STREAM, { type: 'state.patched', data: { patch: { 'tasks[1].status': 'complete' } } });

    const next = receiptOf(await prepare({ featureId: STREAM }));
    expect(next.capsuleVersion).toBe(2);
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['T-3', 'T-4']);
    expect(await preparedRows()).toHaveLength(2);
  });

  it('Prepare_ARegisteredCatalog_IsBoundIntoTheAuthority', async () => {
    await seedDelegatingFeature(PLAN);
    const receipt = receiptOf(await prepare({ featureId: STREAM }, [{ id: 'INV-9', summary: 'catalog statement' }]));
    expect(receipt.capsule.authority.invariants.map((i) => i.id)).toContain('INV-9');
  });

  describe('refusals happen before any effect', () => {
    async function expectRefused(result: ToolResult, code: string): Promise<void> {
      expect(result.success, JSON.stringify(result)).toBe(false);
      if (!result.success) expect(result.error.code).toBe(code);
      expect(await preparedRows()).toEqual([]);
      expect(await bundleBlobCount()).toBe(0);
    }

    it('Prepare_NoWorkflow_IsRefused', async () => {
      await expectRefused(await prepare({ featureId: STREAM }), 'WORKFLOW_NOT_FOUND');
    });

    it('Prepare_AWorkflowTypeWithoutADelegationBatch_IsRefused', async () => {
      await store.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'debug' } });
      await expectRefused(await prepare({ featureId: STREAM }), 'WORKFLOW_TYPE_UNSUPPORTED');
    });

    it('Prepare_AFeatureNotYetDelegating_IsRefused', async () => {
      await store.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
      await expectRefused(await prepare({ featureId: STREAM }), 'PHASE_NOT_PREPARABLE');
    });

    it('Prepare_APlanWithNothingOutstanding_IsRefused', async () => {
      await seedDelegatingFeature([{ id: 'T-1', status: 'complete' }]);
      await expectRefused(await prepare({ featureId: STREAM }), 'NOTHING_TO_PREPARE');
    });

    it('Prepare_ATaskWaitingOnATaskThePlanLacks_IsRefused', async () => {
      await seedDelegatingFeature([{ id: 'T-1', status: 'pending', blockedBy: ['T-ghost'] }]);
      await expectRefused(await prepare({ featureId: STREAM }), 'UNKNOWN_DEPENDENCY');
    });

    it('Prepare_ACyclicPlan_IsRefusedAsUnsound', async () => {
      await seedDelegatingFeature([
        { id: 'T-1', status: 'pending', blockedBy: ['T-2'] },
        { id: 'T-2', status: 'pending', blockedBy: ['T-1'] },
      ]);
      await expectRefused(await prepare({ featureId: STREAM }), 'CAPSULE_UNSOUND');
    });

    it('Prepare_NoSubject_IsRefused', async () => {
      await expectRefused(await prepare({}), 'INVALID_INPUT');
    });
  });
});
