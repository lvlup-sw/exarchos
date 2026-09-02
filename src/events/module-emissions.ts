/**
 * Emitters that are NOT dispatched actions.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * The emission model knows exactly one shape: an action declares `autoEmits`
 * and the registry walk turns that into `(event, action, declaringTool)`. Every
 * check downstream reads that population, so an append performed by anything
 * other than a dispatched action is invisible to all of them — it cannot be
 * declared, which means it cannot be checked, which means it reads as an event
 * nothing emits.
 *
 * A wrapper that runs around EVERY action is the clearest case. Declaring its
 * append on all of them would assert that each action independently emits the
 * telemetry row, which is false in every instance and would put a hundred-odd
 * edges into the comparison naming one append site. Declaring it on one action
 * is worse: it would be arbitrary and it would read as that action's effect.
 * Neither is a modelling problem with the wrapper. It is a modelling problem
 * with a vocabulary that has only one word.
 *
 * ── What a row asserts, and how it is falsified ─────────────────────────────
 *
 * A row says: THIS module appends THIS event, for THIS structural reason. Both
 * halves are checkable against the tree rather than against another table.
 *
 *   • The module must actually appear in the measured append-site census for
 *     that event. A row whose site is gone is a `PHANTOM_MODULE_EMISSION` — the
 *     same no-stale-cover ratchet the rest of this layer uses, because a
 *     declaration that outlives its subject is a claim the tree does not
 *     support.
 *   • Conversely, a measured append site explained by neither an action edge
 *     nor a row here is an `UNDECLARED_APPEND_SITE`. That direction is what
 *     makes the accounting TOTAL: without it, this table would only ever
 *     describe what somebody remembered to write down.
 *
 * `trigger` is a CLOSED union on purpose, and for the reason `SubstrateRationale`
 * is closed: if it were free text, `{ trigger: 'because' }` would be
 * constructible for any module and the whole channel would collapse into an
 * escape hatch for "an action could not be found". Claiming a trigger means
 * claiming one of these specific mechanisms.
 *
 * The union may still GROW, and that is not a loophole: a new member is a
 * mechanism argued once, in a comment, for every row that will ever use it.
 * What the closure buys is that the argument has to be made at the type before
 * a row can be written, rather than improvised per row in free text.
 */

/**
 * How a module comes to append an event without being a dispatched action.
 *
 * Each member names a mechanism that structurally cannot be an action's
 * declared effect — not merely a case where nobody has declared one yet.
 */
export type ModuleEmitterTrigger =
  /** Wraps the handler for EVERY action; the append is the wrapper's effect, not any action's. */
  | 'dispatch-wrapper'
  /** Runs inside the dispatch pipeline around a handler, independent of which action ran. */
  | 'dispatch-interceptor'
  /** Fires when a durable append succeeds — triggered by another event landing, not a call. */
  | 'success-hook'
  /** Drains an observer sink installed at process wiring; records what it observed. */
  | 'observer-drain'
  /** Fired by the harness or runtime lifecycle rather than by a dispatch. */
  | 'process-hook'
  /**
   * Published from a shared path that every read of its kind traverses. The
   * append REPORTS what the read observed about state somebody else wrote, so
   * it is the read path's effect and no reader's.
   */
  | 'read-path-publisher'
  /**
   * A store keeping its own record, driven by a protocol surface that is not
   * the registry's action surface — so there is no action to declare it on.
   */
  | 'store-internal'
  /**
   * A shared resolution library that several unrelated entry points call. The
   * append records what resolution concluded; picking one caller to own it
   * would silence the row while asserting a false owner.
   */
  | 'shared-resolver';

export interface ModuleEmission {
  /** The event type appended. */
  readonly event: string;
  /**
   * The module performing the append, relative to the governed source root
   * (`src/`), forward-slashed — the same identity the append-site census uses,
   * so the two can be compared without a translation step.
   */
  readonly module: string;
  readonly trigger: ModuleEmitterTrigger;
  /** Why no action can carry this edge. States the mechanism, not the absence of a declaration. */
  readonly rationale: string;
}

const TELEMETRY_WRAPPER =
  'The dispatch telemetry wrapper runs around the handler for EVERY action, appends after the ' +
  'handler returns keyed by the tool it was invoked with, and swallows its own failures so a ' +
  'telemetry drop can never fail a workflow. No single action performs it, and declaring it on ' +
  'all of them would assert that each one independently emits the row.';

