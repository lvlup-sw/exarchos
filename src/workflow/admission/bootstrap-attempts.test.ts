// Exit-proof tests for P06-07 — bootstrapping existing workflows (Transition
// task 050). Proves the bootstrap half of the exit obligation "existing
// workflows gain attempts/requirements without mutable backfill":
//
//   (a) a pre-existing workflow gains an attempt + frozen requirements PURELY
//       by appended `admission.requirement-resolved` events;
//   (b) folding the stream up to the pre-bootstrap sequence yields the IDENTICAL
//       pre-bootstrap result — history is a byte-identical prefix;
//   (c) no `.state.json` mutable backfill occurs (only append events land);
//   (h) bootstrapping twice is idempotent — one attempt, never two.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../events/atomic-appender.js';
import type { DecideOnceStoredEvent } from '../../events/atomic-appender.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

import { runBootstrapAttempt } from './bootstrap-attempts.js';
import type { BootstrapAttemptInput } from './bootstrap-attempts.js';
import { foldAdmissionStream, digestKey } from './bootstrap-generation.js';
import { selectPhaseAttempt } from './phase-attempt-state.js';
import { buildRequirementContext } from './requirement-context.js';
import { createEvidenceSubject } from './evidence-subject.js';
import {
  OperationIdSchema,
  PhaseAttemptIdSchema,
  PolicyIdSchema,
  type ContentDigestV1,
} from './types.js';
import type { ResolvedGate } from '../phase-kind.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AT = '2026-08-03T12:00:00.000Z';
const digestA: ContentDigestV1 = { algorithm: 'sha256', value: 'a'.repeat(64) };

const phaseAttemptId = PhaseAttemptIdSchema.parse('phase-attempt-boot-001');
const subject = createEvidenceSubject(
  { kind: 'phase-attempt', phaseAttemptId },
  { phase: 'gather', attempt: 1 },
);

// GATHER carries no phase-kind gates, so the sole obligation is the single
// declared gate — one gate-evidence requirement, controlled and predictable.
const declaredGate: ResolvedGate = { family: 'ladder', gate: 'check_static_analysis' };
const requirementContext = buildRequirementContext({
  phaseKind: 'GATHER',
  risk: 'low',
  boundary: false,
  reliability: 'reliable',
  declaredGates: [declaredGate],
  policy: { minimumApprovals: 0, waivable: true },
});

const caller = {
  principalKind: 'agent',
  principalId: 'principal.orchestrator',
  role: 'orchestrator',
} as const;
const authorization = {
  authorizationId: 'authorization-001',
  posture: 'task-isolated',
  capabilityIds: ['capability.bootstrap'],
  resolverVersion: '1.0',
  resolvedAt: AT,
} as const;

function makeInput(
  appender: AtomicAppender,
  overrides: {
    streamId?: string;
    operationId?: string;
    expectedVersion?: number;
  } = {},
): BootstrapAttemptInput {
  return {
    appender,
    streamId: overrides.streamId ?? 'workflow.legacy-feature',
    operationId: OperationIdSchema.parse(overrides.operationId ?? 'operation-boot-1'),
    expectedVersion: overrides.expectedVersion ?? 0,
    phaseAttemptId,
    subject,
    requirementContext,
    policyId: PolicyIdSchema.parse('policy-001'),
    policyVersion: '1.0',
    policyDigest: digestA,
    resolvedAt: AT,
    caller,
    authorization,
  };
}

const foldOf = (events: readonly unknown[]) =>
  foldAdmissionStream(events as readonly DecideOnceStoredEvent[]);

