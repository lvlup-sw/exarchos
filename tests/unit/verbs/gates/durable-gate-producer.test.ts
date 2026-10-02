/**
 * Tests for the legacy-state backfill in `runDurableGateProducer`.
 *
 * The migrated ladder gates resolve their evidence binding through `activePhaseAttemptId`.
 * Only workflow init and phase transitions mint the attempt stamp, so a workflow from before v2.12 projects no `phaseAttemptId`.
 * For such a workflow, the gate still runs and binds to the `legacy-version:` attempt id from `allocatePhaseAttemptId`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { allocatePhaseAttemptId } from '../../../../src/workflow/phase-attempt-id.js';
import { getInitialPhase } from '../../../../src/workflow/state-machine.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import {
  runAsTrustedCaller,
  seedActivePhaseAttempt,
} from '../../../../tools/test-helpers/trusted-context.js';
import { runDurableGateProducer, type DurableGateScope } from '../../../../src/verbs/gates/durable-gate-producer.js';

const FEATURE_ID = 'legacy-backfill-feature';

interface Fixture {
  readonly stateDir: string;
  readonly eventStore: EventStore;
}

const stateDirs: string[] = [];

afterEach(() => {
  for (const dir of stateDirs.splice(0)) {
    try {
      rmrf(dir);
    } catch {
    }
  }
});

async function makeFixture(): Promise<Fixture> {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'durable-gate-producer-'));
  stateDirs.push(stateDir);
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, eventStore };
}

/** A pre-v2.12 workflow: started, but the start event carries NO attempt stamp. */
async function seedLegacyWorkflow(eventStore: EventStore, featureId: string): Promise<void> {
  await eventStore.append(featureId, {
    type: 'workflow.started',
    data: { featureId, workflowType: 'feature', phase: 'delegate' },
  });
}

/** The task subject keeps the proof target off `git rev-parse`, because the temporary directory holds no repo. */
function makeScope(fixture: Fixture, featureId: string): DurableGateScope {
  return {
    gateClass: 'static-analysis',
    featureId,
    taskId: 'task-legacy-1',
    repoRoot: fixture.stateDir,
    stateDir: fixture.stateDir,
    eventStore: fixture.eventStore,
  };
}

function passingProvider(): Promise<ToolResult> {
  return Promise.resolve({ success: true, data: { passed: true } });
}

async function stampedAttemptIds(eventStore: EventStore, featureId: string): Promise<string[]> {
  const events = await eventStore.query(featureId, { type: 'gate.executed' });
  return events.map((event) => {
    const data = event.data as
      | { details?: { phaseAttemptId?: unknown } }
      | undefined;
    const id = data?.details?.phaseAttemptId;
    return typeof id === 'string' ? id : '';
  });
}

describe('runDurableGateProducer — pre-v2.12 legacy-state backfill', () => {
  /**
   * The expected id uses the `legacy-version:` form over the projection version (`_version` = 1), with the current phase as both edge endpoints.
   * For a built-in workflow type, the projection takes the initial phase from `getInitialPhase`, not from the start event.
   */
  it('LegacyState_NoPhaseAttemptId_RunsGate_AndStampsDeterministicLegacyAttempt', async () => {
    const fixture = await makeFixture();
    await seedLegacyWorkflow(fixture.eventStore, FEATURE_ID);

    const result = await runAsTrustedCaller(fixture.stateDir, () =>
      runDurableGateProducer(makeScope(fixture, FEATURE_ID), passingProvider),
    );

    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);

    const initialPhase = getInitialPhase('feature');
    const expected = allocatePhaseAttemptId(FEATURE_ID, initialPhase, initialPhase, undefined, 1);
    const stamped = await stampedAttemptIds(fixture.eventStore, FEATURE_ID);
    expect(stamped.length).toBeGreaterThan(0);
    for (const id of stamped) {
      expect(id).toMatch(/^phase-attempt:[0-9a-f]{64}$/);
      expect(id).toBe(expected);
    }
  });

  /**
   * Two runs on one store and one run on a second store with the same legacy state all bind to one attempt id.
   * The derivation depends only on the feature id, the phase, and the version.
   */
  it('LegacyState_SameStateTwice_YieldsTheSameAttemptId', async () => {
    const fixture = await makeFixture();
    await seedLegacyWorkflow(fixture.eventStore, FEATURE_ID);

    const first = await runAsTrustedCaller(fixture.stateDir, () =>
      runDurableGateProducer(makeScope(fixture, FEATURE_ID), passingProvider),
    );
    const second = await runAsTrustedCaller(fixture.stateDir, () =>
      runDurableGateProducer(makeScope(fixture, FEATURE_ID), passingProvider),
    );
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const stamped = await stampedAttemptIds(fixture.eventStore, FEATURE_ID);
    expect(new Set(stamped).size).toBe(1);

    const other = await makeFixture();
    await seedLegacyWorkflow(other.eventStore, FEATURE_ID);
    const third = await runAsTrustedCaller(other.stateDir, () =>
      runDurableGateProducer(makeScope(other, FEATURE_ID), passingProvider),
    );
    expect(third.success).toBe(true);
    const otherStamped = await stampedAttemptIds(other.eventStore, FEATURE_ID);
    expect(otherStamped[0]).toBe(stamped[0]);
  });

  /** When the workflow has a persisted attempt stamp, the backfill does not replace it. */
  it('StampedState_PersistedAttemptWins_OverLegacyDerivation', async () => {
    const fixture = await makeFixture();
    const persisted = await seedActivePhaseAttempt(fixture.eventStore, FEATURE_ID);

    const result = await runAsTrustedCaller(fixture.stateDir, () =>
      runDurableGateProducer(makeScope(fixture, FEATURE_ID), passingProvider),
    );
    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);

    const stamped = await stampedAttemptIds(fixture.eventStore, FEATURE_ID);
    expect(stamped.length).toBeGreaterThan(0);
    const initialPhase = getInitialPhase('feature');
    const legacyDerived = allocatePhaseAttemptId(FEATURE_ID, initialPhase, initialPhase, undefined, 1);
    for (const id of stamped) {
      expect(id).toBe(persisted);
      expect(id).not.toBe(legacyDerived);
    }
  });
});