const ELICITATION_PROTOCOL =
  'The elicitation round-trip is conducted by the dispatch pipeline on behalf of whichever action ' +
  'arrived missing a required field. Every action can reach it and none of them chooses it, so ' +
  'attributing the protocol to actions would make each one a declared emitter of a negotiation the ' +
  'pipeline runs for it. Same shape as the emission verifier below.';

const WORKTREE_CREATE_PAIR =
  'Appended from the launcher as a child worktree is provisioned, driven by the runtime lifecycle ' +
  'rather than by a dispatched call — the same reading the launcher liveness row below carries. ' +
  'Crash recovery re-appends the terminal half from a LATER process, replaying an intent whose ' +
  'originating dispatch is gone, so no live action invocation bounds the pair.';

const PROJECTION_HEALTH =
  'Published from the shared view read path, which every view read traverses: the read clears or ' +
  'records the projection-health row for the stream it just read, keyed on the cursor/tail pair it ' +
  'observed. The append reports on a projection somebody else advanced, and it is reached ' +
  'identically by every view action, so it is the effect of none of them.';

const TASK_STORE =
  'The event-sourced task store journals its own record. Its callers arrive through the protocol ' +
  'method surface for long-running tasks, which is not the registry action surface, so there is no ' +
  'action whose declared effect this could be.';

const SHADOW_OBSERVER =
  'Appended on the observer sink drain, from a target installed when the process is wired. The ' +
  'event records what the shadow evaluation OBSERVED about a transition somebody else performed, ' +
  'so there is no action whose effect it is: the action that triggered the transition did not ' +
  'emit it, and the observer is not an action. The reserved append registry confirms the same ' +
  'reading from the other side — a caller-minted one is refused.';

/**
 * The declared non-action emitters.
 *
 * SHRINK-ONLY in the sense that matters: a row may only be deleted when its
 * append genuinely moves under an action, and the phantom check fails any row
 * whose site is gone. It GROWS legitimately whenever a real non-action emitter
 * is identified, which is not debt — it is the model catching up with the tree.
 */