describe('runBootstrapAttempt — event-sourced bootstrap over a real appender', () => {
  let stateDir: string;
  let appender: AtomicAppender;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'bootstrap-attempts-'));
    appender = new AtomicAppender({ stateDir });
  });

  afterEach(async () => {
    appender.getSqliteBackend()?.close();
    await rmrfAsync(stateDir);
  });

  const rawEvents = (streamId: string): DecideOnceStoredEvent[] =>
    (appender.getSqliteBackend()?.queryEvents(streamId) ??
      []) as unknown as DecideOnceStoredEvent[];

  it('Bootstrap_PreExistingWorkflow_GainsAttemptByAppendedEventsOnly', async () => {
    const streamId = 'workflow.gains-attempt';
    // A pre-existing workflow: prior lifecycle events, NO admission state.
    await appender.appendUnkeyed(streamId, [
      { type: 'workflow.started', data: { featureId: 'legacy' } },
      { type: 'noise.event', data: {} },
    ]);
    const preTail = rawEvents(streamId);
    expect(preTail).toHaveLength(2);
    // Nothing admission-shaped exists yet: the attempt has no frozen set.
    expect(selectPhaseAttempt(foldOf(preTail), phaseAttemptId)).toBeNull();

    const result = await runBootstrapAttempt(
      makeInput(appender, { streamId, expectedVersion: preTail.length }),
    );

    // (a) the attempt is established purely by appended requirement-resolved facts.
    expect(result.outcome).toBe('bootstrapped');
    if (result.outcome !== 'bootstrapped') throw new Error('unreachable');
    expect(result.frozenRequirements.length).toBeGreaterThan(0);
    expect(result.appendedEventTypes.every((t) => t === 'admission.requirement-resolved')).toBe(
      true,
    );
    expect(result.foldIntegrity).toBe('intact');

    const all = rawEvents(streamId);
    // The appended suffix is exactly the requirement-resolved facts; the two
    // pre-existing events are untouched and still lead the stream.
    expect(all.slice(0, 2).map((e) => e.type)).toEqual([
      'workflow.started',
      'noise.event',
    ]);
    expect(
      all.slice(2).every((e) => e.type === 'admission.requirement-resolved'),
    ).toBe(true);

    // Folding the FULL stream now reconstructs the attempt with a frozen set
    // whose digest matches the recorded projection.
    const attempt = selectPhaseAttempt(foldOf(all), phaseAttemptId);
    expect(attempt).not.toBeNull();
    expect(attempt?.frozenRequirementSet).not.toBeNull();
    expect(
      digestKey(attempt!.frozenRequirementSet!.requirementSetDigest),
    ).toBe(digestKey(result.requirementSetDigest));
  });

  it('Bootstrap_HistoricalReplay_ByteIdenticalBeforeAndAfter', async () => {
    const streamId = 'workflow.replay-invariant';
    await appender.appendUnkeyed(streamId, [
      { type: 'workflow.started', data: { featureId: 'legacy' } },
      { type: 'phase.entered', data: { phase: 'gather' } },
    ]);
    const prefixBefore = rawEvents(streamId);
    const preTailSeq = prefixBefore[prefixBefore.length - 1]!.sequence;
    const foldBefore = foldOf(prefixBefore);

    await runBootstrapAttempt(
      makeInput(appender, { streamId, expectedVersion: prefixBefore.length }),
    );

    const all = rawEvents(streamId);
    const prefixAfter = all.filter((e) => e.sequence <= preTailSeq);

    // (b) the pre-bootstrap prefix is byte-identical — bootstrap only appends.
    expect(prefixAfter.map((e) => ({ type: e.type, data: e.data }))).toEqual(
      prefixBefore.map((e) => ({ type: e.type, data: e.data })),
    );
    // Replaying that identical prefix yields the identical fold: the attempt was
    // NOT retroactively required to satisfy anything at the pre-bootstrap point.
    expect(foldOf(prefixAfter)).toEqual(foldBefore);
    expect(selectPhaseAttempt(foldOf(prefixAfter), phaseAttemptId)).toBeNull();
    // While the full stream DOES now carry the frozen set.
    expect(
      selectPhaseAttempt(foldOf(all), phaseAttemptId)?.frozenRequirementSet,
    ).not.toBeNull();
  });

  it('Bootstrap_NoMutableBackfill_WritesNoStateJson', async () => {
    const streamId = 'workflow.no-state-json';
    await appender.appendUnkeyed(streamId, [{ type: 'workflow.started', data: {} }]);

    await runBootstrapAttempt(
      makeInput(appender, { streamId, expectedVersion: 1 }),
    );

    // (c) bootstrap never retro-stamps a `.state.json` — no such file appears.
    const entries = await readdir(stateDir, { withFileTypes: true, recursive: true });
    const stateFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.state.json'))
      .map((entry) => entry.name);
    expect(stateFiles).toEqual([]);
  });

  it('Bootstrap_SameOperationId_IsIdempotentWithNoDuplicateEvents', async () => {
    const streamId = 'workflow.idem-same-op';
    await appender.appendUnkeyed(streamId, [{ type: 'workflow.started', data: {} }]);

    const first = await runBootstrapAttempt(
      makeInput(appender, { streamId, operationId: 'operation-idem-A', expectedVersion: 1 }),
    );
    const afterFirst = rawEvents(streamId).length;

    // Same operationId retry → decideOnce cache returns the identical result and
    // appends NOTHING more.
    const second = await runBootstrapAttempt(
      makeInput(appender, { streamId, operationId: 'operation-idem-A', expectedVersion: 1 }),
    );
    expect(second).toEqual(first);
    expect(rawEvents(streamId).length).toBe(afterFirst);
  });

  it('Bootstrap_DifferentOperationId_AlreadyBootstrappedNoOp', async () => {
    const streamId = 'workflow.idem-diff-op';
    await appender.appendUnkeyed(streamId, [{ type: 'workflow.started', data: {} }]);

    const first = await runBootstrapAttempt(
      makeInput(appender, { streamId, operationId: 'operation-idem-B', expectedVersion: 1 }),
    );
    expect(first.outcome).toBe('bootstrapped');
    const afterFirst = rawEvents(streamId);

    // A DIFFERENT operationId targeting the already-bootstrapped attempt is a
    // no-op: it detects the existing frozen set and appends nothing.
    const second = await runBootstrapAttempt(
      makeInput(appender, { streamId, operationId: 'operation-idem-C', expectedVersion: afterFirst.length }),
    );
    expect(second.outcome).toBe('already-bootstrapped');
    if (second.outcome !== 'already-bootstrapped') throw new Error('unreachable');
    expect(digestKey(second.requirementSetDigest)).toBe(
      digestKey(first.requirementSetDigest),
    );
    // (h) bootstrapping twice never forks the attempt: same event count, ONE
    // generation, ONE frozen set.
    const all = rawEvents(streamId);
    expect(all.length).toBe(afterFirst.length);
    const attempt = selectPhaseAttempt(foldOf(all), phaseAttemptId);
    expect(attempt?.requirementSetHistory).toHaveLength(1);
  });
});
