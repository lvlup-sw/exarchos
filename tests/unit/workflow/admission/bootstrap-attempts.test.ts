// Tests for the bootstrap of an existing workflow. A workflow with no admission
// state gains an attempt and frozen requirements only from appended
// `admission.requirement-resolved` events. The pre-bootstrap prefix stays
// byte-identical and folds to the same result. No `.state.json` file appears,
// and a second bootstrap of the same attempt appends nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../../src/events/atomic-appender.js';
import type { DecideOnceStoredEvent } from '../../../../src/events/atomic-appender.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

import { runBootstrapAttempt } from '../../../../src/workflow/admission/bootstrap-attempts.js';
import type { BootstrapAttemptInput } from '../../../../src/workflow/admission/bootstrap-attempts.js';
import { foldAdmissionStream, digestKey } from '../../../../src/workflow/admission/bootstrap-generation.js';
import { selectPhaseAttempt } from '../../../../src/workflow/admission/phase-attempt-state.js';
import { buildRequirementContext } from '../../../../src/workflow/admission/requirement-context.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import {
  OperationIdSchema,
  PhaseAttemptIdSchema,
  PolicyIdSchema,
  type ContentDigestV1,
} from '../../../../src/workflow/admission/types.js';
import type { ResolvedGate } from '../../../../src/workflow/phase-kind.js';

const AT = '2026-08-03T12:00:00.000Z';
const digestA: ContentDigestV1 = { algorithm: 'sha256', value: 'a'.repeat(64) };

const phaseAttemptId = PhaseAttemptIdSchema.parse('phase-attempt-boot-001');
const subject = createEvidenceSubject(
  { kind: 'phase-attempt', phaseAttemptId },
  { phase: 'gather', attempt: 1 },
);

/** GATHER has no phase-kind gates, so the one declared gate is the only obligation. */
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

  /**
   * A workflow with prior events and no admission state gains the attempt from
   * appended requirement-resolved events only. The prior events stay first.
   */
  it('Bootstrap_PreExistingWorkflow_GainsAttemptByAppendedEventsOnly', async () => {
    const streamId = 'workflow.gains-attempt';
    await appender.appendUnkeyed(streamId, [
      { type: 'workflow.started', data: { featureId: 'legacy' } },
      { type: 'noise.event', data: {} },
    ]);
    const preTail = rawEvents(streamId);
    expect(preTail).toHaveLength(2);
    expect(selectPhaseAttempt(foldOf(preTail), phaseAttemptId)).toBeNull();

    const result = await runBootstrapAttempt(
      makeInput(appender, { streamId, expectedVersion: preTail.length }),
    );

    expect(result.outcome).toBe('bootstrapped');
    if (result.outcome !== 'bootstrapped') throw new Error('unreachable');
    expect(result.frozenRequirements.length).toBeGreaterThan(0);
    expect(result.appendedEventTypes.every((t) => t === 'admission.requirement-resolved')).toBe(
      true,
    );
    expect(result.foldIntegrity).toBe('intact');

    const all = rawEvents(streamId);
    expect(all.slice(0, 2).map((e) => e.type)).toEqual([
      'workflow.started',
      'noise.event',
    ]);
    expect(
      all.slice(2).every((e) => e.type === 'admission.requirement-resolved'),
    ).toBe(true);

    const attempt = selectPhaseAttempt(foldOf(all), phaseAttemptId);
    expect(attempt).not.toBeNull();
    expect(attempt?.frozenRequirementSet).not.toBeNull();
    expect(
      digestKey(attempt!.frozenRequirementSet!.requirementSetDigest),
    ).toBe(digestKey(result.requirementSetDigest));
  });

  /**
   * Bootstrap only appends. The pre-bootstrap prefix folds to the same result,
   * so at that point the attempt has no frozen requirement set.
   */
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

    expect(prefixAfter.map((e) => ({ type: e.type, data: e.data }))).toEqual(
      prefixBefore.map((e) => ({ type: e.type, data: e.data })),
    );
    expect(foldOf(prefixAfter)).toEqual(foldBefore);
    expect(selectPhaseAttempt(foldOf(prefixAfter), phaseAttemptId)).toBeNull();
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

    const entries = await readdir(stateDir, { withFileTypes: true, recursive: true });
    const stateFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.state.json'))
      .map((entry) => entry.name);
    expect(stateFiles).toEqual([]);
  });

  /** A retry with the same operationId returns the cached `decideOnce` result and appends nothing. */
  it('Bootstrap_SameOperationId_IsIdempotentWithNoDuplicateEvents', async () => {
    const streamId = 'workflow.idem-same-op';
    await appender.appendUnkeyed(streamId, [{ type: 'workflow.started', data: {} }]);

    const first = await runBootstrapAttempt(
      makeInput(appender, { streamId, operationId: 'operation-idem-A', expectedVersion: 1 }),
    );
    const afterFirst = rawEvents(streamId).length;

    const second = await runBootstrapAttempt(
      makeInput(appender, { streamId, operationId: 'operation-idem-A', expectedVersion: 1 }),
    );
    expect(second).toEqual(first);
    expect(rawEvents(streamId).length).toBe(afterFirst);
  });

  /**
   * A different operationId finds the existing frozen set and appends nothing.
   * The attempt keeps one requirement set.
   */
  it('Bootstrap_DifferentOperationId_AlreadyBootstrappedNoOp', async () => {
    const streamId = 'workflow.idem-diff-op';
    await appender.appendUnkeyed(streamId, [{ type: 'workflow.started', data: {} }]);

    const first = await runBootstrapAttempt(
      makeInput(appender, { streamId, operationId: 'operation-idem-B', expectedVersion: 1 }),
    );
    expect(first.outcome).toBe('bootstrapped');
    const afterFirst = rawEvents(streamId);

    const second = await runBootstrapAttempt(
      makeInput(appender, { streamId, operationId: 'operation-idem-C', expectedVersion: afterFirst.length }),
    );
    expect(second.outcome).toBe('already-bootstrapped');
    if (second.outcome !== 'already-bootstrapped') throw new Error('unreachable');
    expect(digestKey(second.requirementSetDigest)).toBe(
      digestKey(first.requirementSetDigest),
    );
    const all = rawEvents(streamId);
    expect(all.length).toBe(afterFirst.length);
    const attempt = selectPhaseAttempt(foldOf(all), phaseAttemptId);
    expect(attempt?.requirementSetHistory).toHaveLength(1);
  });
});
