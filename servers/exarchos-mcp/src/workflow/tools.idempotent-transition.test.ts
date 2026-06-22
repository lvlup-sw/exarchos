// ─── T73: Idempotent phase-transition is a no-op (CR #13 / INV-5b) ─────────
//
// `workflow.transition({ target })` delegates through `applyTransition` →
// `handleSet({ phase: target })`. The HSM guard short-circuits when
// `currentPhase === targetPhase` (returning `idempotent: true`, no events,
// no state mutation), but `handleSet` historically fell through to the
// checkpoint-counter increment + `updatedAt` write + CAS persistence, so a
// "no-op" still mutated `_version`, `updatedAt`, `_checkpoint.operations`,
// and `_checkpoint.lastActivityTimestamp`.
//
// INV-5b ("a no-op should be a no-op") requires:
//   • Zero `workflow.transition` events appended for same-target calls.
//   • Zero state-file mutation across two same-target calls (`_version`,
//     `updatedAt`, and the checkpoint counters all stable).
//   • Response envelope carries an explicit `idempotent: true` discriminator
//     so callers can distinguish "transitioned" from "already there".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit, handleTransition } from './tools.js';
import { EventStore } from '../event-store/store.js';
import { readStateFile } from './state-store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

let tmpDir: string;
const featureId = 'wf-idempotent-transition';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idempotent-transition-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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
  it('sameTargetTransition_DoesNotEmitWorkflowTransitionEvent', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    // `feature` workflow initialises at phase `plan`. Transitioning to
    // the same phase is the canonical no-op case.
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );
    expect(init.success).toBe(true);
    const initData = init.data as Record<string, unknown>;
    expect(initData.phase).toBe('plan');

    // Transition `plan → plan` twice. Both calls must succeed and
    // neither must append a `workflow.transition` event for the no-op.
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

    // INV-5b core assertion: zero `workflow.transition` events for the
    // same-target calls. The bug under fix appends none today either —
    // the HSM guard correctly short-circuits — but pinning this guards
    // against a regression that re-introduces emission downstream.
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
    // Explicit `idempotent: true` flag — the discriminator callers branch
    // on to distinguish a real transition from a no-op acknowledgement.
    expect(data.idempotent).toBe(true);
  });

  it('sameTargetTransition_DoesNotMutateStateFile', async () => {
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();

    await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );

    const stateFile = path.join(tmpDir, `${featureId}.state.json`);

    // Snapshot state immediately after init — this is the baseline a
    // no-op transition must preserve byte-for-byte across invocations.
    const beforeFirst = await readStateFile(stateFile);
    const beforeFirstUpdatedAt = beforeFirst.updatedAt;
    const beforeFirstVersion = beforeFirst._version;
    const beforeFirstCheckpoint = JSON.parse(
      JSON.stringify(beforeFirst._checkpoint),
    ) as Record<string, unknown>;

    // First same-target call.
    const first = await handleTransition(
      { featureId, target: 'plan' },
      tmpDir,
      eventStore,
    );
    expect(first.success).toBe(true);

    const afterFirst = await readStateFile(stateFile);
    const afterFirstCheckpoint = afterFirst._checkpoint as Record<string, unknown>;

    // INV-5b: the no-op must not bump `_version`, `updatedAt`, the
    // checkpoint operation counter, or the `lastActivityTimestamp`. The
    // bug today writes all four on every call; this is the failing
    // assertion that the GREEN short-circuit fixes.
    expect(afterFirst._version).toBe(beforeFirstVersion);
    expect(afterFirst.updatedAt).toBe(beforeFirstUpdatedAt);
    expect(afterFirstCheckpoint.operations).toBe(beforeFirstCheckpoint.operations);
    expect(afterFirstCheckpoint.lastActivityTimestamp).toBe(
      beforeFirstCheckpoint.lastActivityTimestamp,
    );

    // Second same-target call must also leave state untouched relative
    // to the post-first snapshot — proving the no-op is stable across
    // repeated invocations.
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
