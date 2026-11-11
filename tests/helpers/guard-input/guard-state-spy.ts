/**
 * Captures the state that `handleSet` gives the transition guard.
 *
 * `captureGuardStates` replaces `hsmTransitionGuard.attempt` for one run. The wrapper clones the state at call time and then calls the original method.
 * `captureTransitionGuardStates` runs seven transitions. Each transition runs on its own temporary SQLite store, and the state store uses the same backend.
 * The golden of the guard state holds the masked capture. So a change of the guard input changes the golden, and its test fails.
 *
 * The module imports nothing from vitest, so a script can run it under `bun`.
 */
import path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { handleRequestSynthesize } from '../../../src/verbs/team/request-synthesize.js';
import { flushLiveShadowEvidence } from '../../../src/workflow/admission/live-shadow-observer.js';
import { hsmTransitionGuard, type GuardContext } from '../../../src/workflow/hsm-transition-guard.js';
import { configureStateStoreBackend } from '../../../src/workflow/state-store.js';
import { handleInit, handleSet } from '../../../src/workflow/tools.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** The options that `handleSet` takes after the event store. */
export type HandleSetOptions = NonNullable<Parameters<typeof handleSet>[3]>;

/** The arguments of one call of the guard. A hook gets them inside the wrapper, before the original method runs. */
export interface GuardAttempt {
  readonly featureId: string;
  readonly from: string;
  readonly to: string;
  readonly context: GuardContext;
}

/** The result of one run under the wrapper. */
export interface GuardStateCapture<T> {
  readonly result: T;
  /** A deep clone of the state of each guard call, in call order. The wrapper takes it at call time. */
  readonly states: readonly Record<string, unknown>[];
}

/**
 * Runs `run` with a wrapper around `hsmTransitionGuard.attempt`.
 * The wrapper clones `context.state`, awaits the hook, and then calls the original method.
 * A `finally` block restores the method, also when `run` or the hook throws.
 */
export async function captureGuardStates<T>(
  run: () => Promise<T>,
  onAttempt?: (attempt: GuardAttempt) => void | Promise<void>,
): Promise<GuardStateCapture<T>> {
  const ownDescriptor = Object.getOwnPropertyDescriptor(hsmTransitionGuard, 'attempt');
  const original = hsmTransitionGuard.attempt;
  const states: Record<string, unknown>[] = [];
  hsmTransitionGuard.attempt = async (featureId, from, to, context) => {
    states.push(structuredClone(context.state));
    await onAttempt?.({ featureId, from, to, context });
    return original.call(hsmTransitionGuard, featureId, from, to, context);
  };
  try {
    const result = await run();
    return { result, states };
  } finally {
    if (ownDescriptor === undefined) {
      Reflect.deleteProperty(hsmTransitionGuard, 'attempt');
    } else {
      Object.defineProperty(hsmTransitionGuard, 'attempt', ownDescriptor);
    }
  }
}

/** The token that replaces each timestamp. */
const TIMESTAMP_TOKEN = '<timestamp>';

/** The token that replaces each phase attempt id. */
const PHASE_ATTEMPT_ID_TOKEN = '<phase-attempt-id>';

/** An ISO 8601 date and time, as `toISOString` writes it and as the schema defaults hold it. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A phase attempt id. Init allocates a random UUID, and each later transition derives a digest from its predecessor. */
const PHASE_ATTEMPT_ID_PATTERN = /^(?:phase-attempt:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces each timestamp and each phase attempt id at any depth with its token. */
function maskValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (TIMESTAMP_PATTERN.test(value)) return TIMESTAMP_TOKEN;
    if (PHASE_ATTEMPT_ID_PATTERN.test(value)) return PHASE_ATTEMPT_ID_TOKEN;
    return value;
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map(maskValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValue(item)]));
  }
  return value;
}

/** Returns a copy of a guard state with each timestamp and each phase attempt id replaced by a fixed token. */
export function maskGuardState(state: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).map(([key, item]) => [key, maskValue(item)]));
}

