// ─── Durable-gate-producer legacy-state backfill (upgrade-wedge fix) ─────────
//
// The migrated ladder gates all resolve their evidence binding through
// `activePhaseAttemptId`. The attempt stamp is minted only at workflow init /
// phase transition, so every workflow already in flight BEFORE the stamp
// shipped projects NO `phaseAttemptId` — and the pre-fix hard
// `ACTIVE_PHASE_ATTEMPT_REQUIRED` failure wedged such workflows out of EVERY
// migrated gate (`task_complete` unreachable). These tests pin the backfill:
// a legacy projection runs the gate successfully, bound to the deterministic
// `legacy-version:` derivation `allocatePhaseAttemptId` documents for
// pre-v2.12 states.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { allocatePhaseAttemptId } from '../../workflow/phase-attempt-id.js';
import { getInitialPhase } from '../../workflow/state-machine.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import {
  runAsTrustedCaller,
  seedActivePhaseAttempt,
} from '../../../tools/test-helpers/trusted-context.js';
import { runDurableGateProducer, type DurableGateScope } from './durable-gate-producer.js';

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
      /* best-effort */
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

function makeScope(fixture: Fixture, featureId: string): DurableGateScope {
  return {
    gateClass: 'static-analysis',
    featureId,
    // A task subject keeps the proof target off `git rev-parse` (no repo in
    // the temp dir) — the per-task shape every ladder gate dispatch uses.
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
  it('LegacyState_NoPhaseAttemptId_RunsGate_AndStampsDeterministicLegacyAttempt', async () => {
    const fixture = await makeFixture();
    await seedLegacyWorkflow(fixture.eventStore, FEATURE_ID);

    const result = await runAsTrustedCaller(fixture.stateDir, () =>
      runDurableGateProducer(makeScope(fixture, FEATURE_ID), passingProvider),
    );

    // Pre-fix this was `{ success: false, error: { code:
    // 'ACTIVE_PHASE_ATTEMPT_REQUIRED' } }` — the upgrade wedge.
    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);

    // The evidence is bound to the documented legacy derivation: the
    // `legacy-version:` predecessor form over the projection's CAS version
    // (`_version` = 1), with the current phase standing in for both edge
    // endpoints (no transition edge exists at gate time). For a built-in
    // workflow type the projection resolves the initial phase from the HSM
    // (`getInitialPhase`), NOT from the start event's `phase` field.
    const initialPhase = getInitialPhase('feature');
    const expected = allocatePhaseAttemptId(FEATURE_ID, initialPhase, initialPhase, undefined, 1);
    const stamped = await stampedAttemptIds(fixture.eventStore, FEATURE_ID);
    expect(stamped.length).toBeGreaterThan(0);
    for (const id of stamped) {
      expect(id).toMatch(/^phase-attempt:[0-9a-f]{64}$/);
      expect(id).toBe(expected);
    }
  });

  it('LegacyState_SameStateTwice_YieldsTheSameAttemptId', async () => {
    // Same store, two independent gate runs (fresh dispatch context each):
    // both must bind to ONE attempt — no per-run randomness.
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

    // And a SEPARATE store seeded with the identical legacy state derives the
    // identical id — the derivation is a pure function of (featureId, phase,
    // version), never of the store instance or wall clock.
    const other = await makeFixture();
    await seedLegacyWorkflow(other.eventStore, FEATURE_ID);
    const third = await runAsTrustedCaller(other.stateDir, () =>
      runDurableGateProducer(makeScope(other, FEATURE_ID), passingProvider),
    );
    expect(third.success).toBe(true);
    const otherStamped = await stampedAttemptIds(other.eventStore, FEATURE_ID);
    expect(otherStamped[0]).toBe(stamped[0]);
  });

  it('StampedState_PersistedAttemptWins_OverLegacyDerivation', async () => {
    // Precedence guard: once a workflow carries a real attempt stamp, the
    // backfill must never shadow it.
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
