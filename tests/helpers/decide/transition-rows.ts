/**
 * Captures the result and the stream rows of the three guarded handlers: transition, cancel and cleanup.
 *
 * `captureTransitionRows` runs one scenario on its own temporary SQLite store, and the state store uses the same backend.
 * It records the result of the handler and each row of the stream: its type, its data, its idempotency key and its operation id.
 * `maskRows` replaces each volatile part of a string at any depth with a fixed token, so the golden holds no value of one run.
 * The golden holds the masked capture of the eleven scenarios. So a change of a handler result or of a stream row fails its test.
 *
 * The module imports nothing from vitest, so a script can run it under `bun`.
 */
import path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import type { ToolResult } from '../../../src/format.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { handleRequestSynthesize } from '../../../src/verbs/team/request-synthesize.js';
import { flushLiveShadowEvidence } from '../../../src/workflow/admission/live-shadow-observer.js';
import { handleCleanup } from '../../../src/workflow/cleanup.js';
import { configureStateStoreBackend } from '../../../src/workflow/state-store.js';
import { handleCancel, handleInit, handleSet } from '../../../src/workflow/tools.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** The options that `handleSet` takes after the event store. */
type HandleSetOptions = NonNullable<Parameters<typeof handleSet>[3]>;

/** The calls that a scenario makes to reach its source phase. Each call throws when it does not succeed. */
interface ScenarioSteps {
  readonly update: (updates: Record<string, unknown>) => Promise<void>;
  readonly transition: (phase: string) => Promise<void>;
  readonly appendTaskCompleted: (taskId: string) => Promise<void>;
  readonly requestSynthesize: () => Promise<void>;
}

/** The handler call of a scenario. A transition calls `handleSet` with a phase. */
export type ScenarioCall =
  | { readonly kind: 'transition'; readonly to: string; readonly options?: HandleSetOptions }
  | { readonly kind: 'cancel'; readonly reason: string }
  | {
      readonly kind: 'cleanup';
      readonly prUrl: string;
      readonly mergedBranches: readonly string[];
    };

/** One scenario of the golden. `setup` runs after init and moves the workflow to `from`. */
export interface TransitionRowScenario {
  readonly name: string;
  readonly workflowType: 'feature' | 'oneshot' | 'debug';
  readonly featureId: string;
  readonly from: string;
  readonly call: ScenarioCall;
  /** Whether the handler call succeeds. The capture throws when the result disagrees. */
  readonly succeeds: boolean;
  readonly setup: (steps: ScenarioSteps) => Promise<void>;
}

/** One row of the stream, with the four fields that the golden holds. An absent key or operation id is `null`. */
export interface CapturedRow {
  readonly type: string;
  readonly data: Record<string, unknown> | null;
  readonly idempotencyKey: string | null;
  readonly operationId: string | null;
}

/** The capture of one scenario, with no mask. */
export interface TransitionRowsEntry {
  readonly name: string;
  readonly workflowType: string;
  readonly featureId: string;
  readonly from: string;
  readonly call: ScenarioCall;
  readonly result: ToolResult;
  readonly rows: readonly CapturedRow[];
}

/** The token that replaces each phase attempt id of the digest form. */
const PHASE_ATTEMPT_TOKEN = '<phase-attempt-id>';

/** The token that replaces each UUID. */
const UUID_TOKEN = '<uuid>';

/** The token that replaces each cancel idempotency key. */
const CANCEL_KEY_TOKEN = '<cancel-key>';

/** The token that replaces each timestamp. */
const TIMESTAMP_TOKEN = '<timestamp>';

/** The token that replaces the value of each `principalId` field. */
const PRINCIPAL_ID_TOKEN = '<principal-id>';

/** The token that replaces the value of each `contentDigest` field. */
const CONTENT_DIGEST_TOKEN = '<content-digest>';

/**
 * The fields whose whole value the mask replaces.
 * The local operator subject of `principalId` derives from the temporary state directory.
 * The `contentDigest` of a cancel readiness proof is a digest over values that change on each run.
 */