/** The calls that a transition makes to reach its source phase. Each call throws when it does not succeed. */
interface TransitionSteps {
  readonly update: (updates: Record<string, unknown>) => Promise<void>;
  readonly transition: (phase: string) => Promise<void>;
  readonly appendTaskCompleted: (taskId: string) => Promise<void>;
  readonly requestSynthesize: () => Promise<void>;
}

/** One transition of the golden. `setup` runs after init and moves the workflow to `from`. */
interface GuardStateTransition {
  readonly name: string;
  readonly workflowType: 'feature' | 'oneshot' | 'debug';
  readonly featureId: string;
  readonly from: string;
  readonly to: string;
  readonly options?: HandleSetOptions;
  readonly setup: (steps: TransitionSteps) => Promise<void>;
}

/** The plan artifact of each transition that needs one. */
const PLAN_ARTIFACT = 'plans/plan.md';

/** The one task of each feature transition after `plan-review`. */
const TASK_ID = 't1';

/** The options of the two `review -> synthesize` transitions: the mutation options and the NoCoverage budget. */
const MUTATION_OPTIONS: HandleSetOptions = { mutationEnforcement: 'block', mutationThreshold: 80, maxNoCoverage: 2 };

/** The reviews of the two `review -> synthesize` transitions. Each review passes, and the mutation score passes the threshold. */
const PASSING_REVIEWS: Record<string, unknown> = {
  review: { status: 'pass' },
  'mutation-adequacy': { status: 'pass', mutationScore: 90, noCoverage: 1 },
};

/** Moves a feature workflow to the end of `plan`, with the plan artifact set. */
async function featureAtPlan(steps: TransitionSteps): Promise<void> {
  await steps.update({ 'artifacts.plan': PLAN_ARTIFACT });
}

/** Moves a feature workflow to `plan-review`, with the plan review approved. */
async function featureAtPlanReview(steps: TransitionSteps): Promise<void> {
  await featureAtPlan(steps);
  await steps.transition('plan-review');
  await steps.update({ planReview: { approved: true } });
}

/** Moves a feature workflow to `delegate`. Its one task has a `task.completed` row, and the document marks it complete. */
async function featureAtDelegate(steps: TransitionSteps): Promise<void> {
  await featureAtPlanReview(steps);
  await steps.transition('delegate');
  await steps.update({ tasks: [{ id: TASK_ID, title: 'the one task', status: 'pending' }] });
  await steps.appendTaskCompleted(TASK_ID);
  await steps.update({ tasks: [{ id: TASK_ID, title: 'the one task', status: 'complete' }] });
}

/** Returns the setup that moves a feature workflow to `review` at a risk tier, with each review passed. */
function featureAtReview(riskTier: 'high' | 'medium'): (steps: TransitionSteps) => Promise<void> {
  return async (steps) => {
    await featureAtDelegate(steps);
    await steps.transition('review');
    await steps.update({ riskTier, reviews: PASSING_REVIEWS });
  };
}

/** The seven transitions of the golden, in golden order. */
const GUARD_STATE_TRANSITIONS: readonly GuardStateTransition[] = [
  {
    name: 'feature plan -> plan-review',
    workflowType: 'feature',
    featureId: 'guard-state-feature-plan',
    from: 'plan',
    to: 'plan-review',
    setup: featureAtPlan,
  },
  {
    name: 'feature plan-review -> delegate',
    workflowType: 'feature',
    featureId: 'guard-state-feature-plan-review',
    from: 'plan-review',
    to: 'delegate',
    setup: featureAtPlanReview,
  },
  {
    name: 'feature delegate -> review',
    workflowType: 'feature',
    featureId: 'guard-state-feature-delegate',
    from: 'delegate',
    to: 'review',
    setup: featureAtDelegate,
  },
  {
    name: 'feature review -> synthesize at the high tier',
    workflowType: 'feature',
    featureId: 'guard-state-feature-review-high',
    from: 'review',
    to: 'synthesize',
    options: MUTATION_OPTIONS,
    setup: featureAtReview('high'),
  },
  {
    name: 'feature review -> synthesize at the medium tier',
    workflowType: 'feature',
    featureId: 'guard-state-feature-review-medium',
    from: 'review',
    to: 'synthesize',
    options: MUTATION_OPTIONS,
    setup: featureAtReview('medium'),
  },
  {
    name: 'oneshot implementing -> synthesize',
    workflowType: 'oneshot',
    featureId: 'guard-state-oneshot-implementing',
    from: 'implementing',
    to: 'synthesize',
    setup: async (steps) => {
      await steps.update({ 'artifacts.plan': PLAN_ARTIFACT });
      await steps.transition('implementing');
      await steps.requestSynthesize();
    },
  },
  {
    name: 'debug triage -> investigate',
    workflowType: 'debug',
    featureId: 'guard-state-debug-triage',
    from: 'triage',
    to: 'investigate',
    setup: async (steps) => {
      await steps.update({ triage: { symptom: 'the build fails on a clean checkout' } });
    },
  },
];

