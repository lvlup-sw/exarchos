// ─── `task_complete` admits on provenance, not on a name ────────────────────
//
// There are two ways to claim that `task_complete`'s one blocking obligation
// (`static-analysis`) is discharged: caller-supplied `evidence`, and a
// `gate.executed` row on the stream. The evidence path is capability-gated — a
// blocking gate is unbuyable, an advisory one needs a transport-derived
// operator role that no caller can self-assert.
//
// The event path is reachable by every role, because `exarchos_event.append`
// is. So the bar cannot come from the caller; it has to come from the ROW. The
// durable gate runner mints its signal from the `admission.evidence-recorded`
// row it just persisted and stamps that row's `evidenceId` into `details`, so a
// runner-minted row cites proof that RESOLVES — to a passing record bound to
// this very task. Every other row is the governed describing its own
// compliance, and is held to the operator bar the evidence path enforces.
//
// The event type stays unreserved on purpose: the shepherd skill documents an
// agent appending `gate.executed` at `layer: "CI"` to record what CI observed.
// That append stays legal. It simply stops discharging a per-task obligation it
// was never about.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { EventStore } from '../../src/events/store.js';
import { handleEventAppend } from '../../src/events/tools.js';
import type { SupportedGateClass } from '../../src/verbs/gates/gate-provider-registry.js';
import { handleTaskComplete, resetModuleEventStore } from '../../src/verbs/tasks/tools.js';
import { resetMaterializerCache } from '../../src/projections/views/tools.js';
import { ContentAddressedStore } from '../../src/storage/artifacts/content-addressed-store.js';
import { runGate } from '../../src/verbs/gates/gate-runner.js';
import { createEvidenceSubject } from '../../src/workflow/admission/evidence-subject.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../src/dispatch/dispatch-context.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import {
  dispatch,
  type DispatchContext as HandlerContext,
} from '../../src/dispatch/core/dispatch.js';
import {
  runAsTrustedCaller,
  withTrustedCaller,
} from '../../tools/test-helpers/trusted-context.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const GATE = 'static-analysis';

let tempDir: string;
let store: EventStore;
let artifactStore: ContentAddressedStore;

beforeEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  tempDir = await mkdtemp(path.join(tmpdir(), 'admission-provenance-'));
  store = new EventStore(tempDir);
  await store.initialize();
  artifactStore = new ContentAddressedStore(path.join(tempDir, 'artifacts'));
});

afterEach(async () => {
  store.close();
  resetModuleEventStore();
  resetMaterializerCache();
  await rmrfAsync(tempDir);
});

/**
 * Run `fn` as a DELEGATED AGENT — the posture a governed implementer holds.
 *
 * Composed from the same production primitives as `runAsTrustedCaller`
 * (`deriveMcpCallerIdentity` + `snapshotCallerAuthorization` +
 * `mintDispatchContext`), so it cannot drift from real dispatch plumbing. The
 * only difference from the operator path is the transport-derived
 * `role: 'agent'`, which is the axis under test. The capability set is the
 * richest an implementer ever gets, so a refusal here is about role, not scope.
 */
function runAsDelegatedAgent<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> {
  const authorization = snapshotCallerAuthorization(
    deriveMcpCallerIdentity({ sessionId }),
    createInMemoryResolver([
      'fs:read',
      'fs:write',
      'shell:exec',
      'isolation:worktree',
      'mcp:exarchos',
    ]),
  );
  return Promise.resolve(
    runWithDispatchContext(mintDispatchContext(undefined, authorization), fn),
  );
}

async function seedTask(streamId: string, taskId: string): Promise<void> {
  await store.append(streamId, {
    type: 'task.assigned',
    data: { taskId, title: 'Admission subject', assignee: 'agent-1' },
  });
}

/** A hand-written signal row, exactly as `exarchos_event.append` accepts it. */
async function appendSignalRow(
  streamId: string,
  details: Record<string, unknown>,
  layer = 'quality',
): Promise<void> {
  await store.append(streamId, {
    type: 'gate.executed',
    data: { gateName: GATE, layer, passed: true, details },
  });
}

