// The semantic plane's normal path, end to end through the real dispatcher:
// one `prepare`, one `settle`, and nothing in between.
//
// Every call goes through `dispatch` with a real caller identity and capability
// resolver, so admission, the economy cap and the reserved-type guard all apply
// exactly as they do for an agent. What this proves that no handler test can:
// the capsule a caller receives from `prepare` is one `settle` accepts when
// named by version, a retry of the same batch is answered from the claim, a
// capsule edited after compilation is refused, and the record that makes all of
// it trustworthy cannot be written by anyone but `prepare`.
//
// @oracle-sources: ../../src/verbs/prepare/handler.ts, the settlement record and bundle blobs counted out of the real event store and content-addressed store after each dispatched call

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { PREPARE_ECONOMY_BUDGET_TOKENS } from '../../src/verbs/prepare/economy.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-prepare-settle-acceptance';

let stateDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-settle-acceptance-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(stateDir);
});

function callerContext() {
  return {
    stateDir,
    eventStore,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'prepare-settle-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos']),
  };
}

async function call(tool: string, args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}> {
  return (await dispatch(tool, args, callerContext())) as {
    success: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
}

/** A feature workflow standing in `delegate` with three outstanding tasks, one waiting on another. */
async function seedDelegatingFeature(): Promise<void> {
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: {
      patch: {
        tasks: [
          { id: 'task-a', title: 'first', status: 'pending', blockedBy: [] },
          { id: 'task-b', title: 'second', status: 'pending', blockedBy: ['task-a'] },
          { id: 'task-c', title: 'third', status: 'pending', blockedBy: [] },
        ],
      },
    },
  });
}

function completedClaims(): Record<string, unknown>[] {
  return ['task-a', 'task-b', 'task-c'].map((taskId) => ({
    taskId,
    fields: { evidence: { type: 'test', output: 'green', passed: true } },
    evidence: [{ kind: 'test', ref: `run-${taskId}` }],
  }));
}

async function rowsOf(type: string): Promise<unknown[]> {
  return (await eventStore.query(STREAM)).filter((event) => event.type === type);
}

async function blobCount(): Promise<number> {
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
      if ((await stat(full)).isDirectory()) await walk(full);
      else count += 1;
    }
  };
  await walk(eventStore.bundleStore.root);
  return count;
}

interface PreparedReceipt {
  readonly capsuleVersion: number;
  readonly capsuleDigest: string;
  readonly capsule: Record<string, unknown> & {
    readonly graph: { readonly tasks: readonly { readonly taskId: string }[] };
    readonly contracts: Record<string, unknown>;
  };
}

describe('prepare then settle, through the dispatcher', () => {
  it('PrepareSettle_TheNormalPath_IsTwoCallsAndOneDecision', async () => {
    await seedDelegatingFeature();

    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const receipt = prepared.data as PreparedReceipt;
    expect(receipt.capsuleVersion).toBe(1);
    expect(receipt.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-a', 'task-b', 'task-c']);
    // The capsule arrives whole rather than capped: the harness runs the batch
    // from it, and a cut capsule would cost the call this path exists to save.
    // Measured here, against the budget it is declared under.
    const estimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(prepared.data), 'utf8') / 4);
    expect(estimatedTokens).toBeLessThan(PREPARE_ECONOMY_BUDGET_TOKENS);

    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: receipt.capsuleVersion,
      batchId: 'batch-1',
      claims: completedClaims(),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect((settled.data as { outcome: string }).outcome).toBe('settled');
    expect(await rowsOf('workflow.prepared')).toHaveLength(1);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
  });

  it('PrepareSettle_ARetriedBatch_IsAnsweredFromTheClaim', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const args = { action: 'settle', featureId: STREAM, capsuleVersion, batchId: 'batch-1', claims: completedClaims() };

    const first = await call('exarchos_orchestrate', args);
    const blobs = await blobCount();
    const retried = await call('exarchos_orchestrate', args);

    expect(retried.data).toEqual(first.data);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await blobCount()).toBe(blobs);
  });

  it('PrepareSettle_ACapsuleEditedAfterCompilation_IsRefused', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    const receipt = prepared.data as PreparedReceipt;
    // Admit an evidence kind the compilation never admitted, then submit the
    // edited document as if it were the capsule the work ran under.
    const edited = {
      ...receipt.capsule,
      contracts: { ...receipt.capsule.contracts, evidenceKinds: ['test', 'build', 'typecheck', 'manual', 'vibes'] },
    };

    const result = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsule: edited,
      batchId: 'batch-edited',
      claims: completedClaims(),
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPSULE_DIGEST_MISMATCH');
    expect(await rowsOf('execution.settled')).toEqual([]);
  });

  it('PrepareSettle_APreparedRecord_CannotBeAppendedByAnyoneButPrepare', async () => {
    // Settlement trusts this record. Appendable through the generic surface, it
    // would let any caller pin any capsule and then settle against it.
    const result = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: STREAM,
        event: {
          type: 'workflow.prepared',
          data: {
            operationId: 'prepare:forged',
            workflowId: STREAM,
            workflowType: 'feature',
            capsuleVersion: 1,
            definitionVersion: 'a'.repeat(64),
            designVersion: 'design-forged',
            capsuleDigest: 'f'.repeat(64),
            compilerVersion: 'forged',
            taskCount: 1,
            requestDigest: 'sha256:forged',
            bundleRefs: [
              { artifactId: 'run-bundle:prepared-capsule:forged:1', digest: { algorithm: 'sha256', value: 'f'.repeat(64) } },
            ],
          },
        },
      },
      callerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'workflow.prepared' },
    });
    expect(await rowsOf('workflow.prepared')).toEqual([]);
  });
});
