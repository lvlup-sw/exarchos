// ─── An unscoped gate still records its verdict ──────────────────────────────
//
// Every gate here declares `gate.executed` with `condition: 'always'`. That is a
// promise about the HANDLER: run it to completion and the row lands. The
// post-dispatch emission verifier reads the promise back off the registration
// after the handler returns and reports the difference, so a handler that
// returns `success: true` down a new early-exit — without appending — is drift
// between the declaration and the implementation, and it blocks under the
// default enforcement mode.
//
// The early exit in question is "no diff base could be detected". It is a
// VERDICT (indeterminate), not an absence: the gate was invoked, it ran, and it
// concluded that it could not scope its subject. Without a row, the durable log
// cannot tell that from a gate nobody ever called — which is the same class of
// hole the base-branch literal left behind, one layer further in.
//
// Two production shapes reach the same obligation and both are covered here:
// the three quality gates that append through `emitGateEvent` directly, and the
// three per-task ladder gates whose row is minted by the canonical runner from
// the evidence record. The runner path is the one that would silently regress
// if a future edit moved the base check outside `executeProvider`.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { normalizeGateVerdict } from '../../../../src/verbs/gates/gate-utils.js';
import { handleContextEconomy } from '../../../../src/verbs/gates/context-economy.js';
import { handleOperationalResilience } from '../../../../src/verbs/gates/operational-resilience.js';
import { handleWorkflowDeterminism } from '../../../../src/verbs/gates/workflow-determinism.js';
import { handleContractDrift } from '../../../../src/verbs/gates/contract-drift-handler.js';
import { handleMockBoundary } from '../../../../src/verbs/gates/mock-boundary-handler.js';
import { handleTestAdequacy } from '../../../../src/verbs/gates/test-adequacy-handler.js';

const FEATURE_ID = 'feature-unscoped';
const TASK_ID = 'task-unscoped';
const PHASE_ATTEMPT = 'phase-attempt:implement-unscoped';

/** The minimum store the handlers and the canonical runner read and write. */
class RecordingStore {
  readonly events: WorkflowEvent[] = [];

  constructor() {
    this.events.push({
      id: 'seed-event',
      streamId: FEATURE_ID,
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2026-08-22T00:00:00.000Z',
      data: {
        featureId: FEATURE_ID,
        workflowType: 'feature',
        phaseAttemptId: PHASE_ATTEMPT,
      },
    } as unknown as WorkflowEvent);
  }

  async query(
    streamId: string,
    filters?: { readonly type?: string },
  ): Promise<WorkflowEvent[]> {
    return this.events.filter(
      (event) =>
        event.streamId === streamId &&
        (filters?.type === undefined || event.type === filters.type),
    );
  }

  async append(
    streamId: string,
    event: Omit<WorkflowEvent, 'id' | 'streamId' | 'sequence'>,
  ): Promise<WorkflowEvent> {
    const persisted = {
      ...event,
      id: `event-${this.events.length + 1}`,
      streamId,
      sequence: this.events.length + 1,
      timestamp: event.timestamp ?? '2026-08-22T00:01:00.000Z',
    } as unknown as WorkflowEvent;
    this.events.push(persisted);
    return persisted;
  }
}

function trustedContext(sessionId: string) {
  const identity = deriveMcpCallerIdentity({ sessionId });
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(
      identity,
      createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec']),
    ),
  );
}

type GateId =
  | 'context-economy'
  | 'operational-resilience'
  | 'workflow-determinism'
  | 'contract-drift'
  | 'mock-boundary'
  | 'test-adequacy';

/**
 * Every gate that resolves a diff base and can conclude it has none.
 *
 * `check_static_analysis` is deliberately absent: it lints and typechecks the
 * tree it was pointed at, so the base is a LABEL on its evidence rather than a
 * range it reads. It withholds the label and still runs, so it has no
 * inconclusive exit to cover here. `check_integration_suite` is likewise out of
 * scope for this file.
 */
const GATES: readonly GateId[] = [
  'context-economy',
  'operational-resilience',
  'workflow-determinism',
  'contract-drift',
  'mock-boundary',
  'test-adequacy',
];

describe('a gate that cannot scope itself still records the verdict', () => {
  const dirs: string[] = [];
  let repoRoot: string;
  let stateDir: string;
  let store: RecordingStore;

  beforeEach(async () => {
    // Not a repository and not inside one, so no rung of the detection ladder
    // can answer — the production shape of the case, without a fixture repo.
    repoRoot = await mkdtemp(join(tmpdir(), 'unscoped-repo-'));
    stateDir = await mkdtemp(join(tmpdir(), 'unscoped-state-'));
    dirs.push(repoRoot, stateDir);
    store = new RecordingStore();
  });

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function run(gate: GateId): Promise<ToolResult> {
    const eventStore = store as unknown as EventStore;
    // NOTE: no `baseBranch` anywhere below — that omission is the subject.
    const common = { featureId: FEATURE_ID, taskId: TASK_ID, repoRoot };
    const invoke = async (): Promise<ToolResult> => {
      switch (gate) {
        case 'context-economy':
          return handleContextEconomy(common, stateDir, eventStore);
        case 'operational-resilience':
          return handleOperationalResilience(common, stateDir, eventStore);
        case 'workflow-determinism':
          return handleWorkflowDeterminism(common, stateDir, eventStore);
        case 'contract-drift':
          return handleContractDrift(common, stateDir, eventStore);
        case 'mock-boundary':
          return handleMockBoundary(common, stateDir, eventStore);
        case 'test-adequacy':
          return handleTestAdequacy(common, stateDir, eventStore);
      }
    };
    return await runWithDispatchContext(trustedContext(`unscoped-${gate}`), invoke);
  }

  function gateRows(): WorkflowEvent[] {
    return store.events.filter((event) => event.type === 'gate.executed');
  }

  it.each(GATES)('UnscopedRun_StillAppendsGateExecuted [%s]', async (gate) => {
    const result = await run(gate);

    // The handler completed, so the unconditional contract applies to it.
    expect(result.success).toBe(true);
    expect(
      gateRows().length,
      `${gate} returned success without the gate.executed it declares ` +
        "with condition 'always' — the emission verifier reads that as drift",
    ).toBe(1);
  });

  it.each(GATES)('UnscopedRun_NeverMintsProof [%s]', async (gate) => {
    const result = await run(gate);

    // Fail-closed on the wire: admission requires `passed === true`, so an
    // unscoped run can never discharge an obligation.
    expect((gateRows()[0]?.data as { passed?: boolean } | undefined)?.passed).toBe(false);
    // And never a pass in the proof vocabulary either. `fail` is acceptable for
    // a gate whose own policy classes an uncomputable diff as an execution
    // failure; `pass` is not acceptable for any of them.
    expect(normalizeGateVerdict(result)).not.toBe('pass');
  });

  it('TheRowSaysWhy_SoAnUnscopedRunIsNotAnOrdinaryFailure', async () => {
    // Without this the fail-closed row above is indistinguishable from a gate
    // that ran and found a real fault, which would send an operator hunting for
    // a defect instead of a missing `origin/HEAD`.
    await run('context-economy');

    const details = (gateRows()[0]?.data as { details?: Record<string, unknown> })?.details;
    expect(details).toMatchObject({
      skipped: true,
      discriminant: 'base-branch-unresolved',
    });
    expect(String(details?.['reason'])).toContain('no default branch');
  });
});