const MASKED_FIELDS: ReadonlyMap<string, string> = new Map([
  ['principalId', PRINCIPAL_ID_TOKEN],
  ['contentDigest', CONTENT_DIGEST_TOKEN],
]);

/** A phase attempt id of the digest form. Each one is a digest over its predecessor, so it changes on each run. */
const PHASE_ATTEMPT_PATTERN = /phase-attempt:[0-9a-f]{64}/g;

/** A UUID. The initial phase attempt id, each event id and each cancel instance id hold one. */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** A cancel idempotency key. Each one is a digest over the cancel id. */
const CANCEL_KEY_PATTERN = /cancel:[0-9a-f]{64}/g;

/** An ISO 8601 date and time, as `toISOString` writes it. */
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces each volatile substring of a string with its token, in the order of the mask rules. */
function maskString(value: string): string {
  return value
    .replace(PHASE_ATTEMPT_PATTERN, PHASE_ATTEMPT_TOKEN)
    .replace(UUID_PATTERN, UUID_TOKEN)
    .replace(CANCEL_KEY_PATTERN, CANCEL_KEY_TOKEN)
    .replace(TIMESTAMP_PATTERN, TIMESTAMP_TOKEN);
}

/**
 * Returns a copy of a value with each volatile part replaced by a fixed token, at any depth.
 * The mask replaces each phase attempt id, UUID, cancel key and timestamp inside each string.
 * It replaces the whole value of each `principalId` and `contentDigest` field.
 */
export function maskRows(value: unknown): unknown {
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map(maskRows);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, MASKED_FIELDS.get(key) ?? maskRows(item)]),
    );
  }
  return value;
}

/** The plan artifact of each scenario that needs one. */
const PLAN_ARTIFACT = 'plans/plan.md';

/** The one task of each feature scenario after `plan-review`. */
const TASK_ID = 't1';

/** The pull request of the cleanup scenario. */
const PR_URL = 'https://example.com/pr/1';

/** The merged branch of the cleanup scenario. */
const MERGED_BRANCH = 'feat/transition-rows-cleanup';

/** The mutation options and the NoCoverage budget of the high-tier scenario. */
const MUTATION_OPTIONS: HandleSetOptions = { mutationEnforcement: 'block', mutationThreshold: 80, maxNoCoverage: 2 };

/** The reviews of the high-tier scenario. Each review passes, and the mutation score passes the threshold. */
const PASSING_REVIEWS: Record<string, unknown> = {
  review: { status: 'pass' },
  'mutation-adequacy': { status: 'pass', mutationScore: 90, noCoverage: 1 },
};

/** Moves a feature workflow to the end of `plan`, with the plan artifact set. */
async function featureAtPlan(steps: ScenarioSteps): Promise<void> {
  await steps.update({ 'artifacts.plan': PLAN_ARTIFACT });
}

/** Moves a feature workflow to `plan-review`, with the plan review approved. */
async function featureAtPlanReview(steps: ScenarioSteps): Promise<void> {
  await featureAtPlan(steps);
  await steps.transition('plan-review');
  await steps.update({ planReview: { approved: true } });
}

/** Moves a feature workflow to `delegate` with its one task pending. */
async function featureAtDelegateWithAPendingTask(steps: ScenarioSteps): Promise<void> {
  await featureAtPlanReview(steps);
  await steps.transition('delegate');
  await steps.update({ tasks: [{ id: TASK_ID, title: 'the one task', status: 'pending' }] });
}

/** Moves a feature workflow to `delegate`. Its one task has a `task.completed` row, and the document marks it complete. */
async function featureAtDelegate(steps: ScenarioSteps): Promise<void> {
  await featureAtDelegateWithAPendingTask(steps);
  await steps.appendTaskCompleted(TASK_ID);
  await steps.update({ tasks: [{ id: TASK_ID, title: 'the one task', status: 'complete' }] });
}

/** Moves a feature workflow to `review` with its reviews set. */
function featureAtReview(updates: Record<string, unknown>): (steps: ScenarioSteps) => Promise<void> {
  return async (steps) => {
    await featureAtDelegate(steps);
    await steps.transition('review');
    await steps.update(updates);
  };
}