/** What the hook of {@link captureTransitionGuardStates} gets at the guard call of one transition. */
export interface TransitionAttempt {
  readonly name: string;
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly attempt: GuardAttempt;
}

/** The capture of one transition. `state` is the state that the guard got, with no mask. */
export interface GuardStateEntry {
  readonly name: string;
  readonly workflowType: string;
  readonly featureId: string;
  readonly from: string;
  readonly to: string;
  readonly options?: HandleSetOptions;
  readonly state: Record<string, unknown>;
}

/** Throws when a call of a transition setup or of the captured transition does not succeed. */
function requireSuccess(step: string, result: { readonly success: boolean; readonly error?: { readonly code?: string; readonly message?: string } | undefined }): void {
  if (result.success) return;
  throw new Error(`the guard-state step '${step}' failed with ${result.error?.code ?? 'no code'}: ${result.error?.message ?? 'no message'}`);
}

/** Runs one transition on its own store and returns its capture. The store closes and the directory goes, also on a throw. */
async function captureTransition(
  transition: GuardStateTransition,
  onAttempt: ((attempt: TransitionAttempt) => void | Promise<void>) | undefined,
): Promise<GuardStateEntry> {
  const stateDir = makeTempDir('guard-state-');
  const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  const eventStore = new EventStore(stateDir, { backend });
  const { featureId } = transition;
  try {
    backend.initialize();
    configureStateStoreBackend(backend);
    await eventStore.initialize();
    requireSuccess('init', await handleInit({ featureId, workflowType: transition.workflowType }, stateDir, eventStore));
    await transition.setup({
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
    const capture = await captureGuardStates(
      () => handleSet({ featureId, phase: transition.to }, stateDir, eventStore, transition.options),
      (attempt) => onAttempt?.({ name: transition.name, stateDir, eventStore, attempt }),
    );
    requireSuccess(transition.name, capture.result);
    const [state, ...rest] = capture.states;
    if (state === undefined || rest.length > 0) {
      throw new Error(`the transition '${transition.name}' called the guard ${capture.states.length} times, not once`);
    }
    return {
      name: transition.name,
      workflowType: transition.workflowType,
      featureId,
      from: transition.from,
      to: transition.to,
      ...(transition.options !== undefined ? { options: transition.options } : {}),
      state,
    };
  } finally {
    await flushLiveShadowEvidence();
    eventStore.close();
    backend.close();
    configureStateStoreBackend(undefined);
    await rmrfAsync(stateDir);
  }
}

/**
 * Runs the seven transitions of the golden, one at a time, and returns the capture of each one in golden order.
 * The hook runs inside the wrapper at the one guard call of each transition.
 */
export async function captureTransitionGuardStates(
  onAttempt?: (attempt: TransitionAttempt) => void | Promise<void>,
): Promise<readonly GuardStateEntry[]> {
  const entries: GuardStateEntry[] = [];
  for (const transition of GUARD_STATE_TRANSITIONS) {
    entries.push(await captureTransition(transition, onAttempt));
  }
  return entries;
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

/** Renders entries as the text of the golden: JSON with sorted keys, an indent of two spaces and a final newline. */
export function renderGuardStateGolden(entries: readonly GuardStateEntry[]): string {
  return `${JSON.stringify(sortKeys(entries), null, 2)}\n`;
}
