/**
 * Lifecycle verb `wait`: block until a predicate over the event log is true, or return a
 * structured timeout or failure. It appends no event on any path.
 *
 * It first folds the feature stream once. When the predicate is already satisfied or failed, it
 * returns at once and does not subscribe. Otherwise it subscribes to the predicate event types from
 * the precheck head, so no event in the gap is missed. The in-process hook wakes it for an event of
 * this process, and the poll floor wakes it for an event of another connection. A bounded deadline
 * returns `WAIT_TIMEOUT`, so the wait never hangs.
 *
 * Each call sets at most one predicate: `phase`, `status`, `operation`, or the worktree `until`.
 * A call with no predicate waits on the worktree `until: merge`. The predicate field selects the
 * scope. There is no `scope` field.
 */
import type { DispatchContext } from '../../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../../format.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import type {
  SubscriptionFilter,
  SubscriptionHandle,
  SubscriptionPerf,
  SubscriptionRegistryOptions,
} from '../../../events/subscriptions.js';
import {
  LIVENESS_REGISTRY,
  LIVENESS_DESCRIPTORS,
  computeInFlightInstances,
  type LivenessDescriptor,
  type LivenessSurface,
} from '../../../events/liveness-registry.js';
import { resolveWorkflowState } from '../../../verbs/resolve-state.js';
import { getHSMDefinition } from '../../../workflow/state-machine.js';
import { DEFAULT_WAIT_TIMEOUT_MS } from '../../../verbs/worktree/manager.js';
import {
  handleWorktreeUntilWait,
  type WorktreeViewDeps,
} from '../../../verbs/worktree/handlers.js';
import { phaseField, statusField, operationField } from './schema-fields.js';

/**
 * Terminal statuses. A `status` predicate can request one. A `phase` predicate treats one as the
 * end of the workflow, so the target becomes unreachable. `completed` and `cancelled` are the
 * built-in HSM terminal phases, and `failed` serves workflow types that fail out. A transition
 * event whose `to` equals the status reaches each one.
 */
const WAIT_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/** Event types that carry a phase `{ from, to }` (both fold to a phase change). */
const TRANSITION_EVENT_TYPES = ['workflow.transition', 'workflow.cancel'] as const;