/**
 * Drive the REAL durable gate runner so the row under test is minted the way
 * production mints it — evidence record first, signal derived from it. The
 * provider is stubbed to keep the gate from shelling out; everything that
 * produces the provenance (subject binding, evidence append, signal minting)
 * is the production path.
 */
async function runRealGate(
  streamId: string,
  taskId: string,
  gateClass: SupportedGateClass = GATE,
): Promise<void> {
  const result = await runAsDelegatedAgent('runner-session', () =>
    runGate(
      {
        streamId,
        gateClass,
        phaseAttemptId: `phase-attempt:${streamId}`,
        requirementId: `requirement:${gateClass}`,
        subject: createEvidenceSubject({ kind: 'task', taskId }, { gateClass }),
        providerInput: { taskId },
      },
      {
        eventStore: store,
        artifactStore,
        executeProvider: async () => ({ success: true, data: { passed: true } }),
      },
    ),
  );
  expect(result.success).toBe(true);
}

async function completedRows(streamId: string): Promise<readonly unknown[]> {
  return store.query(streamId, { type: 'task.completed' });
}

/** Read one field off an unknown event payload without asserting its shape. */
function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

describe('task_complete admission is keyed to evidence provenance', () => {
  it('AgentAppendedRow_DoesNotSatisfyAdmission', async () => {
    // KILL FIXTURE. A delegated agent appends the row itself and asks to
    // complete. Matching on gate name and pass flag alone, this succeeds; the
    // agent the evidence path refuses by construction walks straight past it in
    // another envelope.
    const streamId = 'admission-agent-row';
    await seedTask(streamId, 'task-alpha');
    await appendSignalRow(streamId, { taskId: 'task-alpha' });

    const result = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.unmetGates).toContain(GATE);
    expect(await completedRows(streamId)).toHaveLength(0);
  });

  it('AgentAppendedRow_CitingAnUnresolvableEvidenceId_DoesNotSatisfyAdmission', async () => {
    // Provenance is a resolution, not a field. An id the agent invents cites
    // nothing, so a reader that only checked for the field's presence would
    // have renamed the hole rather than closed it.
    const streamId = 'admission-forged-id';
    await seedTask(streamId, 'task-alpha');
    await appendSignalRow(streamId, {
      taskId: 'task-alpha',
      evidenceId: 'evidence:0000000000000000000000000000000000000000000000000000000000000000',
    });

    const result = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  it('OperatorAppendedRow_StillSatisfies', async () => {
    // Manual operator satisfaction is a wanted affordance and survives intact:
    // the local operator's role is transport-derived, so the row is an operator
    // decision rather than the governed vouching for itself.
    const streamId = 'admission-operator-row';
    await seedTask(streamId, 'task-alpha');
    await appendSignalRow(streamId, { taskId: 'task-alpha' });

    const result = await runAsTrustedCaller(tempDir, () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );

    expect(result.success).toBe(true);
    expect(await completedRows(streamId)).toHaveLength(1);
  });

  it('OperatorAppendedRow_InTopLevelTaskIdShape_StillSatisfies', async () => {
    // The tolerant reader keeps both shapes. An operator satisfying a gate by
    // hand reaches for the flat `data.taskId` far more readily than the
    // handler-emitted `data.details.taskId`.
    const streamId = 'admission-operator-flat';
    await seedTask(streamId, 'task-alpha');
    await store.append(streamId, {
      type: 'gate.executed',
      data: { gateName: GATE, layer: 'quality', passed: true, taskId: 'task-alpha' },
    });

    const result = await runAsTrustedCaller(tempDir, () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );

    expect(result.success).toBe(true);
  });

  it('RunnerMintedRow_SatisfiesWithoutOperatorRole', async () => {
    // The whole point of keying on provenance: an agent that actually RAN the
    // gate is admitted, because the proof is the runner's, not the agent's.
    const streamId = 'admission-runner-row';
    await seedTask(streamId, 'task-alpha');
    await runRealGate(streamId, 'task-alpha');

    const result = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );

    expect(result.success).toBe(true);
    expect(await completedRows(streamId)).toHaveLength(1);

    // Pin the seam the admission actually reads, so a producer that stops
    // stamping the citation reddens here rather than degrading into the
    // operator-only path.
    const signals = await store.query(streamId, { type: 'gate.executed' });
    const evidenceRows = await store.query(streamId, { type: 'admission.evidence-recorded' });
    expect(signals).toHaveLength(1);
    expect(evidenceRows).toHaveLength(1);

    const details = readField(readField(signals[0]?.data, 'details'), 'taskId');
    const citedId = readField(readField(signals[0]?.data, 'details'), 'evidenceId');
    const recordedId = readField(readField(evidenceRows[0]?.data, 'evidence'), 'evidenceId');
    expect(details).toBe('task-alpha');
    expect(typeof citedId).toBe('string');
    expect(recordedId).toBe(citedId);
  });

  it('RowCitingAnotherGatesEvidence_DoesNotSatisfyAdmission', async () => {
    // Provenance has to answer WHICH gate ran, not merely "a gate ran". The
    // kill probe really did execute, on this very task, and its receipt really
    // does resolve — everything a reader keyed on evidence ids alone checks.
    // It is still not a static analysis, and the gate name on the row that
    // cites it is written by the same agent the citation is supposed to
    // discipline.
    const streamId = 'admission-borrowed-proof';
    await seedTask(streamId, 'task-alpha');
    await runRealGate(streamId, 'task-alpha', 'test-adequacy');

    const evidenceRows = await store.query(streamId, { type: 'admission.evidence-recorded' });
    expect(evidenceRows).toHaveLength(1);
    const probeEvidenceId = readField(readField(evidenceRows[0]?.data, 'evidence'), 'evidenceId');
    expect(typeof probeEvidenceId).toBe('string');

    await appendSignalRow(streamId, {
      taskId: 'task-alpha',
      evidenceId: probeEvidenceId,
    });

    const borrowed = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );
    expect(borrowed.success).toBe(false);
    expect(borrowed.error?.code).toBe('GATE_NOT_PASSED');
    expect(borrowed.error?.unmetGates).toContain(GATE);

    // Anti-vacuity: the refusal is about the gate the proof belongs to, not
    // about an id that failed to resolve. Run the static analysis the
    // obligation actually names and the same agent, same task, same stream is
    // admitted.
    await runRealGate(streamId, 'task-alpha');
    const owned = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );
    expect(owned.success).toBe(true);
  });

  it('RowWithEmptyDetails_DoesNotDischargeEveryTask', async () => {
    // A row discharges at most the task it NAMES. Two arms, because the defect
    // had two faces: a row naming nobody, and a genuine row naming somebody
    // else.
    const streamId = 'admission-cross-task';
    await seedTask(streamId, 'task-alpha');
    await seedTask(streamId, 'task-beta');

    await appendSignalRow(streamId, {});
    const anonymous = await runAsTrustedCaller(tempDir, () =>
      handleTaskComplete({ taskId: 'task-beta', streamId }, tempDir, store),
    );
    expect(anonymous.success).toBe(false);
    expect(anonymous.error?.code).toBe('GATE_NOT_PASSED');

    await runRealGate(streamId, 'task-alpha');
    const borrowed = await runAsTrustedCaller(tempDir, () =>
      handleTaskComplete({ taskId: 'task-beta', streamId }, tempDir, store),
    );
    expect(borrowed.success).toBe(false);
    expect(borrowed.error?.code).toBe('GATE_NOT_PASSED');

    // The task the run was genuinely about is unaffected — this is a narrowing,
    // not a blanket refusal.
    const owner = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );
    expect(owner.success).toBe(true);
  });

  it('ShepherdCiObservation_StillAppends_AndDoesNotSatisfy', async () => {
    // The documented fallback append the shepherd skill instructs an agent to
    // make when `assess_stack` is unavailable. It records what CI observed and
    // must stay legal — the quality projections read it — while carrying no
    // per-task discharge, which it never claimed to.
    const streamId = 'admission-shepherd-ci';
    await seedTask(streamId, 'task-alpha');

    const appended = await runAsDelegatedAgent('agent-session', () =>
      handleEventAppend(
        {
          stream: streamId,
          event: {
            type: 'gate.executed',
            data: {
              gateName: GATE,
              layer: 'CI',
              passed: true,
              details: { skill: 'shepherd', commit: 'abc1234' },
            },
          },
        },
        tempDir,
        store,
      ),
    );
    expect(appended.success).toBe(true);
    expect(await store.query(streamId, { type: 'gate.executed' })).toHaveLength(1);

    const completion = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );
    expect(completion.success).toBe(false);
    expect(completion.error?.code).toBe('GATE_NOT_PASSED');
  });

  it('EvidencePath_And_EventPath_ShareOneCapabilityBar', async () => {
    // Anti-vacuity. One identity, one stream, both routes to the same
    // obligation: neither admits the governed agent's own assertion, and the
    // only thing that does admit it is a gate that ran. If either route ever
    // drops below the other, exactly one of these three assertions flips.
    const streamId = 'admission-one-bar';
    await seedTask(streamId, 'task-alpha');

    const viaEvidence = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete(
        {
          taskId: 'task-alpha',
          streamId,
          evidence: { type: 'test', output: 'green across the board', passed: true },
        },
        tempDir,
        store,
      ),
    );
    expect(viaEvidence.error?.code).toBe('GATE_NOT_PASSED');

    await appendSignalRow(streamId, { taskId: 'task-alpha' });
    const viaEvent = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );
    expect(viaEvent.error?.code).toBe('GATE_NOT_PASSED');

    await runRealGate(streamId, 'task-alpha');
    const viaRunner = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId: 'task-alpha', streamId }, tempDir, store),
    );
    expect(viaRunner.success).toBe(true);
  });
});

