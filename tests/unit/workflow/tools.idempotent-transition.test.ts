// Tests that a transition to the current phase is a no-op. A same-target `handleTransition` returns
// `idempotent: true`, appends no `workflow.transition` event, and leaves the state file unchanged.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit, handleTransition } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import { readStateFile } from '../../../src/workflow/state-store.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;
const featureId = 'wf-idempotent-transition';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idempotent-transition-'));
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

async function countEvents(
  store: EventStore,
  type: string,
  filter?: (e: WorkflowEvent) => boolean,
): Promise<number> {
  const events = await store.query(featureId, { type: type as never });
  return filter ? events.filter(filter).length : events.length;
}

describe('handleTransition idempotent same-target no-op (T73, CR #13)', () => {
  /** The test guards against a later step in the path that appends a `workflow.transition` event for the no-op. */
  it('sameTargetTransition_DoesNotEmitWorkflowTransitionEvent', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);
    const initData = init.data as Record<string, unknown>;
    expect(initData.phase).toBe('plan');

    const first = await handleTransition(
      { featureId, target: 'plan' },
      tmpDir,
      eventStore,
    );
    expect(first.success).toBe(true);

    const second = await handleTransition(
      { featureId, target: 'plan' },
      tmpDir,
      eventStore,
    );
    expect(second.success).toBe(true);

    const transitions = await countEvents(eventStore, 'workflow.transition');
    expect(transitions).toBe(0);
  });

  it('sameTargetTransition_ReturnsIdempotentDiscriminator', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );

    const result = await handleTransition(
      { featureId, target: 'plan' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');
    expect(data.idempotent).toBe(true);
  });

  /** Two same-target calls must leave `_version`, `updatedAt` and `_checkpoint.lastActivityTimestamp` unchanged. */
  it('sameTargetTransition_DoesNotMutateStateFile', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );

    const stateFile = path.join(tmpDir, `${featureId}.state.json`);

    const beforeFirst = await readStateFile(stateFile);
    const beforeFirstUpdatedAt = beforeFirst.updatedAt;
    const beforeFirstVersion = beforeFirst._version;
    const beforeFirstCheckpoint = JSON.parse(
      JSON.stringify(beforeFirst._checkpoint),
    ) as Record<string, unknown>;

    const first = await handleTransition(
      { featureId, target: 'plan' },
      tmpDir,
      eventStore,
    );
    expect(first.success).toBe(true);

    const afterFirst = await readStateFile(stateFile);
    const afterFirstCheckpoint = afterFirst._checkpoint as Record<string, unknown>;

    expect(afterFirst._version).toBe(beforeFirstVersion);
    expect(afterFirst.updatedAt).toBe(beforeFirstUpdatedAt);
    expect(afterFirstCheckpoint.operations).toBe(beforeFirstCheckpoint.operations);
    expect(afterFirstCheckpoint.lastActivityTimestamp).toBe(
      beforeFirstCheckpoint.lastActivityTimestamp,
    );

    const second = await handleTransition(
      { featureId, target: 'plan' },
      tmpDir,
      eventStore,
    );
    expect(second.success).toBe(true);

    const afterSecond = await readStateFile(stateFile);
    const afterSecondCheckpoint = afterSecond._checkpoint as Record<string, unknown>;
    expect(afterSecond._version).toBe(afterFirst._version);
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
    expect(afterSecondCheckpoint.operations).toBe(afterFirstCheckpoint.operations);
    expect(afterSecondCheckpoint.lastActivityTimestamp).toBe(
      afterFirstCheckpoint.lastActivityTimestamp,
    );
  });
});