export const MODULE_EMISSIONS: readonly ModuleEmission[] = Object.freeze([
  {
    event: 'tool.invoked',
    module: 'projections/telemetry/middleware.ts',
    trigger: 'dispatch-wrapper',
    rationale: TELEMETRY_WRAPPER,
  },
  {
    event: 'tool.completed',
    module: 'projections/telemetry/middleware.ts',
    trigger: 'dispatch-wrapper',
    rationale: TELEMETRY_WRAPPER,
  },
  {
    event: 'tool.errored',
    module: 'projections/telemetry/middleware.ts',
    trigger: 'dispatch-wrapper',
    rationale: TELEMETRY_WRAPPER,
  },
  {
    event: 'tool.action_errored',
    module: 'projections/telemetry/middleware.ts',
    trigger: 'dispatch-wrapper',
    rationale: TELEMETRY_WRAPPER,
  },
  {
    event: 'admission.cutover-ready',
    module: 'workflow/admission/cutover-auto-export.ts',
    trigger: 'success-hook',
    rationale:
      'The append runs inside a durable-append SUCCESS HOOK configured at context initialization ' +
      "and fired from the shadow observer's settlement chain. Its trigger is another event " +
      'landing, not an action being dispatched, and it is single-flight and self-suppressing once ' +
      'it has exported — so no action invocation reliably produces it and none of them owns it.',
  },
  {
    event: 'admission.shadow-attempt',
    module: 'workflow/admission/live-shadow-observer.ts',
    trigger: 'observer-drain',
    rationale: SHADOW_OBSERVER,
  },
  {
    event: 'admission.disagreement-disposition',
    module: 'workflow/admission/live-shadow-observer.ts',
    trigger: 'observer-drain',
    rationale: SHADOW_OBSERVER,
  },
  {
    event: 'subagent.tokens_used',
    module: 'lifecycle/subagent-stop.ts',
    trigger: 'process-hook',
    rationale:
      'Appended by the SubagentStop hook, which the harness fires when a subagent terminates. ' +
      'The dispatch that started the subagent has long returned, so the append belongs to no ' +
      'action still in flight, and the hook is not itself reachable through the tool surface.',
  },
  {
    event: 'launch.executing_started',
    module: 'runtime/launcher/liveness.ts',
    trigger: 'process-hook',
    rationale:
      'Appended from the launcher liveness path as a child process starts, driven by the runtime ' +
      'lifecycle rather than by a dispatched call. The terminal half of the pair is reachable ' +
      'from a probing action; this opening half is not.',
  },
  {
    event: 'emission.violated',
    module: 'dispatch/core/interceptors/emission-verifier.ts',
    trigger: 'dispatch-interceptor',
    rationale:
      'The post-dispatch emission verifier writes its finding from inside the dispatch pipeline, ' +
      'after the handler it is assessing has already returned. The append reports on whichever ' +
      'action just ran, so attributing it to that action would make every action a declared ' +
      'emitter of the report about itself.',
  },
  {
    event: 'session.machinery_consumed',
    module: 'dispatch/core/interceptors/session-machinery.ts',
    trigger: 'dispatch-interceptor',
    rationale:
      'Appended by a dispatch interceptor that records machinery consumption for the session, ' +
      'independent of which action was routed. Same shape as the emission verifier beside it.',
  },
  {
    event: 'elicitation.requested',
    module: 'dispatch/elicitation-dispatch.ts',
    trigger: 'dispatch-interceptor',
    rationale: ELICITATION_PROTOCOL,
  },
  {
    event: 'elicitation.fulfilled',
    module: 'dispatch/elicitation-dispatch.ts',
    trigger: 'dispatch-interceptor',
    rationale: ELICITATION_PROTOCOL,
  },
  {
    event: 'elicitation.declined',
    module: 'dispatch/elicitation-dispatch.ts',
    trigger: 'dispatch-interceptor',
    rationale: ELICITATION_PROTOCOL,
  },
  {
    event: 'workspace.resolved',
    module: 'runtime/workspace/discovery.ts',
    trigger: 'dispatch-interceptor',
    rationale:
      'Appended while resolving the workspace for a call that supplied no featureId. Its sole ' +
      'caller is the pre-handler inferred-value step, which runs before routing and is told ' +
      'nothing about which action it is resolving for — the append precedes any action taking ' +
      'effect, so none of them can carry it.',
  },
  {
    event: 'worktree.create.requested',
    module: 'runtime/launcher/create-worktree.ts',
    trigger: 'process-hook',
    rationale: WORKTREE_CREATE_PAIR,
  },
  {
    event: 'worktree.create.executed',
    module: 'runtime/launcher/create-worktree.ts',
    trigger: 'process-hook',
    rationale: WORKTREE_CREATE_PAIR,
  },
  {
    event: 'projection.degraded',
    module: 'projections/freshness.ts',
    trigger: 'read-path-publisher',
    rationale: PROJECTION_HEALTH,
  },
  {
    event: 'projection.recovered',
    module: 'projections/freshness.ts',
    trigger: 'read-path-publisher',
    rationale: PROJECTION_HEALTH,
  },
  {
    event: 'quality.regression',
    module: 'projections/quality/regression-detector.ts',
    trigger: 'read-path-publisher',
    rationale:
      'The detector OBSERVES consecutive gate failures while the code-quality view folds its ' +
      'stream, and the view handler publishes what it saw. A view reports; it does not effect. The ' +
      'failures being reported were produced by other actions on earlier dispatches, and the ' +
      'append is fire-and-forget with its own errors swallowed, so no invocation reliably ' +
      'produces it.',
  },
  {
    event: 'task.created',
    module: 'projections/task-store/event-sourced-task-store.ts',
    trigger: 'store-internal',
    rationale: TASK_STORE,
  },
  {
    event: 'task.polled',
    module: 'projections/task-store/event-sourced-task-store.ts',
    trigger: 'store-internal',
    rationale:
      `${TASK_STORE} This half is additionally best-effort: it is throttled to at most one row per ` +
      'interval, its failures are swallowed, and no projection handler folds it. It records that a ' +
      'poll happened and nothing downstream reads it back.',
  },
  {
    event: 'command.resolved',
    module: 'config/test-runtime-resolver.ts',
    trigger: 'shared-resolver',
    rationale:
      'The toolchain resolver journals one row per resolved field, and three unrelated entry ' +
      'points reach it: dispatch onboarding reconciliation, the doctor probes, and init seeding. ' +
      'No one of them owns the append, and declaring it on the probing action alone would explain ' +
      'the row while naming an owner the other two callers contradict.',
  },
]);
