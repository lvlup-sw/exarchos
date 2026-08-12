// ─── Lifecycle verb: `wait` — event-driven gate (DR-5 / DR-8) ─────────────────
//
// The one lifecycle verb that BLOCKS: it resolves when a predicate over the
// event log becomes true, or returns a STRUCTURED timeout/failure. It is a
// PURE CONSUMER (INV-1 / #1316 Q7) — it appends NOTHING on every path: no
// `wait.started`/`wait.completed` self-journaling, no phantom stream. The log
// records domain facts, not observations of them.
//
// ## Two-part shape: precheck, then subscription
//
//   1. PRECHECK — fold the feature stream ONCE and evaluate the predicate. If it
//      is ALREADY satisfied (or already failed), return immediately WITHOUT ever
//      registering a subscription (the "already past `--phase plan-review`"
//      case: exit 0, no floor tick consumed).
//   2. SUBSCRIPTION — otherwise register a DR-1 cursor-pump subscription
//      (`events/subscriptions.ts`) filtered to the predicate's event types,
//      seeded at the precheck head so no event is missed in the gap. The
//      subscription's two wake tiers do the work: Tier-1 (in-process post-commit
//      hook) resolves an own-process transition with no floor tick; Tier-2 (the
//      cross-process poll floor) resolves a FOREIGN connection's event within one
//      floor interval. A bounded deadline timer guarantees the wait NEVER hangs —
//      expiry returns a structured `WAIT_TIMEOUT`.
//
// ## Predicates (exactly one axis per call)
//
//   • `phase`     — resolves when the workflow has entered the target phase
//                   (already-visited ⇒ immediate). A terminal (`failed` /
//                   `cancelled`) arriving first makes the phase unreachable ⇒
//                   `WAIT_FAILED`.
//   • `status`    — resolves on the REQUESTED terminal status
//                   (`completed`/`failed`/`cancelled`); a DIFFERENT terminal ⇒
//                   `WAIT_FAILED`; already-terminal ⇒ immediate.
//   • `operation` — the S-6 predicate: resolves when the feature's unpaired
//                   `<surface>.executing_started` (by instance key, via the DR-2
//                   liveness registry) gains its terminal; none in flight ⇒
//                   immediate. FEATURE-SCOPED surfaces only (`merge`, `mutation`);
//                   a `worktrees`-scoped surface (`launch`, `prune`) is not
//                   feature-observable and returns `INVALID_INPUT` with the
//                   feature-scoped `validTargets` and a `suggestedFix` → `until`.
//   • `until`     — the WLM-6 worktree predicates (`merge` / `idle` +
//                   `integrationRef`), retained as the WORKTREE SCOPE of this
//                   same verb: absorbed by delegating to the kernel in
//                   `orchestrate/worktree/handlers.ts`.
//
// The SCOPE axis is expressed by WHICH predicate field is set — never a `scope`
// field (task-019 pins the shared `scope` shape to `z.enum(['repo','all'])` to
// match `pipeline.scope`, so a `workflow|worktree` `scope` would THROW at MCP
// registration). `phase`/`status`/`operation` are imported from the DR-8
// `schema-fields.ts` SoT so their base types cannot drift across lifecycle verbs.
// ─────────────────────────────────────────────────────────────────────────────

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
import { resolveWorkflowState } from '../../../orchestrate/resolve-state.js';
import { getHSMDefinition } from '../../../workflow/state-machine.js';
import { DEFAULT_WAIT_TIMEOUT_MS } from '../../../orchestrate/worktree/manager.js';
import {
  handleWorktreeUntilWait,
  type WorktreeViewDeps,
} from '../../../orchestrate/worktree/handlers.js';
import { phaseField, statusField, operationField } from './schema-fields.js';

// ─── Terminal-status vocabulary (DR-5) ────────────────────────────────────────

