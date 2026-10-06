// Tests for the design version of a workflow stream: the fold over the revision rows, and the id format.
//
// Each revision row here comes from a real decision round of `settle` on a real event store. No
// test appends a revision row, because `settle` is the one writer of that row. One case damages a
// copy of a real row in memory, to show that the fold refuses it. The claimed task is complete on
// the stream before each batch, so a decision round settles with no verification segment.
//
// @oracle-sources: ../../../../src/verbs/prepare/design-version.ts, the revision rows that real decision rounds of settle leave on a real event store and that each case reads back by type

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  baseValidCapsule,
  baseValidDefinition,
} from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { productionExecuteDeps } from '../../../../src/verbs/execute/executor.js';
import {
  DESIGN_REVISED_TYPE,
  designVersionId,
  designVersionOf,
} from '../../../../src/verbs/prepare/design-version.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-design-version-unit';
const CAPSULE_VERSION = 7;

let stateDir: string;
let store: EventStore;

function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

/** The base capsule with its one allowed deviation kind listed as material. */
function materialCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    contracts: {
      ...base.contracts,
      deviationEnvelope: {
        ...base.contracts.deviationEnvelope,
        materialDeviationKinds: [...base.contracts.deviationEnvelope.allowedDeviationKinds],
      },
    },
  };
}

beforeEach(async () => {
  stateDir = makeTempDir('design-version-unit-');
  store = new EventStore(stateDir);
  await store.initialize();
  await commitPreparedCapsule(wiring(), {
    streamId: STREAM,
    operationId: 'seed:prepared',
    requestDigest: 'sha256:seed-prepared',
    workflowType: 'feature',
    capsule: materialCapsule(),
    definition: WorkflowDefinitionV1Schema.parse(baseValidDefinition()),
  });
  await store.append(STREAM, { type: 'task.completed', data: { taskId: 'task-verify', verified: false } });
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

async function settle(raw: Record<string, unknown>): Promise<SettlementReceipt> {
  const result = await handleSettle({ featureId: STREAM, capsuleVersion: CAPSULE_VERSION, ...raw }, stateDir, wiring(), {
    execute: productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'),
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  return result.data as SettlementReceipt;
}

/** Submits one batch with one material deviation, which the envelope holds for a decision. */
async function hold(batchId: string): Promise<SettlementReceipt> {
  const held = await settle({
    batchId,
    claims: [{ taskId: 'task-verify', fields: { passed: true }, evidence: [] }],
    deviations: [{ deviationKind: 'invalidated-assumption', statement: `an assumption of ${batchId} did not hold` }],
  });
  expect(held.outcome).toBe('deviation-pending');
  return held;
}

/** Decides each deviation that a held batch waits on, through the decision round of that batch. */
async function decide(held: SettlementReceipt, decision: 'accepted' | 'rejected'): Promise<SettlementReceipt> {
  return settle({
    batchId: held.capsule.batchId,
    decisions: (held.pendingDeviations ?? []).map(({ deviationId }) => ({
      deviationId,
      decision,
      actor: 'human:reviewer',
      rationale: 'decided for the design version tests',
    })),
  });
}

describe('the design version of a workflow stream', () => {
  /**
   * The empty stream is at version 1. So is a stream whose decision round rejected its material
   * deviation: it holds a decision row and no revision row.
   */
  it('DesignVersion_AStreamWithNoRevision_IsOne', async () => {
    expect(designVersionOf([])).toBe(1);

    const refused = await decide(await hold('batch-refused'), 'rejected');
    expect(refused.outcome).toBe('rejected');
    const events = await store.query(STREAM);
    const types = events.map((event) => event.type);
    expect(types).toContain('deviation.decided');
    expect(types).not.toContain(DESIGN_REVISED_TYPE);
    expect(designVersionOf(events)).toBe(1);
  });

  /**
   * Two decision rounds leave two rows. The stream up to the first row is at version 2. The stream
   * without the first row is still at version 3, so the fold reads the row and does not count rows.
   */
  it('DesignVersion_AStreamWithRevisions_IsTheLatestRevisionsVersion', async () => {
    const first = await decide(await hold('batch-first'), 'accepted');
    const second = await decide(await hold('batch-second'), 'accepted');
    expect(first.outcome).toBe('settled');
    expect(first.designRevision?.nextDesignVersion).toBe(2);
    expect(second.designRevision?.nextDesignVersion).toBe(3);

    const events = await store.query(STREAM);
    const rows = events.filter((event) => event.type === DESIGN_REVISED_TYPE);
    expect(rows).toHaveLength(2);
    expect(designVersionOf(events)).toBe(3);

    const firstRow = rows[0];
    if (firstRow === undefined) throw new Error('the stream holds no revision row');
    expect(designVersionOf(events.slice(0, events.indexOf(firstRow) + 1))).toBe(2);
    expect(designVersionOf(events.filter((event) => event !== firstRow))).toBe(3);
  });

  /**
   * The damaged row is the real row of the stream with its next version removed. A fold that skips
   * the row reads version 1, and the next revision then takes a version that the stream holds.
   */
  it('DesignVersion_ARevisionRowTheSchemaRefuses_ThrowsAndIsNotSkipped', async () => {
    await decide(await hold('batch-first'), 'accepted');
    const events = await store.query(STREAM);
    const row = events.find((event) => event.type === DESIGN_REVISED_TYPE);
    if (row === undefined) throw new Error('the stream holds no revision row');
    const { nextDesignVersion, ...withoutVersion } = row.data ?? {};
    expect(nextDesignVersion).toBe(2);

    const damaged = events.map((event) => (event === row ? { ...event, data: withoutVersion } : event));
    expect(() => designVersionOf(damaged)).toThrow(/nextDesignVersion/);
  });

  it('DesignVersion_TheIdFormat_IsThePrefixAndTheNumber', () => {
    expect(designVersionId(1)).toBe('design-v1');
    expect(designVersionId(2)).toBe('design-v2');
    expect(designVersionId(12)).toBe('design-v12');
  });
});