function isWaitTerminal(phase: string): boolean {
  return (WAIT_TERMINAL_STATUSES as readonly string[]).includes(phase);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function invalidInput(
  message: string,
  extra?: {
    expectedShape?: Record<string, unknown>;
    validTargets?: readonly string[];
    suggestedFix?: { tool: string; params: Record<string, unknown> };
  },
): ToolResult {
  return {
    success: false,
    error: {
      code: 'INVALID_INPUT',
      message,
      ...(extra?.expectedShape ? { expectedShape: extra.expectedShape } : {}),
      ...(extra?.validTargets ? { validTargets: extra.validTargets } : {}),
      ...(extra?.suggestedFix ? { suggestedFix: extra.suggestedFix } : {}),
    },
  };
}

/** Read `{ from, to }` off a transition-carrying event, tolerating loose data. */
function transitionEnds(event: WorkflowEvent): { from?: string | undefined; to?: string | undefined } {
  const data = event.data as Record<string, unknown> | undefined;
  const from = typeof data?.from === 'string' ? data.from : undefined;
  const to = typeof data?.to === 'string' ? data.to : undefined;
  return { from, to };
}

function isTransitionEvent(event: WorkflowEvent): boolean {
  return (TRANSITION_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Test seams of `wait`. It extends {@link WorktreeViewDeps}, so the seams of the `until` scope pass
 * through to the worktree kernel. `subscriptionOptions` goes to `eventStore.subscribe`, so a test can
 * drive the poll floor with a `ManualClock`. `scheduleTimeout` lets a test fire the deadline directly.
 * Production sets no field and uses a real `setTimeout` and the real unref'd floor.
 */
export interface WaitDeps extends WorktreeViewDeps {
  readonly subscriptionOptions?: SubscriptionRegistryOptions;
  /** Monotone clock for the wait deadline / waitedMs. Defaults to `Date.now`. (Also in WorktreeViewDeps.) */
  readonly now?: () => number;
  /** One-shot deadline scheduler. It returns an idempotent canceller. Defaults to `setTimeout`. */
  readonly scheduleTimeout?: (cb: () => void, ms: number) => () => void;
}

/** Schedule the deadline with an unref'd `setTimeout`, so the deadline alone does not keep the process alive. */
function defaultScheduleTimeout(cb: () => void, ms: number): () => void {
  const timer = setTimeout(cb, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

/**
 * A predicate verdict over an ordered slice of relevant events. The precheck and the live path
 * both use the same {@link Predicate.evaluate}, so the wait resolves exactly when the predicate
 * is satisfied. A property test pins this.
 */
export type WaitVerdict =
  | { readonly kind: 'pending' }
  | { readonly kind: 'resolved'; readonly detail: Record<string, unknown> }
  | { readonly kind: 'failed'; readonly detail: Record<string, unknown> };

/** A feature-scoped wait predicate: a subscription filter + a pure evaluator. */
export interface Predicate {
  /** The subscription filter of this predicate. */
  readonly filter: SubscriptionFilter;
  /** Narrow a full event history to the subset this predicate reasons over. */
  relevant(events: readonly WorkflowEvent[]): readonly WorkflowEvent[];
  /** Fold a slice of relevant events into a verdict. It is pure, deterministic and total. */
  evaluate(events: readonly WorkflowEvent[]): WaitVerdict;
  /** The predicate-identifying fields stamped onto a `WAIT_TIMEOUT`. */
  readonly timeoutDetail: Record<string, unknown>;
}

/**
 * `phase` predicate. It resolves when the visited set holds the target: the seed phase plus each
 * transition `from` and `to`. So a workflow past the target resolves at precheck. A terminal
 * status without the target makes the target unreachable, and the verdict is `failed`.
 */
export function phasePredicate(featureId: string, target: string, seedPhase: string): Predicate {
  return {
    filter: { streamId: featureId, eventTypes: [...TRANSITION_EVENT_TYPES] },
    relevant: (events) => events.filter(isTransitionEvent),
    evaluate: (events) => {
      const visited = new Set<string>();
      if (seedPhase.length > 0) visited.add(seedPhase);
      let latest = seedPhase;
      for (const event of events) {
        const { from, to } = transitionEnds(event);
        if (from !== undefined) visited.add(from);
        if (to !== undefined) {
          visited.add(to);
          latest = to;
        }
      }
      if (visited.has(target)) {
        return { kind: 'resolved', detail: { predicate: 'phase', phase: target } };
      }
      if (isWaitTerminal(latest) && latest !== target) {
        return {
          kind: 'failed',
          detail: { predicate: 'phase', phase: target, terminalStatus: latest },
        };
      }
      return { kind: 'pending' };
    },
    timeoutDetail: { predicate: 'phase', phase: target },
  };
}

/**
 * `status` predicate. It resolves when the latest phase equals the requested status. A different
 * terminal status gives `failed`.
 */
export function statusPredicate(featureId: string, requested: string, seedPhase: string): Predicate {
  return {
    filter: { streamId: featureId, eventTypes: [...TRANSITION_EVENT_TYPES] },
    relevant: (events) => events.filter(isTransitionEvent),
    evaluate: (events) => {
      let latest = seedPhase;
      for (const event of events) {
        const { to } = transitionEnds(event);
        if (to !== undefined) latest = to;
      }
      if (latest === requested) {
        return { kind: 'resolved', detail: { predicate: 'status', status: requested } };
      }
      if (isWaitTerminal(latest)) {
        return {
          kind: 'failed',
          detail: { predicate: 'status', status: requested, terminalStatus: latest },
        };
      }
      return { kind: 'pending' };
    },
    timeoutDetail: { predicate: 'status', status: requested },
  };
}

/**
 * `operation` predicate. It resolves when the feature has no in-flight instance of
 * `descriptor.surface`, with starts and terminals paired by the registry instance key. It never
 * gives `failed`: the surface goes idle, or the wait times out.
 */
export function operationPredicate(featureId: string, descriptor: LivenessDescriptor): Predicate {
  const terminalTypes: readonly string[] = descriptor.terminalTypes;
  const isRelevant = (event: WorkflowEvent): boolean =>
    event.type === descriptor.startType || terminalTypes.includes(event.type);
  return {
    filter: { streamId: featureId, eventTypes: [descriptor.startType, ...descriptor.terminalTypes] },
    relevant: (events) => events.filter(isRelevant),
    evaluate: (events) => {
      const inFlight = computeInFlightInstances(descriptor, events);
      if (inFlight.size === 0) {
        return { kind: 'resolved', detail: { predicate: 'operation', operation: descriptor.surface } };
      }
      return { kind: 'pending' };
    },
    timeoutDetail: { predicate: 'operation', operation: descriptor.surface },
  };
}

/** The feature-scoped liveness surfaces that `wait --operation` accepts. */
export function featureScopedSurfaces(): LivenessSurface[] {
  return LIVENESS_DESCRIPTORS.filter((d) => d.streamScope === 'feature').map((d) => d.surface);
}

/**
 * The valid `wait --phase` targets of a workflow type: the states of its HSM that are not
 * compound. A workflow is never in a compound state, so a compound target cannot resolve. The list
 * comes from `getHSMDefinition`, so a topology edit or a custom type needs no change here. Returns
 * `undefined` when the type has no registered topology. The caller then skips the phase check.
 */
export function topologyPhaseTargets(workflowType: string): readonly string[] | undefined {
  try {
    const hsm = getHSMDefinition(workflowType);
    return Object.values(hsm.states)
      .filter((state) => state.type !== 'compound')
      .map((state) => state.id)
      .sort();
  } catch {
    return undefined;
  }
}

function waitSuccess(
  detail: Record<string, unknown>,
  waitedMs: number,
  perf?: SubscriptionPerf,
): ToolResult {
  return {
    success: true,
    data: { resolved: true, waitedMs, ...detail, ...(perf ? { perf } : {}) },
  };
}

function waitFailed(
  detail: Record<string, unknown>,
  waitedMs: number,
  perf?: SubscriptionPerf,
): ToolResult {
  const terminal = typeof detail.terminalStatus === 'string' ? detail.terminalStatus : 'a terminal';
  const target =
    typeof detail.phase === 'string'
      ? `phase '${detail.phase}'`
      : typeof detail.status === 'string'
        ? `status '${detail.status}'`
        : 'the predicate';
  return {
    success: false,
    error: {
      code: 'WAIT_FAILED',
      message: `workflow reached terminal status '${terminal}' before ${target} — the predicate can no longer be satisfied`,
    },
    data: { reason: 'wait-failed', waitedMs, ...detail, ...(perf ? { perf } : {}) },
  };
}

function waitTimeoutResult(
  timeoutDetail: Record<string, unknown>,
  timeoutMs: number,
  waitedMs: number,
  perf?: SubscriptionPerf,
): ToolResult {
  return {
    success: false,
    error: {
      code: 'WAIT_TIMEOUT',
      message: `wait predicate was not satisfied within ${timeoutMs}ms`,
    },
    data: { reason: 'wait-timeout', timeoutMs, waitedMs, ...timeoutDetail, ...(perf ? { perf } : {}) },
  };
}

/**
 * Subscribe and race the predicate against the bounded deadline. The accumulator starts with the
 * precheck events, and the cursor starts at the precheck head. The initial drain of the
 * subscription then delivers each gap event once. Each exit disposes the subscription.
 *
 * The constructor runs the initial drain synchronously. When a gap event settles the predicate,
 * `handle` is still undefined in `finish`, so the function disposes it after the constructor returns.
 */
function subscribeUntil(
  eventStore: DispatchContext['eventStore'],
  predicate: Predicate,
  seedRelevant: readonly WorkflowEvent[],
  headSequence: number,
  timeoutMs: number,
  startedAt: number,
  deps: WaitDeps | undefined,
): Promise<ToolResult> {
  const nowFn = deps?.now ?? Date.now;
  return new Promise<ToolResult>((resolve) => {
    const accumulated: WorkflowEvent[] = [...seedRelevant];
    let settled = false;
    let handle: SubscriptionHandle | undefined;
    let cancelTimer: (() => void) | undefined;

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      cancelTimer?.();
      handle?.dispose();
      resolve(result);
    };

    const onEvent = (event: WorkflowEvent): void => {
      if (settled) return;
      accumulated.push(event);
      const verdict = predicate.evaluate(accumulated);
      if (verdict.kind === 'pending') return;
      const waitedMs = nowFn() - startedAt;
      const perf = handle?.perf();
      finish(
        verdict.kind === 'resolved'
          ? waitSuccess(verdict.detail, waitedMs, perf)
          : waitFailed(verdict.detail, waitedMs, perf),
      );
    };

    handle = eventStore.subscribe(
      predicate.filter,
      onEvent,
      { fromSequence: headSequence },
      deps?.subscriptionOptions,
    );

    if (settled) {
      handle.dispose();
      return;
    }

    const schedule = deps?.scheduleTimeout ?? defaultScheduleTimeout;
    cancelTimer = schedule(() => {
      const waitedMs = nowFn() - startedAt;
      finish(waitTimeoutResult(predicate.timeoutDetail, timeoutMs, waitedMs, handle?.perf()));
    }, timeoutMs);
  });
}

type PredicateAxis =
  | { readonly axis: 'phase'; readonly value: string }
  | { readonly axis: 'status'; readonly value: string }
  | { readonly axis: 'operation'; readonly value: string };

/** Extract exactly one feature-scoped predicate axis from args, or an error. */
function selectAxis(args: Record<string, unknown>): { axis: PredicateAxis } | { error: ToolResult } {
  const phase = parseField(phaseField, args.phase);
  const status = parseField(statusField, args.status);
  const operation = parseField(operationField, args.operation);
  const present = [
    phase !== undefined ? ({ axis: 'phase', value: phase } as const) : undefined,
    status !== undefined ? ({ axis: 'status', value: status } as const) : undefined,
    operation !== undefined ? ({ axis: 'operation', value: operation } as const) : undefined,
  ].filter((a): a is PredicateAxis => a !== undefined);

  if (present.length === 0) {
    return {
      error: invalidInput(
        'wait requires exactly one predicate: phase, status, operation, or until (worktree scope)',
        { expectedShape: { phase: 'string', status: 'string', operation: 'string', until: "'merge' | 'idle'" } },
      ),
    };
  }
  if (present.length > 1) {
    return {
      error: invalidInput(
        `wait accepts exactly one predicate axis; received ${present.map((p) => p.axis).join(', ')}`,
        { validTargets: ['phase', 'status', 'operation', 'until'] },
      ),
    };
  }
  return { axis: present[0]! };
}

/** Zod-field parse that treats empty/absent as "not provided". */
function parseField(field: { safeParse(v: unknown): { success: boolean; data?: unknown } }, value: unknown): string | undefined {
  const s = optionalString(value);
  if (s === undefined) return undefined;
  const parsed = field.safeParse(s);
  return parsed.success && typeof parsed.data === 'string' ? parsed.data : s;
}

/**
 * Delay ceiling of Node `setTimeout`: 2^31-1 ms, about 24.85 days. A larger delay does not clamp.
 * It becomes 1 ms, so a large `timeoutMs` without this cap gives a near-instant `WAIT_TIMEOUT`.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** Resolve the timeout budget (positive int, clamped to the timer ceiling) or the default. */
function resolveTimeoutMs(args: Record<string, unknown>): number {
  const raw = args.timeoutMs;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return Math.min(raw, MAX_TIMER_MS);
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return Math.min(n, MAX_TIMER_MS);
  }
  return DEFAULT_WAIT_TIMEOUT_MS;
}

/**
 * The generic event-driven gate. It appends no event on any path.
 *
 * Without a `phase`, `status` or `operation`, the call goes to the worktree kernel. That kernel
 * handles `until: merge|idle` on the singleton `worktrees` stream, with `merge` as the default. A
 * feature predicate together with `until` is invalid, because it mixes two scopes. An unknown
 * featureId returns `INVALID_INPUT` after one read, with no subscription and no event.
 *
 * Each feature axis rejects a target that cannot occur. It rejects a `phase` outside the registered
 * HSM of the workflow type, a `status` that is not terminal, and a surface without feature scope.
 */
export async function handleViewWait(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: WaitDeps,
): Promise<ToolResult> {
  const hasFeaturePredicate =
    optionalString(args.phase) !== undefined ||
    optionalString(args.status) !== undefined ||
    optionalString(args.operation) !== undefined;

  if (hasFeaturePredicate && args.until !== undefined) {
    return invalidInput(
      'wait: `until` (worktree scope) cannot be combined with a feature predicate (phase/status/operation)',
      { validTargets: ['phase', 'status', 'operation', 'until'] },
    );
  }
  if (!hasFeaturePredicate) {
    return handleWorktreeUntilWait(args, ctx, deps);
  }

  const startedAt = deps?.now?.() ?? Date.now();
  const { eventStore } = ctx;

  const featureId = optionalString(args.featureId);
  if (!featureId) {
    return invalidInput('wait requires featureId: string for a phase/status/operation predicate', {
      expectedShape: { featureId: 'string' },
    });
  }

  const selected = selectAxis(args);
  if ('error' in selected) return selected.error;
  const { axis } = selected;

  const events = await eventStore.query(featureId);
  if (events.length === 0) {
    return invalidInput(
      `wait: unknown featureId '${featureId}' — no such workflow (nothing to wait on)`,
      { expectedShape: { featureId: 'an existing workflow id' } },
    );
  }
  const headSequence = events[events.length - 1]?.sequence ?? 0;

  let predicate: Predicate;
  if (axis.axis === 'operation') {
    const built = buildOperationPredicate(featureId, axis.value);
    if ('error' in built) return built.error;
    predicate = built.predicate;
  } else {
    const resolved = await resolveWorkflowState({ featureId, eventStore });
    if ('error' in resolved) return resolved.error;
    const seedPhase = typeof resolved.state.phase === 'string' ? resolved.state.phase : '';
    if (axis.axis === 'phase') {
      const workflowType =
        typeof resolved.state.workflowType === 'string' ? resolved.state.workflowType : '';
      const validPhases = topologyPhaseTargets(workflowType);
      if (validPhases !== undefined && !validPhases.includes(axis.value)) {
        return invalidInput(
          `wait --phase '${axis.value}' is not a phase in the '${workflowType}' workflow topology — the workflow can never enter it`,
          {
            validTargets: validPhases,
            expectedShape: { phase: 'a phase in the workflow topology' },
          },
        );
      }
      predicate = phasePredicate(featureId, axis.value, seedPhase);
    } else {
      if (!isWaitTerminal(axis.value)) {
        return invalidInput(
          `wait --status '${axis.value}' is not a terminal workflow status — a status predicate resolves only on completed/failed/cancelled`,
          {
            validTargets: [...WAIT_TERMINAL_STATUSES],
            expectedShape: { status: 'a terminal workflow status (completed/failed/cancelled)' },
          },
        );
      }
      predicate = statusPredicate(featureId, axis.value, seedPhase);
    }
  }

  const seedRelevant = predicate.relevant(events);
  const verdict = predicate.evaluate(seedRelevant);
  if (verdict.kind === 'resolved') return waitSuccess(verdict.detail, 0);
  if (verdict.kind === 'failed') return waitFailed(verdict.detail, 0);

  const timeoutMs = resolveTimeoutMs(args);
  return subscribeUntil(eventStore, predicate, seedRelevant, headSequence, timeoutMs, startedAt, deps);
}

/**
 * Build the `operation` predicate. The surface must be a registered liveness surface with feature
 * scope. Any other surface returns `INVALID_INPUT` with the feature-scoped `validTargets` and a
 * `suggestedFix` for the `until` worktree predicates.
 */
function buildOperationPredicate(
  featureId: string,
  surface: string,
): { predicate: Predicate } | { error: ToolResult } {
  const valid = featureScopedSurfaces();
  const descriptor = (LIVENESS_REGISTRY as Record<string, LivenessDescriptor | undefined>)[surface];
  if (descriptor === undefined) {
    return {
      error: invalidInput(
        `wait --operation '${surface}' is not a known liveness surface`,
        {
          validTargets: valid,
          suggestedFix: { tool: 'exarchos_view', params: { action: 'wait', until: 'merge' } },
        },
      ),
    };
  }
  if (descriptor.streamScope !== 'feature') {
    return {
      error: invalidInput(
        `wait --operation '${surface}' is a worktrees-scoped surface — not feature-observable. Use the worktree scope (\`wait --until merge|idle\`) for launch/prune.`,
        {
          validTargets: valid,
          suggestedFix: { tool: 'exarchos_view', params: { action: 'wait', until: 'merge' } },
        },
      ),
    };
  }
  return { predicate: operationPredicate(featureId, descriptor) };
}