/**
 * The workflow terminal statuses a `status` predicate may request AND the set a
 * `phase` predicate treats as "the workflow ended elsewhere" (⇒ target
 * unreachable ⇒ `WAIT_FAILED`). Mirrors the SDK `isTerminal` vocabulary and the
 * `schema-fields.ts` `status` doc — `completed`/`cancelled` are the built-in HSM
 * terminal phases (`workflow/terminal-phases.ts`) and `failed` is admitted for
 * workflow types that fail out. Each is reached via a `workflow.transition`
 * whose `to` equals the status (cancel folds through `workflow.transition` too —
 * `workflow/events.ts` maps the internal `transition` event).
 */
const WAIT_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/** Event types that carry a phase `{ from, to }` (both fold to a phase change). */
const TRANSITION_EVENT_TYPES = ['workflow.transition', 'workflow.cancel'] as const;

function isWaitTerminal(phase: string): boolean {
  return (WAIT_TERMINAL_STATUSES as readonly string[]).includes(phase);
}

// ─── Local input helpers (kept private — never user-facing flags) ─────────────

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

// ─── Deps ──────────────────────────────────────────────────────────────────────

/**
 * `wait` DI seam. Extends {@link WorktreeViewDeps} (so the `until` worktree
 * scope's timing/process seams pass straight through to the absorbed WLM-6
 * kernel) with the two feature-scope timing seams:
 *   - `subscriptionOptions` — threaded to `eventStore.subscribe`'s registry
 *     options so a test can inject a `ManualClock` and drive the Tier-2 floor
 *     tick-by-tick (the foreign-connection determinism seam, INV-16);
 *   - `scheduleTimeout` — the bounded-deadline scheduler, so the `WAIT_TIMEOUT`
 *     path is deterministic (a test fires the deadline directly).
 * Production dispatch omits every field → real `setTimeout` deadline + the
 * registry's real unref'd floor.
 */
export interface WaitDeps extends WorktreeViewDeps {
  readonly subscriptionOptions?: SubscriptionRegistryOptions;
  /** Monotone clock for the wait deadline / waitedMs. Defaults to `Date.now`. (Also in WorktreeViewDeps.) */
  readonly now?: () => number;
  /** One-shot deadline scheduler; returns an idempotent canceller. Defaults to `setTimeout`. */
  readonly scheduleTimeout?: (cb: () => void, ms: number) => () => void;
}