// ─── Whether the subject is a TASK at all is decided upstream ───────────────
//
// Every case above hands `runGate` a task subject it built by hand, so none of
// them can see the question `selectSubject` answers: a durable gate binds its
// evidence to a task only when the scope carries a `taskId`, and to the commit
// otherwise. A runner arm that reads `subject.kind === 'task'` is therefore
// only as reachable as the taskId threading upstream of it, and a hand-built
// subject makes that threading unfalsifiable.
//
// These two go through the real action —
//
//   exarchos_orchestrate(check_static_analysis)
//     → dispatch() → handleStaticAnalysis → runDurableGateProducer
//     → selectSubject → runGate
//
// — against a real npm toolchain in a real git repo, once with the taskId the
// task-completion runbook threads and once without it.
// ────────────────────────────────────────────────────────────────────────────

describe('check_static_analysis binds evidence to the task only when scoped to one', () => {
  const cleanups: Array<() => void> = [];
  const stores: EventStore[] = [];

  afterEach(() => {
    for (const closable of stores.splice(0)) closable.close();
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  /**
   * A green Node repo that is also a real git repo with one commit.
   *
   * The commit is load-bearing for the no-taskId arm: with no `HEAD` to resolve,
   * `selectSubject` falls back to a synthetic artifact target, and the test
   * would pass for a reason that has nothing to do with the branch under test.
   */
  function gitNodeRepo(prefix: string): string {
    const repoRoot = mkdtempSync(path.join(tmpdir(), prefix));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'admission-subject-fixture',
          version: '1.0.0',
          private: true,
          // All three constituents must be declared or the dimension degrades
          // for a reason unrelated to the subject binding under test.
          scripts: {
            lint: 'node -e ""',
            typecheck: 'node -e ""',
            'quality-check': 'node -e ""',
          },
        },
        null,
        2,
      ),
    );
    const git = (...args: readonly string[]): void => {
      execFileSync('git', [...args], { cwd: repoRoot, stdio: 'ignore' });
    };
    git('init', '--quiet');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Admission Fixture');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    return repoRoot;
  }

  async function startedWorkflow(featureId: string): Promise<HandlerContext> {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'admission-subject-state-'));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    stores.push(eventStore);
    const ctx = withTrustedCaller({
      stateDir,
      eventStore,
      enableTelemetry: false,
    } as HandlerContext);
    const init = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx,
    );
    expect(init.success).toBe(true);
    return ctx;
  }

  /** The identity half of the single evidence subject on `featureId`'s stream. */
  async function soleEvidenceSubject(
    ctx: HandlerContext,
    featureId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await ctx.eventStore.query(featureId, {
      type: 'admission.evidence-recorded',
    });
    expect(rows).toHaveLength(1);
    const subject = readField(readField(rows[0]?.data, 'evidence'), 'subject');
    expect(subject).not.toBeUndefined();
    return subject as Record<string, unknown>;
  }

  it('RealGateScopedToTask_BindsATaskSubject_AndDischargesThatTask', async () => {
    const featureId = 'admission-real-task-scope';
    const taskId = 'ADMISSION-TASK-1';
    const ctx = await startedWorkflow(featureId);
    const repoRoot = gitNodeRepo('admission-task-repo-');

    const gate = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_static_analysis', featureId, taskId, repoRoot },
      ctx,
    );
    expect(gate.success).toBe(true);
    expect((gate.data as { passed?: boolean }).passed).toBe(true);

    // The upstream decision, pinned where the runner arm can actually depend on
    // it: production supplied a taskId, so the proof is bound to the task.
    const subject = await soleEvidenceSubject(ctx, featureId);
    expect(subject.kind).toBe('task');
    expect(subject.taskId).toBe(taskId);

    // A DELEGATED AGENT completes — the operator arm is unavailable to it, so
    // the only thing that can admit this is the provenance the real action just
    // produced.
    const complete = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId, streamId: featureId }, ctx.stateDir, ctx.eventStore),
    );
    expect(complete.success, JSON.stringify(complete.error)).toBe(true);
    expect(
      await ctx.eventStore.query(featureId, { type: 'task.completed' }),
    ).toHaveLength(1);
  }, 180_000);

  it('RealGateWithNoTaskId_BindsACommitSubject_AndDischargesNoTask', async () => {
    // The negative the hand-built subject hid. A project-wide run is a real,
    // passing, runner-minted gate — it simply proves something about the commit
    // rather than about any one task, and the signal it mints names no task.
    const featureId = 'admission-real-commit-scope';
    const taskId = 'ADMISSION-TASK-1';
    const ctx = await startedWorkflow(featureId);
    const repoRoot = gitNodeRepo('admission-commit-repo-');

    const gate = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_static_analysis', featureId, repoRoot },
      ctx,
    );
    expect(gate.success).toBe(true);
    expect((gate.data as { passed?: boolean }).passed).toBe(true);

    const subject = await soleEvidenceSubject(ctx, featureId);
    expect(subject.kind).toBe('commit');
    expect(subject.taskId).toBeUndefined();

    const signals = await ctx.eventStore.query(featureId, { type: 'gate.executed' });
    expect(signals).toHaveLength(1);
    expect(readField(signals[0]?.data, 'passed')).toBe(true);
    expect(readField(readField(signals[0]?.data, 'details'), 'taskId')).toBeUndefined();

    // Neither role gets a per-task discharge out of it: not the governed agent,
    // and not the operator either — the row names no task, so there is nothing
    // for the tolerant reader to match.
    const byAgent = await runAsDelegatedAgent('agent-session', () =>
      handleTaskComplete({ taskId, streamId: featureId }, ctx.stateDir, ctx.eventStore),
    );
    expect(byAgent.success).toBe(false);
    expect(byAgent.error?.code).toBe('GATE_NOT_PASSED');

    const byOperator = await dispatch(
      'exarchos_orchestrate',
      { action: 'task_complete', taskId, streamId: featureId },
      ctx,
    );
    expect(byOperator.success).toBe(false);
    expect(byOperator.error?.code).toBe('GATE_NOT_PASSED');
    expect(
      await ctx.eventStore.query(featureId, { type: 'task.completed' }),
    ).toHaveLength(0);
  }, 180_000);
});
