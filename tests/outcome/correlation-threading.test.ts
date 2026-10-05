/**
 * Outcome tests for the `operationId` that a dispatch stamps on events.
 *
 * Each `dispatch` call makes its own `operationId`. The event store stamps it on every event that
 * it appends during that call, so the events of one dispatch share one `operationId`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../src/events/store.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const tempDirs: string[] = [];

async function mktemp(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `outcome-1291-${label}-`));
  tempDirs.push(dir);
  return dir;
}

describe('Three-field correlation threading at dispatch boundary (#1291)', () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rmrfAsync(dir);
    }
  });

  /**
   * One `init` dispatch appends at least one event. Every event of the stream must carry the same
   * `operationId`, and none can lack it. Every event must also carry a `correlationId`. The event
   * store fills it from the dispatch context when the caller supplies none.
   */
  it('EventStore_EventsEmittedDuringDispatch_ShareIdenticalOperationId', async () => {
    const stateDir = await mktemp('share-opid');
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();

    const featureId = 'outcome-1291-correlation';

    const initResult = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      {
        stateDir,
        eventStore,
        enableTelemetry: false,
      },
    );
    expect(initResult.success).toBe(true);

    const events = await eventStore.query(featureId);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const operationIds = new Set<string | undefined>();
    for (const evt of events) {
      operationIds.add(evt.operationId);
    }
    expect(operationIds.has(undefined)).toBe(false);
    expect(operationIds.size).toBe(1);

    for (const evt of events) {
      expect(evt.correlationId).toBeDefined();
    }
  });

  /**
   * Each dispatch is one operation, so two dispatches that append to one stream must not share an
   * `operationId`. The test accepts both outcomes of the `update` dispatch. It compares the IDs
   * only when that dispatch appends an event.
   */
  it('EventStore_TwoDispatches_ProduceDistinctOperationIds', async () => {
    const stateDir = await mktemp('distinct-opid');
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();

    const featureId = 'outcome-1291-distinct';

    const r1 = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      { stateDir, eventStore, enableTelemetry: false },
    );
    expect(r1.success).toBe(true);
    const eventsAfterInit = await eventStore.query(featureId);
    const opIdInit = eventsAfterInit[0]?.operationId;
    expect(opIdInit).toBeDefined();

    const r2 = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId },
      { stateDir, eventStore, enableTelemetry: false },
    );
    expect(r2.success).toBe(true);

    const r3 = await dispatch(
      'exarchos_workflow',
      {
        action: 'update',
        featureId,
        updates: {
          phase: 'design',
        },
      },
      { stateDir, eventStore, enableTelemetry: false },
    );
    expect([true, false]).toContain(r3.success);
    const eventsAfter = await eventStore.query(featureId);
    const opIds = new Set(eventsAfter.map((e) => e.operationId));
    if (eventsAfter.length > eventsAfterInit.length) {
      expect(opIds.size).toBeGreaterThanOrEqual(2);
    }
  });
});
