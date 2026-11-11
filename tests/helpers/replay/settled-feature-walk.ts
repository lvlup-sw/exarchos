/**
 * A walk through the real dispatcher that leaves one settled feature stream with each ledger kind.
 *
 * The walk starts a feature workflow, plans two tasks and prepares. It holds the first batch on a material deviation
 * that names a third planned task, and it accepts the deviation. Then it prepares the continuation, settles the third task and moves to `review`.
 * It keeps the shipped defaults: the SQLite backend of the composition root, telemetry on and the default capability grant.
 *
 * Telemetry appends an emissions gate row after a call returns. So the walk waits for that row and a stable tail after each call.
 * The walk imports nothing from vitest, so a script can run it under `bun`. The caller removes the state directory and the repository.
 */
import { readdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import { deriveMcpCallerIdentity } from '../../../src/dispatch/caller-identity.js';
import { initializeContext } from '../../../src/dispatch/core/context.js';
import { dispatch, type DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import type { EventStore } from '../../../src/events/store.js';
import { initializeBackend } from '../../../src/index.js';
import { PHASE_EXPECTED_EVENTS } from '../../../src/verbs/gates/check-event-emissions.js';
import { resolveWorkflowState } from '../../../src/verbs/resolve-state.js';
import { SETTLEMENT_OUTCOMES, type SettlementOutcome } from '../../../src/verbs/settle/adjudicate.js';
import { scopedRepository, type ScopedRepository } from '../scoped-repository.js';

/** The stream of the walk. The emissions check refuses a stream id outside `/^[a-z0-9-]+$/`. */
const WALK_STREAM = 'feat-workflow-replay-walk';

/** The session of the MCP caller identity of the walk. */
const WALK_SESSION = 'workflow-replay-walk';

/** The branch that each task forks from. */
const INTEGRATION_BRANCH = 'feature/workflow-replay';

/** The design record of the walk, relative to the checkout. The plan artifact names it. */
const DESIGN_RECORD = 'design/replay-walk.md';

/** The suffix of the file form of the state document. The walk lists the state directory for it. */
const STATE_DOCUMENT_SUFFIX = '.state.json';

/** The cheapest npm script that exits 0. The static-analysis gate runs it in each task worktree. */
const OK = 'node -e ""';

/** The interval of each poll of the stream. */
const POLL_MS = 25;

/** One hint window of the telemetry wrapper. The tail must stay the same over it. */
const HINT_WINDOW_MS = 150;

/** The longest wait for the telemetry writer after one call. */
const WAIT_LIMIT_MS = 10_000;

/** The three planned tasks. Each one is low risk and off the boundary, so static analysis is its whole ladder. */
const TASK_IDS: readonly [string, string, string] = ['task-a', 'task-b', 'task-c'];

/** One task of the plan, as the planner stamps it. */
function plannedTask(id: string, title: string, blockedBy: readonly string[]): Record<string, unknown> {
  return { id, title, status: 'pending', blockedBy: [...blockedBy], riskTier: 'low', boundaryTouching: false };
}

/** The part of a prepare receipt that the walk reads. */
const PreparedReceiptSchema = z.object({
  capsuleVersion: z.number().int(),
  capsule: z.object({
    identity: z.object({ designVersion: z.string() }),
    graph: z.object({ tasks: z.array(z.object({ taskId: z.string() })) }),
  }),
});

/** The part of a settle receipt that the walk reads. */
const SettleReceiptSchema = z.object({
  operationId: z.string(),
  outcome: z.enum(SETTLEMENT_OUTCOMES),
  acceptedTasks: z.array(z.string()),
  tailSequence: z.number().int(),
  capsule: z.object({ capsuleVersion: z.number().int(), batchId: z.string() }),
  designRevision: z.object({ priorDesignVersion: z.number().int(), nextDesignVersion: z.number().int() }).optional(),
  pendingDeviations: z.array(z.object({ deviationId: z.string() })).optional(),
});

/** The design revision of a settle receipt. */
export interface WalkDesignRevision {
  readonly priorDesignVersion: number;
  readonly nextDesignVersion: number;
}

/** What the walk keeps of one settle receipt. */
export interface WalkSettlement {
  readonly batchId: string;
  readonly operationId: string;
  readonly outcome: SettlementOutcome;
  readonly acceptedTasks: readonly string[];
  readonly tailSequence: number;
  readonly capsuleVersion: number;
  readonly designRevision?: WalkDesignRevision;
}

/** What the walk keeps of one prepare receipt. */
export interface WalkPreparation {
  readonly capsuleVersion: number;
  readonly designVersion: string;
  readonly tasks: readonly string[];
}

/** The result of the walk. The event store of `context` holds the settled stream. */
export interface SettledFeatureWalk {
  readonly context: DispatchContext;
  readonly streamId: string;
  /** The three planned tasks: the two of the first capsule, then the task that the deviation names. */
  readonly tasks: readonly [string, string, string];
  /** The target of each transition that succeeded, in order. */
  readonly transitions: readonly string[];
  readonly preparations: readonly WalkPreparation[];
  readonly settlements: readonly WalkSettlement[];
  /** The tasks that the deviation of the held batch names. */
  readonly deviationTasks: readonly string[];
  /** The worktree path that the walk claimed for each task. */
  readonly claimedTrees: ReadonlyMap<string, string>;
  /** Each name in the state directory that has the file form of the state document. */
  readonly stateDocumentFiles: readonly string[];
  /** The count of calls that waited for an emission row. */
  readonly emissionCalls: number;
  /** The tail of the stream when the walk returns. */
  readonly finalTail: number;
}

/** Makes the repository of the walk: a Node project that the static-analysis gate passes, and the design record. */
export async function walkRepository(): Promise<ScopedRepository> {
  const manifest = {
    name: 'workflow-replay-walk',
    version: '1.0.0',
    private: true,
    scripts: { lint: OK, typecheck: OK, 'quality-check': OK },
  };
  return scopedRepository({
    integrationBranch: INTEGRATION_BRANCH,
    files: {
      'package.json': JSON.stringify(manifest, null, 2),
      [DESIGN_RECORD]: '# Replay walk\n\nThe design record of the settled feature walk.\n',
    },
  });
}

/** Whether a row is the emissions gate row that the telemetry wrapper appends. */
function isEmissionRow(row: { readonly type: string; readonly data?: Readonly<Record<string, unknown>> | undefined }): boolean {
  return row.type === 'gate.executed' && row.data?.gateName === 'event-emissions';
}

/** The count of emission rows of the stream. */
async function emissionRowCount(store: EventStore, streamId: string): Promise<number> {
  return (await store.query(streamId, { type: 'gate.executed' })).filter(isEmissionRow).length;
}

/** The sequence of the last row of the stream, or 0 for an empty stream. */
async function tailOf(store: EventStore, streamId: string): Promise<number> {
  const rows = await store.query(streamId);
  return rows[rows.length - 1]?.sequence ?? 0;
}

/** Whether the phase of the stream lists expected events, so the emissions check appends a row in it. */
async function phaseExpectsEvents(store: EventStore, streamId: string): Promise<boolean> {
  const resolved = await resolveWorkflowState({ featureId: streamId, eventStore: store });
  if ('error' in resolved) throw new Error(`the walk stream does not fold: ${resolved.error.error?.message ?? 'no message'}`);
  const phase = resolved.state.phase;
  return typeof phase === 'string' && PHASE_EXPECTED_EVENTS[phase] !== undefined;
}

/**
 * Runs the walk in a fresh state directory, against the repository of {@link walkRepository}.
 * Each call passes `featureId`. A refused call throws with its error code.
 */
export async function walkSettledFeature(stateDir: string, repository: ScopedRepository): Promise<SettledFeatureWalk> {
  const backend = await initializeBackend(stateDir);
  const base = await initializeContext(stateDir, { backend });
  const context: DispatchContext = {
    ...base,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: WALK_SESSION }),
  };
  const store = context.eventStore;
  const streamId = WALK_STREAM;
  const [first, second, third] = TASK_IDS;
  let emissionCalls = 0;

  const waitForTelemetry = async (name: string, before: number): Promise<void> => {
    let waited = 0;
    let count = await emissionRowCount(store, streamId);
    if (await phaseExpectsEvents(store, streamId)) {
      emissionCalls += 1;
      while (count < before + 1) {
        if (waited >= WAIT_LIMIT_MS) {
          throw new Error(`the emission row of the walk call '${name}' did not land: ${before} row(s) before it, ${count} after ${waited} ms`);
        }
        await sleep(POLL_MS);
        waited += POLL_MS;
        count = await emissionRowCount(store, streamId);
      }
    }
    let tail = await tailOf(store, streamId);
    for (;;) {
      await sleep(HINT_WINDOW_MS);
      waited += HINT_WINDOW_MS;
      const next = await tailOf(store, streamId);
      if (next === tail) return;
      if (waited >= WAIT_LIMIT_MS) {
        count = await emissionRowCount(store, streamId);
        throw new Error(`the tail after the walk call '${name}' did not settle: ${before} emission row(s) before it, ${count} after ${waited} ms`);
      }
      tail = next;
    }
  };

  const call = async (name: string, tool: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    const before = await emissionRowCount(store, streamId);
    const result = await dispatch(tool, { ...args, featureId: streamId }, context);
    if (!result.success) {
      throw new Error(`the walk call '${name}' failed with ${result.error?.code ?? 'no code'}: ${result.error?.message ?? 'no message'}`);
    }
    await waitForTelemetry(name, before);
    return result.data;
  };

  const transitions: string[] = [];
  const workflow = async (action: string, fields: Readonly<Record<string, unknown>>): Promise<void> => {
    await call(`workflow ${action}`, 'exarchos_workflow', { action, ...fields });
    if (action === 'transition' && typeof fields.target === 'string') transitions.push(fields.target);
  };

  const preparations: WalkPreparation[] = [];
  const prepare = async (): Promise<WalkPreparation> => {
    const receipt = PreparedReceiptSchema.parse(await call('prepare', 'exarchos_orchestrate', { action: 'prepare', repoRoot: repository.checkout }));
    const preparation = {
      capsuleVersion: receipt.capsuleVersion,
      designVersion: receipt.capsule.identity.designVersion,
      tasks: receipt.capsule.graph.tasks.map((task) => task.taskId),
    };
    preparations.push(preparation);
    return preparation;
  };

  const settlements: WalkSettlement[] = [];
  const settle = async (batchId: string, capsuleVersion: number, fields: Readonly<Record<string, unknown>>): Promise<z.infer<typeof SettleReceiptSchema>> => {
    const receipt = SettleReceiptSchema.parse(
      await call(`settle ${batchId}`, 'exarchos_orchestrate', { action: 'settle', capsuleVersion, batchId, ...fields }),
    );
    settlements.push({
      batchId: receipt.capsule.batchId,
      operationId: receipt.operationId,
      outcome: receipt.outcome,
      acceptedTasks: receipt.acceptedTasks,
      tailSequence: receipt.tailSequence,
      capsuleVersion: receipt.capsule.capsuleVersion,
      ...(receipt.designRevision !== undefined ? { designRevision: receipt.designRevision } : {}),
    });
    return receipt;
  };

  const claimedTrees = new Map<string, string>();
  const claimsOf = async (taskIds: readonly string[]): Promise<Record<string, unknown>[]> => {
    const claims: Record<string, unknown>[] = [];
    for (const taskId of taskIds) {
      const worktreePath = await repository.worktreeFor(taskId);
      claimedTrees.set(taskId, worktreePath);
      claims.push({ taskId, fields: { worktreePath, files: [`src/${taskId}.ts`] }, evidence: [] });
    }
    return claims;
  };

  await workflow('init', { workflowType: 'feature' });
  await workflow('update', { updates: { 'artifacts.plan': DESIGN_RECORD } });
  await workflow('transition', { target: 'plan-review' });
  await workflow('update', { updates: { planReview: { approved: true } } });
  await workflow('transition', { target: 'delegate' });
  await workflow('update', {
    updates: {
      'synthesis.integrationBranch': INTEGRATION_BRANCH,
      tasks: [plannedTask(first, 'first', []), plannedTask(second, 'second', [])],
    },
  });

  const compiled = await prepare();
  await workflow('update', {
    updates: {
      tasks: [plannedTask(first, 'first', []), plannedTask(second, 'second', []), plannedTask(third, 'third', [first])],
    },
  });

  const deviationTasks = [third];
  const held = await settle('batch-1', compiled.capsuleVersion, {
    claims: await claimsOf([first, second]),
    deviations: [
      {
        deviationKind: 'invalidated-assumption',
        statement: 'the endpoint reads a cache that the design did not name',
        affectedTasks: deviationTasks,
        proposedChange: 'the third task reads the cache through the adapter',
      },
    ],
  });
  await settle('batch-1', compiled.capsuleVersion, {
    decisions: (held.pendingDeviations ?? []).map(({ deviationId }) => ({
      deviationId,
      decision: 'accepted',
      actor: 'human:reviewer',
      rationale: 'the design did not name the cache, and the change is sound',
    })),
  });

  const continuation = await prepare();
  await settle('batch-2', continuation.capsuleVersion, { claims: await claimsOf([third]) });
  await workflow('transition', { target: 'review' });

  const stateDocumentFiles = (await readdir(stateDir)).filter((name) => name.endsWith(STATE_DOCUMENT_SUFFIX)).sort();
  return {
    context,
    streamId,
    tasks: TASK_IDS,
    transitions,
    preparations,
    settlements,
    deviationTasks,
    claimedTrees,
    stateDocumentFiles,
    emissionCalls,
    finalTail: await tailOf(store, streamId),
  };
}