/** Moves a debug workflow to `investigate`. */
async function debugAtInvestigate(steps: ScenarioSteps): Promise<void> {
  await steps.update({ triage: { symptom: 'the build fails on a clean checkout' } });
  await steps.transition('investigate');
}

/** The eleven scenarios of the golden, in golden order. */
export const TRANSITION_ROW_SCENARIOS: readonly TransitionRowScenario[] = [
  {
    name: 'feature plan -> plan-review',
    workflowType: 'feature',
    featureId: 'transition-rows-feature-plan',
    from: 'plan',
    call: { kind: 'transition', to: 'plan-review' },
    succeeds: true,
    setup: featureAtPlan,
  },
  {
    name: 'feature plan-review -> delegate',
    workflowType: 'feature',
    featureId: 'transition-rows-feature-plan-review',
    from: 'plan-review',
    call: { kind: 'transition', to: 'delegate' },
    succeeds: true,
    setup: featureAtPlanReview,
  },
  {
    name: 'feature delegate -> review',
    workflowType: 'feature',
    featureId: 'transition-rows-feature-delegate',
    from: 'delegate',
    call: { kind: 'transition', to: 'review' },
    succeeds: true,
    setup: featureAtDelegate,
  },
  {
    name: 'feature review -> delegate as a fix cycle',
    workflowType: 'feature',
    featureId: 'transition-rows-feature-fix-cycle',
    from: 'review',
    call: { kind: 'transition', to: 'delegate' },
    succeeds: true,
    setup: featureAtReview({ reviews: { review: { status: 'needs_fixes' } } }),
  },
  {
    name: 'feature delegate -> review denied with a pending task',
    workflowType: 'feature',
    featureId: 'transition-rows-feature-denied',
    from: 'delegate',
    call: { kind: 'transition', to: 'review' },
    succeeds: false,
    setup: featureAtDelegateWithAPendingTask,
  },
  {
    name: 'feature review -> synthesize at the high tier',
    workflowType: 'feature',
    featureId: 'transition-rows-feature-review-high',
    from: 'review',
    call: { kind: 'transition', to: 'synthesize', options: MUTATION_OPTIONS },
    succeeds: true,
    setup: featureAtReview({ riskTier: 'high', reviews: PASSING_REVIEWS }),
  },
  {
    name: 'oneshot implementing -> synthesize',
    workflowType: 'oneshot',
    featureId: 'transition-rows-oneshot-implementing',
    from: 'implementing',
    call: { kind: 'transition', to: 'synthesize' },
    succeeds: true,
    setup: async (steps) => {
      await steps.update({ 'artifacts.plan': PLAN_ARTIFACT });
      await steps.transition('implementing');
      await steps.requestSynthesize();
    },
  },
  {
    name: 'debug triage -> investigate',
    workflowType: 'debug',
    featureId: 'transition-rows-debug-triage',
    from: 'triage',
    call: { kind: 'transition', to: 'investigate' },
    succeeds: true,
    setup: async (steps) => {
      await steps.update({ triage: { symptom: 'the build fails on a clean checkout' } });
    },
  },
  {
    name: 'debug investigate -> cancelled with investigation.escalate',
    workflowType: 'debug',
    featureId: 'transition-rows-debug-escalate',
    from: 'investigate',
    call: { kind: 'transition', to: 'cancelled' },
    succeeds: true,
    setup: async (steps) => {
      await debugAtInvestigate(steps);
      await steps.update({ investigation: { escalate: true } });
    },
  },
  {
    name: 'cancel of a debug workflow at investigate',
    workflowType: 'debug',
    featureId: 'transition-rows-debug-cancel',
    from: 'investigate',
    call: { kind: 'cancel', reason: 'the bug is out of scope' },
    succeeds: true,
    setup: debugAtInvestigate,
  },
  {
    name: 'cleanup of a feature at synthesize with merge evidence',
    workflowType: 'feature',
    featureId: 'transition-rows-feature-cleanup',
    from: 'synthesize',
    call: { kind: 'cleanup', prUrl: PR_URL, mergedBranches: [MERGED_BRANCH] },
    succeeds: true,
    setup: async (steps) => {
      await featureAtReview({ reviews: { review: { status: 'approved' } } })(steps);
      await steps.transition('synthesize');
      await steps.update({ 'synthesis.prUrl': PR_URL });
    },
  },
];

