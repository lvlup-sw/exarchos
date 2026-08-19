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
  | 'process-hook';

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
]);