function defaultScheduleTimeout(cb: () => void, ms: number): () => void {
  const timer = setTimeout(cb, ms);
  // Never keep the process alive on the deadline alone (the dispatch owns liveness).
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

// ─── Predicate model (pure) ────────────────────────────────────────────────────

/**
 * A predicate verdict over an ordered slice of relevant events. Pure and total:
 * both the precheck (full history) and the live path (accumulated deliveries)
 * fold through the SAME {@link Predicate.evaluate}, so "resolves iff satisfied"
 * holds by construction — the property test pins exactly this.
 */
export type WaitVerdict =
  | { readonly kind: 'pending' }
  | { readonly kind: 'resolved'; readonly detail: Record<string, unknown> }
  | { readonly kind: 'failed'; readonly detail: Record<string, unknown> };

/** A feature-scoped wait predicate: a subscription filter + a pure evaluator. */
export interface Predicate {
  /** The DR-1 subscription filter this predicate observes. */
  readonly filter: SubscriptionFilter;
  /** Narrow a full event history to the subset this predicate reasons over. */
  relevant(events: readonly WorkflowEvent[]): readonly WorkflowEvent[];
  /** Fold a relevant-event slice → verdict. Pure; deterministic; total. */
  evaluate(events: readonly WorkflowEvent[]): WaitVerdict;
  /** The predicate-identifying fields stamped onto a `WAIT_TIMEOUT`. */
  readonly timeoutDetail: Record<string, unknown>;
}

/**
 * `phase` predicate. Resolves once the target phase has been ENTERED (present in
 * the visited set: the seed/current phase plus every transition `from`/`to`),
 * which makes "already past `--phase X`" resolve at precheck. A terminal status
 * reached without the target ⇒ the target is unreachable ⇒ `failed`.
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
 * `status` predicate. Resolves when the workflow's latest phase equals the
 * REQUESTED terminal status; a DIFFERENT terminal status ⇒ `failed`.
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
 * `operation` predicate (S-6). Resolves when the feature has NO in-flight
 * instance of `descriptor.surface` — i.e. every `<surface>.executing_started`
 * has gained its terminal, paired by the DR-2 registry's instance key. None in
 * flight ⇒ immediate. Never `failed` (a surface simply goes idle or times out).
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

/** The DR-2 feature-scoped liveness surfaces `wait --operation` accepts. */
export function featureScopedSurfaces(): LivenessSurface[] {
  return LIVENESS_DESCRIPTORS.filter((d) => d.streamScope === 'feature').map((d) => d.surface);
}

/**
 * The valid `wait --phase` targets for a workflow type (DR-8): every WAITABLE
 * phase in that type's HSM topology — the atomic + final states a workflow can
 * actually be IN. Compound states are excluded because a workflow's phase is
 * always an atomic leaf (or a final terminal), never a compound container, so a
 * `--phase implementation` wait could never resolve.
 *
 * Derived from the REAL HSM registry (`getHSMDefinition`) — never a hardcoded
 * list — so a topology edit or a custom-registered workflow type is reflected
 * with no change here, and the targets are per-TYPE (feature ≠ refactor).
 * Returns `undefined` for a type with NO registered topology (`getHSMDefinition`
 * throws): the caller then SKIPS phase validation, so an un-topologized/custom
 * type keeps the pre-DR-8 permissive behavior rather than rejecting a
 * legitimate wait it cannot adjudicate.
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

// ─── Result envelopes (structured, never-hang) ────────────────────────────────

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

// ─── Subscription-driven wait (never hangs) ───────────────────────────────────

/**
 * Register the DR-1 subscription and race predicate resolution against the
 * bounded deadline. Seeds the accumulator with the precheck-relevant events and
 * the precheck head sequence so an event landing in the precheck→subscribe gap
 * is delivered by the subscription's unconditional initial drain (no gap, no
 * double). Disposes the subscription on every exit (INV-15 — no daemon).
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

    // The subscription constructor runs its initial drain SYNCHRONOUSLY: if a
    // gap event already satisfied the predicate, `onEvent` ran with `handle`
    // still undefined, so `finish` could not dispose. Dispose now and skip the
    // deadline entirely.
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

// ─── Predicate selection + feature-scope gating ───────────────────────────────

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
 * Node's `setTimeout` delay ceiling (2^31-1 ms ≈ 24.85 days). A delay ABOVE
 * this does not clamp — it silently wraps to 1ms and fires almost immediately,
 * which would turn an over-large `timeoutMs` into a near-instant WAIT_TIMEOUT:
 * the exact opposite of the caller's "wait longer" intent.
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

// ─── Handler ────────────────────────────────────────────────────────────────────

/**
 * `wait` — the generic event-driven gate. Routes the `until` worktree scope to
 * the absorbed WLM-6 kernel; otherwise runs a feature-scoped phase / status /
 * operation predicate as precheck-then-subscription. Appends ZERO events on
 * every path.
 */
export async function handleViewWait(
  args: Record<string, unknown>,
  ctx: DispatchContext,
  deps?: WaitDeps,
): Promise<ToolResult> {
  // ── Scope routing ────────────────────────────────────────────────────────────
  // A FEATURE predicate (phase/status/operation) selects the feature scope; its
  // ABSENCE routes to the WORKTREE SCOPE — the absorbed WLM-6 kernel, which
  // handles `until: merge|idle` (defaulting to 'merge', preserving the shipped
  // contract) over the singleton `worktrees` stream. So an explicit `until`, a
  // bare `integrationRef` merge-wait, and a bare no-arg call all reach the kernel
  // unchanged; only a phase/status/operation call takes the feature path below.
  const hasFeaturePredicate =
    optionalString(args.phase) !== undefined ||
    optionalString(args.status) !== undefined ||
    optionalString(args.operation) !== undefined;

  // `until` is the worktree scope's own selector — combining it with a feature
  // predicate mixes two scopes in one call, which has no coherent meaning.
  if (hasFeaturePredicate && args.until !== undefined) {
    return invalidInput(
      'wait: `until` (worktree scope) cannot be combined with a feature predicate (phase/status/operation)',
      { validTargets: ['phase', 'status', 'operation', 'until'] },
    );
  }
  if (!hasFeaturePredicate) {
    // Worktree scope: appends nothing; operates on `worktrees`, not a featureId,
    // so there is NO feature cold-probe here — WLM-6 behavior preserved exactly.
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

  // ── Cold-probe: an unknown / never-init'd featureId is a side-effect-free
  //    error (DR-8) — one pure read, no stream registration, no events. ──────────
  const events = await eventStore.query(featureId);
  if (events.length === 0) {
    return invalidInput(
      `wait: unknown featureId '${featureId}' — no such workflow (nothing to wait on)`,
      { expectedShape: { featureId: 'an existing workflow id' } },
    );
  }
  // The precheck head: the subscription seeds its cursor here so the gap between
  // this fold and registration is closed by the initial drain (no missed event).
  const headSequence = events[events.length - 1]?.sequence ?? 0;

  // ── Build the predicate (operation gates its surface here) ───────────────────
  let predicate: Predicate;
  if (axis.axis === 'operation') {
    const built = buildOperationPredicate(featureId, axis.value);
    if ('error' in built) return built.error;
    predicate = built.predicate;
  } else {
    // phase / status need the current phase as a seed (canonical resolver).
    const resolved = await resolveWorkflowState({ featureId, eventStore });
    if ('error' in resolved) return resolved.error;
    const seedPhase = typeof resolved.state.phase === 'string' ? resolved.state.phase : '';
    if (axis.axis === 'phase') {
      // ── Phase-target topology validation (DR-8) ─────────────────────────────
      // The `--phase` target must be a real phase in THIS workflow type's HSM
      // topology — not a hardcoded list. An off-topology phase can NEVER be
      // entered, so the pre-DR-8 permissive behavior (subscribe, then block until
      // the deadline) was a guaranteed WAIT_TIMEOUT masquerading as a live wait.
      // Fail fast with a self-correcting `INVALID_INPUT` whose `validTargets` are
      // the topology's waitable phases FOR THE WORKFLOW'S TYPE (feature ≠
      // refactor), so the caller sees exactly which phases exist. Skipped only
      // for a type with no registered topology (`topologyPhaseTargets` →
      // undefined), preserving the permissive path there.
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
      // ── Status-target terminality validation (DR-8, symmetric with --phase/--operation) ──
      // A `status` predicate resolves only on a WORKFLOW-TERMINAL status
      // (completed/failed/cancelled — `WAIT_TERMINAL_STATUSES`). A non-terminal
      // value (e.g. a mid-pipeline phase like `delegate`) is not a status at
      // all: the pre-fix code built a statusPredicate that resolved immediately
      // on phase-equality, silently conflating status with phase. Reject it up
      // front — mirroring the topology guard on `--phase` and the surface guard
      // on `--operation` so all three axes fail fast on an unreachable target.
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

  // ── Precheck: resolve/fail without ever subscribing when already decided ─────
  const seedRelevant = predicate.relevant(events);
  const verdict = predicate.evaluate(seedRelevant);
  if (verdict.kind === 'resolved') return waitSuccess(verdict.detail, 0);
  if (verdict.kind === 'failed') return waitFailed(verdict.detail, 0);

  // ── Subscribe-until (Tier-1 wake / Tier-2 floor) with a bounded deadline ─────
  const timeoutMs = resolveTimeoutMs(args);
  return subscribeUntil(eventStore, predicate, seedRelevant, headSequence, timeoutMs, startedAt, deps);
}

/**
 * Build the `operation` predicate, gating the surface: it must be a registered
 * DR-2 liveness surface AND feature-scoped (`merge`/`mutation`). A worktrees-
 * scoped surface (`launch`/`prune`) is not feature-observable ⇒ `INVALID_INPUT`
 * with the feature-scoped `validTargets` and a `suggestedFix` pointing at the
 * `until` worktree predicates.
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