/** Throws when a call of a scenario setup does not succeed. */
function requireSuccess(step: string, result: ToolResult): void {
  if (result.success) return;
  throw new Error(`the transition-rows step '${step}' failed with ${result.error?.code ?? 'no code'}: ${result.error?.message ?? 'no message'}`);
}

/** Runs the handler call of a scenario on its store. */
function runCall(scenario: TransitionRowScenario, stateDir: string, eventStore: EventStore): Promise<ToolResult> {
  const { call, featureId } = scenario;
  switch (call.kind) {
    case 'transition':
      return handleSet({ featureId, phase: call.to }, stateDir, eventStore, call.options);
    case 'cancel':
      return handleCancel({ featureId, reason: call.reason }, stateDir, eventStore);
    case 'cleanup':
      return handleCleanup(
        { featureId, mergeVerified: true, prUrl: call.prUrl, mergedBranches: [...call.mergedBranches] },
        stateDir,
        eventStore,
      );
  }
}

/**
 * Runs one scenario on its own store and returns its capture with no mask.
 * It throws when a setup call fails, or when the result of the handler call disagrees with `succeeds`.
 * The store closes and the directory goes, also on a throw.
 */
export async function captureTransitionRows(scenario: TransitionRowScenario): Promise<TransitionRowsEntry> {
  const stateDir = makeTempDir('transition-rows-');
  const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  const eventStore = new EventStore(stateDir, { backend });
  const { featureId } = scenario;
  try {
    backend.initialize();
    configureStateStoreBackend(backend);
    await eventStore.initialize();
    requireSuccess('init', await handleInit({ featureId, workflowType: scenario.workflowType }, stateDir, eventStore));
    await scenario.setup({
      update: async (updates) => {
        requireSuccess(`update ${Object.keys(updates).join(', ')}`, await handleSet({ featureId, updates }, stateDir, eventStore));
      },
      transition: async (phase) => {
        requireSuccess(`transition ${phase}`, await handleSet({ featureId, phase }, stateDir, eventStore));
      },
      appendTaskCompleted: async (taskId) => {
        await eventStore.append(featureId, { type: 'task.completed', data: { taskId } });
      },
      requestSynthesize: async () => {
        requireSuccess('request synthesize', await handleRequestSynthesize({ featureId, stateDir, eventStore }));
      },
    });
    const result = await runCall(scenario, stateDir, eventStore);
    if (result.success !== scenario.succeeds) {
      throw new Error(
        `the scenario '${scenario.name}' gave success ${String(result.success)} with ${result.error?.code ?? 'no code'}: ${result.error?.message ?? 'no message'}`,
      );
    }
    await flushLiveShadowEvidence();
    const rows = (await eventStore.query(featureId)).map((event) => ({
      type: event.type,
      data: event.data ?? null,
      idempotencyKey: event.idempotencyKey ?? null,
      operationId: event.operationId ?? null,
    }));
    return {
      name: scenario.name,
      workflowType: scenario.workflowType,
      featureId,
      from: scenario.from,
      call: scenario.call,
      result,
      rows,
    };
  } finally {
    await flushLiveShadowEvidence();
    eventStore.close();
    backend.close();
    configureStateStoreBackend(undefined);
    await rmrfAsync(stateDir);
  }
}

/** Returns a copy of a JSON value with the keys of each record in sorted order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map(sortKeys);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

/** Renders masked entries as the text of the golden: JSON with sorted keys, an indent of two spaces and a final newline. */
export function renderTransitionRowsGolden(entries: readonly unknown[]): string {
  return `${JSON.stringify(sortKeys(entries), null, 2)}\n`;
}
