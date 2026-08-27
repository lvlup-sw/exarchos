// ─── Seeded-break fixtures + live-system subjects for the oracle (P03-09) ────
//
// PROGRAM-03, API-010. Three fixture families:
//
//  1. SEEDED BREAKS (`seededBreak(axis)`) — for each of the five axes, a pair
//     `{ correct, broken }` of subjects whose DECLARATION is byte-identical and
//     that differ ONLY in the handler's behavior. Because the declaration is
//     identical, the generation route (`deriveGeneratedDescriptor`) emits a
//     byte-identical artifact for both — i.e. "the generated files all agree" —
//     yet the broken handler misbehaves on exactly one axis. This is what proves
//     the oracle catches what generation-consistency cannot (exit proof g).
//
//     Each break is isolated to a single axis: the malformed break violates a
//     TYPE (present key, wrong type) so it does not perturb the output SHAPE the
//     compatibility axis reads; the compatibility break drops an OPTIONAL key so
//     it still satisfies the output schema; every non-authorization break keeps
//     the authorization guard so only its own axis goes red.
//
//  2. LIVE OUTPUT SUBJECTS (`liveOutputSubjects`, `liveSuccessOutputSubjects`) —
//     real `TOOL_REGISTRY` actions whose observed behavior is the REAL runtime
//     envelope (`format.ts` `wrapError` / `wrap`) validated against each action's
//     REAL declared `outputSchema`. This exercises the output axis across the
//     whole live surface without invoking business logic.
//
//  3. REAL-HANDLER SUBJECTS (`realHandlerSubjects`, `realRegistryAuthorizationCase`)
//     — DR-24. Real handlers, resolved through the REAL implementation-binding
//     table (`contract/bindings/binding-table.ts` → dispatch's
//     `COMPOSITE_HANDLER_LOADERS`), invoked against a real `DispatchContext`.
//
// ## DR-24 — the declaration is REGISTRY-DERIVED, and absence is `not-observed`
//
// Every live/real subject's `requiredRoles` and `declaredEffects` come from the
// REAL action registry (`ToolAction.roles`, `ToolAction.annotations`) via
// {@link realActionDeclaration} — never from a literal in this file. Before
// DR-24 both arrays were hard-coded empty, which made the authorization, effect
// and compatibility axes structurally incapable of reporting anything about the
// shipped system while still reading `pass`.
//
// Populating them does NOT manufacture observation: an axis the oracle did not
// actually exercise now reports `not-observed`, which is not a passing outcome
// (see `oracle-seam.ts`). Concretely, on the live surface:
//
//   • output — genuinely observed (real envelopes / real handler returns);
//   • authorization — observed only where a real {@link AuthorizationSurface}
//     lets the oracle withhold a principal AND the action declares a
//     restrictive role. Most built-ins declare the open-role marker `any`, so
//     they report `not-observed` with that stated reason;
//   • effects — `not-observed` for real handlers: the composite handlers do not
//     emit through the oracle's effect recorder, so there is no evidence, and
//     an empty recorder must not read as a clean bill.
//   • emissions — the declaration carries the registry's own `{event,
//     condition}` set, and only an `always` edge can produce a verdict. The
//     canned-envelope subjects withhold it entirely: their observed function is
//     not the handler, so there is no append to attribute to them.
//
// This is a test-fixtures module (auto-classified by the `fixtures.ts` name); it
// is imported only by the oracle's co-located tests.
// ────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import {
  TOOL_REGISTRY,
  contractEmissionsOf,
  none,
  validateAction,
  withActionContract,
  type CompositeTool,
  type ExtensionActionDraft,
  type ExtensionToolAction,
  type ToolAction,
} from '../../registry.js';
import { EnvelopeSchema } from '../schemas/envelope.js';
import { unregisteredActionOutputSchema } from '../../output-schema-declaration.js';
import { toEnvelope, wrap, wrapError, type ToolResult } from '../../format.js';
import {
  buildBindingTable,
  isImplementationBinding,
  type CompositeHandlerLoader,
  type ImplementationBinding,
} from '../bindings/binding-table.js';
import type { CompositeHandler, DispatchContext } from '../../dispatch/core/dispatch.js';
import { runWithAppendObserver } from '../../events/observation/append-observation.js';
import {
  deriveLocalOperatorIdentity,
  snapshotCallerAuthorization,
} from '../../dispatch/caller-identity.js';
import {
  getDispatchContext,
  mintDispatchContext,
  runWithDispatchContext,
} from '../../dispatch/dispatch-context.js';
import { CONTRACT_SURFACE_VERSION } from '../compatibility.js';
import type { EffectClass } from '../../architecture/effect-ledger.js';
import {
  guardRoles,
  createEffectRecorder,
  runOracleSuite,
  AUTHORIZATION_CODES,
  EMISSION_AXIS,
  OPEN_ROLE_MARKER,
  type ActionSafety,
  type ContractDeclaration,
  type DeclaredEmission,
  type EmissionAxis,
  type EmissionAxisVerdict,
  type EmissionRecorder,
  type ObservableHandler,
  type ObservationContext,
  type OracleAxis,
  type OracleReport,
  type OracleSubject,
  type OracleSuiteReport,
  type VolatileCarrier,
} from './oracle-seam.js';

// ─── The shared baseline declaration ─────────────────────────────────────────
//
// ONE rich declaration that makes all five axes observable: it declares a role
// requirement (authorization axis), idempotency (incorrect-handler axis), a
// single filesystem effect (undeclared-effect axis), a typed output schema
// (malformed-output axis), and — paired with the compat baseline below — a
// version transition (compatibility axis). Every seeded subject reuses THIS
// declaration object, so a break never perturbs the declaration.

/** The declared output schema — a keyed object with one OPTIONAL legacy field. */
export const BASELINE_OUTPUT_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number(),
  // Optional: present at v1.0.0 (see the compat baseline). Dropping it still
  // satisfies the schema, which is what isolates the compatibility axis from
  // the malformed-output axis.
  legacyField: z.string().optional(),
});

export const BASELINE_INPUT_SCHEMA = z.object({ id: z.string() });

/** The recorded prior-version (v1.0.0) observation — carries `legacyField`. */
export const COMPAT_BASELINE = {
  previousVersion: '1.0.0',
  previousOutput: { id: 'req-1', name: 'baseline', count: 3, legacyField: 'legacy' },
} as const;

/** The one declaration every seeded subject shares (correct and broken alike). */
export function baselineDeclaration(actionId: string): ContractDeclaration {
  return {
    actionId,
    safety: 'local-mutation' satisfies ActionSafety,
    readOnly: false,
    idempotent: true,
    requiredRoles: ['lead'],
    declaredEffects: ['filesystem'],
    inputSchema: BASELINE_INPUT_SCHEMA,
    // The current surface version is a PATCH ahead of the compat baseline
    // (1.0.0 → 1.0.1) — a non-breaking transition per `classifyVersionChange`.
    outputSchema: BASELINE_OUTPUT_SCHEMA,
    surfaceVersion: '1.0.1',
  };
}

const PROBE_INPUT = { id: 'req-1' };

/** The correct, contract-faithful output for the probe input. */
function faithfulOutput(): Record<string, unknown> {
  return { id: 'req-1', name: 'baseline', count: 3, legacyField: 'legacy' };
}

// ─── The correct baseline handler ────────────────────────────────────────────
//
// Refuses unauthorized callers, records only the declared filesystem effect,
// returns a deterministic schema-valid output that preserves every prior field.

function correctHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    return faithfulOutput();
  };
}

function makeSubject(actionId: string, handler: ObservableHandler): OracleSubject {
  return {
    declaration: baselineDeclaration(actionId),
    handler,
    probeInput: PROBE_INPUT,
    compatBaseline: COMPAT_BASELINE,
    // The seeded handlers read `ctx.caller` directly (their correct arm calls
    // `guardRoles`), so the observation context IS the principal the oracle can
    // withhold — the authorization axis is genuinely probeable here.
    authorizationSurface: 'observation-context',
  };
}

// ─── One broken handler per axis ─────────────────────────────────────────────

/** Axis 1 — a handler declared idempotent that returns a per-call counter. */
function incorrectHandler(): ObservableHandler {
  let calls = 0;
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    calls += 1;
    // Non-idempotent: each authorized call yields a different `count`. Still a
    // valid number (output schema passes) and every prior field is preserved
    // (compat passes) — only the idempotency contract is contradicted.
    return { id: 'req-1', name: 'baseline', count: calls, legacyField: 'legacy' };
  };
}

/** Axis 2 — a handler that never enforces the declared role requirement. */
function missingAuthHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    // NO guardRoles() — an unauthorized caller is served just like a lead.
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    return faithfulOutput();
  };
}

/** Axis 3 — a handler that performs a network effect its contract never declares. */
function undeclaredEffectHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    // Undeclared: contract declares only {filesystem}; this reaches the network.
    ctx.effects.record('network', 'fetch:https://exfil.example/telemetry');
    return faithfulOutput();
  };
}

/** Axis 4 — a handler that returns the wrong TYPE for a declared field. */
function malformedOutputHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    // `count` must be a number; returning a string violates the output schema.
    // The KEY set is unchanged, so the compatibility axis is unaffected.
    return { id: 'req-1', name: 'baseline', count: 'three', legacyField: 'legacy' };
  };
}

/** Axis 5 — a handler that drops a prior-version field without a major bump. */
function compatibilityBreakHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    // Drops `legacyField` (present at v1.0.0). It is OPTIONAL, so the output
    // schema still passes (malformed axis unaffected); but removing a shipped
    // field under a 1.0.0 → 1.0.1 PATCH is a breaking change shipped as a patch.
    return { id: 'req-1', name: 'baseline', count: 3 };
  };
}

const AXIS_HANDLERS: Readonly<Record<OracleAxis, () => ObservableHandler>> = {
  'incorrect-handler': incorrectHandler,
  'missing-authorization': missingAuthHandler,
  'undeclared-effect': undeclaredEffectHandler,
  'malformed-output': malformedOutputHandler,
  'compatibility-break': compatibilityBreakHandler,
};

/** A stable, axis-scoped ActionId so diagnostics name the offending action. */
export function seedActionId(axis: OracleAxis): string {
  return `oracle_probe.${axis.replace(/-/g, '_')}`;
}

export interface SeededBreak {
  readonly axis: OracleAxis;
  readonly correct: OracleSubject;
  readonly broken: OracleSubject;
}

/**
 * A seeded break for `axis`: a `{ correct, broken }` pair whose declarations are
 * byte-identical (only the handler differs). Fresh subjects each call so stateful
 * broken handlers (the incorrect-handler counter) never leak across tests.
 */
export function seededBreak(axis: OracleAxis): SeededBreak {
  const actionId = seedActionId(axis);
  return {
    axis,
    correct: makeSubject(actionId, correctHandler()),
    broken: makeSubject(actionId, AXIS_HANDLERS[axis]()),
  };
}

/** A single correct baseline subject that must pass ALL five axes. */
export function correctBaselineSubject(): OracleSubject {
  return makeSubject('oracle_probe.baseline', correctHandler());
}

// ─── Live-system subjects ────────────────────────────────────────────────────
//
// Real registry actions adapted to subjects. The DECLARATION is derived from
// the REAL action registry (DR-24); the observed behavior is either the REAL
// runtime envelope (`format.ts`) or, for `realHandlerSubjects`, the REAL
// composite handler resolved through the REAL binding table.

/**
 * The role requirement the REAL registry declares for this action
 * (`ToolAction.roles`). Sorted for a stable declaration.
 *
 * DR-24: this replaces a hard-coded `[]`. An empty array made the authorization
 * axis structurally unable to say anything about the shipped system; the real
 * set lets the axis state precisely what it did or did not observe — including
 * the very common "declares only the open-role marker `any`" case, which is a
 * real fact about the registry rather than an artifact of the fixture.
 */
export function registryRequiredRoles(action: ToolAction): readonly string[] {
  return [...action.roles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The effect classes the REAL registry declares for this action, derived from
 * its server-trusted `annotations` (the same source `meta-model.ts`
 * `deriveEffectPolicy` reads):
 *
 *   • `filesystem` — unconditional: every action is served over the durable,
 *     on-disk event store, so a filesystem effect is always within contract.
 *   • `network` — iff `annotations.openWorld`, the registry's own marker for
 *     "this action interacts with entities outside its local system".
 *
 * `process` is deliberately NOT declared: no registry annotation claims a
 * subprocess, so a handler observed spawning one is an undeclared effect.
 */
export function registryDeclaredEffects(action: ToolAction): readonly EffectClass[] {
  const effects: EffectClass[] = ['filesystem'];
  if (action.annotations.openWorld) effects.push('network');
  return effects;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The `{event, condition}` set the REAL registry declares for this action,
 * read off the nested action contract through `contractEmissionsOf` — the same
 * registry-level projection the event-registration validator and the reachability
 * collector consult.
 *
 * The condition rides along deliberately. The compiler compiles it, the dispatch
 * verifier requires only the `always` half of it, and the oracle now judges by
 * the same rule; dropping it here would make the oracle demand an append on
 * every branch and fail handlers for taking one they were entitled to take.
 *
 * Reading the registry rather than the compiled `EvidencePolicy` also keeps the
 * oracle off the generation pipeline it exists to be independent of — and keeps
 * "the four surfaces agree" a claim that can actually fail, instead of a
 * comparison of one projection with itself.
 */
export function registryDeclaredEmissions(action: ToolAction): readonly DeclaredEmission[] {
  const unique = new Map<string, DeclaredEmission>();
  for (const emission of contractEmissionsOf(action)) {
    unique.set(`${emission.event} ${emission.condition}`, {
      event: emission.event,
      condition: emission.condition,
    });
  }
  return [...unique.values()].sort(
    (a, b) => compareText(a.event, b.event) || compareText(a.condition, b.condition),
  );
}

/** The oracle declaration for a REAL registry action — every field registry-derived. */
export function realActionDeclaration(actionId: string, action: ToolAction): ContractDeclaration {
  return {
    actionId,
    safety: action.annotations.safety satisfies ActionSafety,
    readOnly: action.annotations.readOnly,
    idempotent: action.annotations.idempotent,
    requiredRoles: registryRequiredRoles(action),
    declaredEffects: registryDeclaredEffects(action),
    declaredEmissions: registryDeclaredEmissions(action),
    inputSchema: action.schema,
    outputSchema: action.outputSchema,
    surfaceVersion: CONTRACT_SURFACE_VERSION,
  };
}

/**
 * The declaration for a subject whose observed value is a canned runtime
 * ENVELOPE rather than the action's handler.
 *
 * Everything else is the registry-derived declaration; the emission set is
 * withheld, and the omission is the honest reading. The observed function here
 * is `() => envelope` — it was never the thing that appends — so scoring a
 * declared edge against it would report a fault the oracle did not observe.
 * Absent, the emission axis reports `not-observed`, which is not a pass.
 */
function envelopeObservationDeclaration(
  actionId: string,
  action: ToolAction,
): ContractDeclaration {
  const { declaredEmissions: _handlerOnly, ...envelopeObservable } = realActionDeclaration(
    actionId,
    action,
  );
  void _handlerOnly;
  return envelopeObservable;
}

/** Every `(tool, action)` pair in the REAL registry, flattened with its ActionId. */
export function realRegistryActions(): readonly {
  readonly tool: CompositeTool;
  readonly action: ToolAction;
  readonly actionId: string;
}[] {
  return TOOL_REGISTRY.flatMap((tool) =>
    tool.actions.map((action) => ({
      tool,
      action,
      actionId: `${tool.name}.${action.name}`,
    })),
  );
}

/** The canonical runtime error envelope — a real, data-agnostic output sample. */
export function sampleErrorEnvelope(): unknown {
  return wrapError(new Error('sample failure for output-contract observation'));
}

/** The canonical runtime success envelope over empty `data`. */
export function sampleSuccessEnvelope(): unknown {
  return wrap({});
}

/**
 * A live subject per real action whose observed output is the runtime ERROR
 * envelope. Every action's declared `outputSchema` must admit it (the error
 * branch is data-agnostic), so this runs uniformly over all real actions.
 *
 * No `authorizationSurface`: a canned envelope has no principal to withhold, so
 * the authorization axis reports `not-observed` — never `pass`.
 */
export function liveOutputSubjects(): OracleSubject[] {
  return realRegistryActions().map(({ action, actionId }) => {
    const envelope = sampleErrorEnvelope();
    return {
      declaration: envelopeObservationDeclaration(actionId, action),
      handler: () => envelope,
      probeInput: {},
    };
  });
}

/**
 * A live subject per real action whose declared `outputSchema` accepts the
 * runtime SUCCESS envelope over empty data — exercising the success branch
 * (perf metrics, `next_actions`, `_meta`). Actions with a tighter typed `data`
 * schema (which reject empty data) are skipped and reported by count.
 */
export function liveSuccessOutputSubjects(): { subjects: OracleSubject[]; skipped: string[] } {
  const subjects: OracleSubject[] = [];
  const skipped: string[] = [];
  for (const { action, actionId } of realRegistryActions()) {
    const envelope = sampleSuccessEnvelope();
    if (!action.outputSchema.safeParse(envelope).success) {
      skipped.push(actionId);
      continue;
    }
    subjects.push({
      declaration: envelopeObservationDeclaration(actionId, action),
      handler: () => envelope,
      probeInput: {},
    });
  }
  return { subjects, skipped };
}

// ─── Real-handler subjects (DR-24) ───────────────────────────────────────────
//
// The oracle stops looking at canned envelopes and invokes the SHIPPED handler.
// Resolution goes through the REAL implementation-binding table, so the handler
// under observation is exactly the function dispatch would run — a stale or
// missing binding surfaces here rather than being papered over by a stand-in.

/**
 * The runtime-owned, per-call carriers a real composite handler stamps. Declared
 * ONCE for every real subject rather than per-action, so this is a statement
 * about the shipped envelope's bookkeeping fields, not a per-failure escape
 * hatch. Each carrier names the shape it claims, and the oracle refuses the mask
 * unless the observed values actually hold that shape — so widening this list
 * cannot be used to swallow a real behavioral divergence.
 *
 *  • `_perf` — elapsed ms / bytes / tokens of THAT call.
 *  • `data.generatedAt` / `data.session.start` — the instant the answer was
 *    computed, recorded by the shipped view handlers.
 */
const RUNTIME_CARRIERS: readonly VolatileCarrier[] = [
  { path: '_perf', kind: 'measurement-block' },
  { path: 'data.generatedAt', kind: 'generation-timestamp' },
  { path: 'data.session.start', kind: 'generation-timestamp' },
];

/**
 * Why a real action was NOT probed. Reported rather than silently dropped: a
 * shrinking probe set must be visible, not inferred from a still-green suite.
 */
export interface UnprobedAction {
  readonly actionId: string;
  readonly reason: string;
}

export interface RealHandlerObservationSet {
  readonly subjects: readonly OracleSubject[];
  readonly notProbed: readonly UnprobedAction[];
}

/**
 * Mints a real `DispatchContext` over a caller-owned state directory.
 *
 * The harness does NOT construct the `EventStore` itself: the composition-root
 * census (`tools/audit/gates/check-event-store-composition-root.mjs`) admits `new
 * EventStore` only inside the composition root, and this module is not one.
 * Injecting the factory keeps that guard honest — the store is built by the
 * calling test, which the census excludes — instead of widening the allowlist
 * to accommodate a harness.
 */
export type DispatchContextFactory = (stateDir: string) => DispatchContext;

// ─── Reaching the oracle's emission recorder from inside a real handler ──────
//
// The oracle mints a fresh emission recorder per invocation and injects it on
// the {@link ObservationContext}. A real {@link CompositeHandler}, however,
// takes exactly two arguments and its second is `DispatchContext` — a shipped,
// closed interface. Neither can carry the recorder without changing a
// production type for a test-only observation, and stuffing it into `args`
// would put an unknown key in front of every shipped handler's argument parse.
//
// So it rides an AsyncLocalStorage scope the adapter opens around the
// invocation — the same primitive `dispatch-context.ts` uses to reach append
// sites without an argument refactor, so it survives the
// `runWithDispatchContext` hop and every async continuation beneath it.

const emissionScope = new AsyncLocalStorage<EmissionRecorder>();

/**
 * The emission recorder the oracle injected for the invocation in flight, or
 * `undefined` outside an observed dispatch.
 *
 * A handler that appends events calls this at the point it commits, exactly
 * where it would call `eventStore.append`. One that never calls it is observed
 * appending nothing — which is the whole signal, so the absence is deliberately
 * silent rather than an error.
 */
export function observedEmissionRecorder(): EmissionRecorder | undefined {
  return emissionScope.getStore();
}

/**
 * Adapt a REAL composite handler to an {@link ObservableHandler}.
 *
 * The adapter projects the oracle's synthetic caller onto the REAL runtime
 * authorization substrate and then gets out of the way — it NEVER refuses on
 * the handler's behalf. A caller holding a required role is dispatched inside
 * the trusted caller-authorization scope the production dispatch boundary opens
 * (`snapshotCallerAuthorization` + `mintDispatchContext` +
 * `runWithDispatchContext`, the exact primitives `dispatch/core/dispatch.ts` composes);
 * a caller holding none is dispatched with no scope and no `callerIdentity`,
 * exactly as an unauthenticated transport would forward it.
 *
 * Because the adapter does not decide, the verdict is the HANDLER's: one that
 * consults the trusted-caller boundary refuses the intruder, and one that skips
 * authorization serves it and is caught.
 *
 * It also carries the observation context's emission recorder into the
 * invocation (see {@link observedEmissionRecorder}). Without that hop the
 * recorder is injected and then dropped at this boundary, and EVERY real
 * subject's emission axis reports `not-observed` for a reason that is an
 * artifact of the adapter rather than a fact about the handler — the axis
 * would look inspected while being structurally incapable of a verdict.
 */
export function compositeHandlerAdapter(
  load: CompositeHandlerLoader,
  actionName: string,
  requiredRoles: readonly string[],
  stateDir: string,
  makeContext: DispatchContextFactory,
): ObservableHandler {
  return async (input: unknown, ctx: ObservationContext): Promise<unknown> => {
    const handler: CompositeHandler = await load();
    const args: Record<string, unknown> = {
      action: actionName,
      ...(typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}),
    };
    const held = new Set(ctx.caller.roles);
    const holdsRequiredRole = requiredRoles.some(
      (role) => role === OPEN_ROLE_MARKER || held.has(role),
    );
    const dispatchCtx = makeContext(stateDir);

    const invoke = (): Promise<ToolResult> => {
      if (!holdsRequiredRole) {
        return handler(args, dispatchCtx);
      }
      const authorization = snapshotCallerAuthorization(
        deriveLocalOperatorIdentity(stateDir),
        undefined,
      );
      return Promise.resolve(
        runWithDispatchContext(mintDispatchContext(undefined, authorization), () =>
          handler(args, { ...dispatchCtx, callerIdentity: authorization.identity }),
        ),
      );
    };

    // No recorder on the context means the caller is not observing emissions
    // here (the admission probe below, for one). Opening a scope over a
    // throwaway recorder would tell the handler it is being watched when
    // nothing will read what it records, so the scope simply stays closed.
    return ctx.emissions === undefined ? invoke() : emissionScope.run(ctx.emissions, invoke);
  };
}

/** The binding table entry for `tool`, from the REAL binding table. */
function bindingFor(
  table: readonly ImplementationBinding[],
  toolName: string,
): ImplementationBinding | undefined {
  return table.find((binding) => binding.tool === toolName);
}

/**
 * Real-handler subjects over the live registry.
 *
 * Admission is by REGISTRY DECLARATION, not by cherry-picking outcomes — an
 * action is probed iff it declares `readOnly` (the oracle must not mutate the
 * system it observes), declares `openWorld: false` (no reach outside the local
 * system, so the probe is deterministic and offline), has a real implementation
 * binding, and its DECLARED input schema admits the oracle's empty probe.
 *
 * A handler that DECLINES the probe (a `success: false` envelope) exhibited a
 * refusal, not the action's behavior, so it is reported in `notProbed` rather
 * than observed — the oracle records what it could not look at instead of
 * scoring it.
 */
export async function realHandlerSubjects(
  stateDir: string,
  makeContext: DispatchContextFactory,
): Promise<RealHandlerObservationSet> {
  const subjects: OracleSubject[] = [];
  const notProbed: UnprobedAction[] = [];
  // The REAL, shipped binding table — resolved once, then consulted per action.
  const bindingTable = buildBindingTable();

  for (const { tool, action, actionId } of realRegistryActions()) {
    const annotations = action.annotations;
    if (!annotations.readOnly) {
      notProbed.push({ actionId, reason: 'declares a mutation — the oracle does not mutate' });
      continue;
    }
    if (annotations.openWorld) {
      notProbed.push({ actionId, reason: 'declares openWorld — probe would leave the local system' });
      continue;
    }
    const binding = bindingFor(bindingTable, tool.name);
    if (binding === undefined || !isImplementationBinding(binding)) {
      notProbed.push({ actionId, reason: `no implementation binding for tool '${tool.name}'` });
      continue;
    }
    if (!action.schema.safeParse({}).success) {
      notProbed.push({ actionId, reason: 'declared input schema rejects the empty probe' });
      continue;
    }

    const declaration = realActionDeclaration(actionId, action);
    const handler = compositeHandlerAdapter(
      binding.load,
      action.name,
      declaration.requiredRoles,
      stateDir,
      makeContext,
    );

    // Does the REAL handler serve the probe? A refusal is not the action's
    // behavior, so it is reported rather than scored.
    const served = await handler({}, {
      caller: { subjectId: 'oracle-admission', roles: [...declaration.requiredRoles] },
      effects: createEffectRecorder(),
    });
    const refusalCode = refusalCodeOf(served);
    if (refusalCode !== undefined) {
      notProbed.push({ actionId, reason: `real handler declined the probe (${refusalCode})` });
      continue;
    }

    subjects.push({
      declaration,
      handler,
      probeInput: {},
      // The `_perf` block carries the elapsed milliseconds of THAT call, so it
      // is masked from the idempotency comparison only (the axis diagnostic
      // names it). Schema validation still sees the unmasked envelope.
      volatileCarriers: RUNTIME_CARRIERS,
    });
  }

  return { subjects, notProbed };
}

/** The stable error code of a `success: false` result, or undefined if served. */
function refusalCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { success?: unknown; error?: { code?: unknown } };
  if (record.success !== false) return undefined;
  return typeof record.error?.code === 'string' ? record.error.code : 'UNKNOWN';
}

// ─── The controlled real-registry authorization case (DR-24) ─────────────────
//
// Built-in actions overwhelmingly declare the open-role marker `any`, so the
// live surface cannot demonstrate a RESTRICTIVE requirement being honored (or
// skipped). Rather than hand-mock the registry, this registers a real action —
// through the registry's own registration-time validator — into a real registry
// instance, binds it through the real binding-table constructor, and drives it
// through the real dispatch-authority scope. Only the handler body varies.

/** The real tool name the controlled case registers under. */
export const REAL_REGISTRY_PROBE_TOOL = 'exarchos_oracle_probe';
/** The real action name the controlled case registers. */
export const REAL_REGISTRY_PROBE_ACTION = 'guarded_read';
/** The restrictive role the controlled case's real action declares. */
export const REAL_REGISTRY_PROBE_ROLE = 'lead';

/**
 * The stable code the enforcing handler declines with. Resolved from the REAL
 * P03-02 authorization error family (`AUTHORIZATION_CODES`) rather than typed
 * as a bare literal, so a fixture claiming an authorization refusal cannot
 * drift onto a code the contract surface does not classify as one.
 */
export const TRUSTED_CALLER_REQUIRED = ((): string => {
  const code = 'TRUSTED_CALLER_REQUIRED';
  if (!AUTHORIZATION_CODES.has(code)) {
    throw new Error(
      `oracle fixtures: '${code}' is not in the declared authorization error family`,
    );
  }
  return code;
})();

/**
 * `enforcing` consults the REAL trusted-caller boundary; `skipping` serves
 * everyone. Both are real handlers bound the real way — the difference is
 * exactly the defect DR-24 requires the oracle to catch.
 */
export type AuthorizationVariant = 'enforcing' | 'skipping';

export interface RealRegistryCase {
  /** A real `CompositeTool`, validated by the registry's own `validateAction`. */
  readonly tool: CompositeTool;
  readonly action: ToolAction;
  /** The real, non-serializable implementation binding for the tool. */
  readonly binding: ImplementationBinding;
  readonly subject: OracleSubject;
}

/**
 * The wire envelope a probe handler returns, carried as the `ToolResult` the
 * `CompositeHandler` signature declares — the same reinterpretation the shipped
 * composite handlers make when they hand a wrapped envelope back across the
 * dispatch boundary.
 *
 * Every probe below goes through this one conversion so the reinterpretation
 * lives at a single named site rather than being repeated, unexplained, at each
 * handler's return.
 */
function probeEnvelope(result: ToolResult): ToolResult {
  return toEnvelope(result) as unknown as ToolResult;
}

/**
 * The real handler that ENFORCES: it reads the trusted caller-authorization
 * snapshot off the production dispatch scope (`getDispatchContext()`) and fails
 * closed with the real `TRUSTED_CALLER_REQUIRED` authorization-family code when
 * it is absent — the same guard `verbs/gates/gate-runner.ts` and
 * `verbs/gates/durable-gate-producer.ts` apply.
 */
const enforcingRealHandler: CompositeHandler = async (): Promise<ToolResult> => {
  const dispatchScope = getDispatchContext();
  if (dispatchScope?.authorization === undefined) {
    return probeEnvelope({
      success: false,
      error: {
        code: TRUSTED_CALLER_REQUIRED,
        message: 'guarded_read requires trusted dispatch caller identity.',
        action: REAL_REGISTRY_PROBE_ACTION,
      },
    });
  }
  return probeEnvelope({ success: true, data: { guarded: true } });
};

/** The real handler that SKIPS authorization: it never consults the boundary. */
const skippingRealHandler: CompositeHandler = async (): Promise<ToolResult> =>
  probeEnvelope({ success: true, data: { guarded: true } });

/** What varies between the controlled probe registrations. */
interface RealProbeSpec {
  readonly toolName: string;
  readonly actionName: string;
  readonly roles: readonly string[];
  readonly description: string;
}

/**
 * Build a real probe action, running it through the registry's own validator.
 *
 * Shared by every controlled case below, so each one is registered by ONE code
 * path: a probe cannot quietly acquire looser annotations or skip the validator
 * that the others go through.
 */
function buildRealProbeAction(spec: RealProbeSpec): ExtensionToolAction {
  const draft: ExtensionActionDraft = {
    name: spec.actionName,
    description: spec.description,
    schema: z.object({}).strict(),
    phases: new Set(['delegate']),
    roles: new Set(spec.roles),
    // DR-4 (task 055): the probe is a FIXTURE action, deliberately absent from
    // the built-in registry the vacuity census enumerates, so it has no
    // allowlist id to waive. The bounded out-of-registry escape keeps it
    // constructible without reopening the vacuous form on `ToolAction`.
    //
    // Task 060: that escape now mints the distinct `ExtensionOutputSchema`
    // brand, which is why this declaration is typed `ExtensionToolAction`. The
    // probe stays a REAL registration — `validateAction` below is the same call
    // `registry.ts` makes — while being nominally incapable of appearing in
    // `TOOL_REGISTRY`.
    outputSchema: unregisteredActionOutputSchema(),
    annotations: {
      safety: 'read-only',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
  };
  const action = withActionContract(draft, {
    requires: none('oracle probe has no admission obligations'),
    ensures: none('oracle probe returns an ephemeral fixture result'),
    needs: none('oracle probe declares no capabilities'),
    touches: {
      frame: 'single-machine',
      resources: none('oracle probe does not address a stream, path, worktree, or git-ref'),
    },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: none('oracle probe emits no catalog events'),
  }, { annotations: draft.annotations }) as ExtensionToolAction;
  // The REAL registration-time invariant loop — the same call `registry.ts`
  // makes over every built-in action at module load. A declaration that could
  // not be registered for real is not a real registration.
  validateAction(action, spec.toolName);
  return action;
}

/**
 * Mint the REAL, non-serializable implementation binding for a probe tool
 * through the real binding-table constructor — the binding is produced exactly
 * as the shipped table's entries are, not hand-assembled.
 */
function realProbeBinding(toolName: string, handler: CompositeHandler): ImplementationBinding {
  const loaders: Record<string, CompositeHandlerLoader> = {
    [toolName]: () => Promise.resolve(handler),
  };
  const [binding] = buildBindingTable(loaders);
  if (binding === undefined || !isImplementationBinding(binding)) {
    throw new Error(`oracle fixtures: binding table produced no valid binding for '${toolName}'`);
  }
  return binding;
}

/**
 * A real action in a real registry instance, bound to a real handler, observed
 * through the real dispatch-authority surface. The `skipping` variant is the
 * DR-24 acceptance case: a REAL handler that never enforces its declared role
 * requirement must be caught on the `missing-authorization` axis.
 */
export function realRegistryAuthorizationCase(
  variant: AuthorizationVariant,
  stateDir: string,
  makeContext: DispatchContextFactory,
): RealRegistryCase {
  const action = buildRealProbeAction({
    toolName: REAL_REGISTRY_PROBE_TOOL,
    actionName: REAL_REGISTRY_PROBE_ACTION,
    roles: [REAL_REGISTRY_PROBE_ROLE],
    description: 'Oracle authorization probe — a real read guarded by the trusted-caller boundary.',
  });
  const tool: CompositeTool = {
    name: REAL_REGISTRY_PROBE_TOOL,
    description: 'Oracle authorization probe tool.',
    actions: [action],
    hidden: true,
  };

  const handler = variant === 'enforcing' ? enforcingRealHandler : skippingRealHandler;
  const binding = realProbeBinding(tool.name, handler);

  const actionId = `${tool.name}.${action.name}`;
  const declaration = realActionDeclaration(actionId, action);
  return {
    tool,
    action,
    binding,
    subject: {
      declaration,
      handler: compositeHandlerAdapter(
        binding.load,
        action.name,
        declaration.requiredRoles,
        stateDir,
        makeContext,
      ),
      probeInput: {},
      // The oracle's caller reaches this handler through the REAL runtime
      // authorization substrate, so withholding the principal is a genuine
      // runtime condition — the authorization axis is truly probeable.
      authorizationSurface: 'dispatch-authority',
    },
  };
}

// ─── The controlled real-registry emission case ──────────────────────────────
//
// A shipped action DOES declare the events it appends (its contract's
// `emissions`), but it appends them through the event store, not through the
// recorder the oracle injects — so no shipped action can give this axis a
// determinate verdict, and it reads `not-observed` right across the live
// surface.
//
// Rather than hand-build an observation, this registers a real action the way
// the authorization case does: through the registry's own validator, bound by
// the real binding-table constructor, reached through `compositeHandlerAdapter`
// and the real dispatch scope. Only the handler body varies — one records its
// append where it commits, the other declares the append and never makes it.

/** The real tool name the emission case registers under. */
export const REAL_REGISTRY_EMISSION_TOOL = 'exarchos_oracle_emission_probe';
/** The real action name the emission case registers. */
export const REAL_REGISTRY_EMISSION_ACTION = 'audited_read';
/** The event type the emission case's action declares it appends. */
export const REAL_REGISTRY_EMISSION_EVENT = 'oracle_probe.audit_appended';

/**
 * `appending` records its append through the recorder the adapter put in scope;
 * `silent` declares the same emission and never appends. Both are real handlers
 * bound the real way — the difference is exactly the defect the emission axis
 * has to catch.
 */
export type EmissionVariant = 'appending' | 'silent';

/**
 * The real handler that APPENDS. It reaches the oracle's recorder
 * ({@link observedEmissionRecorder}) at the point a shipped handler would call
 * `eventStore.append`: the recorder stands in for the store so the probe stays
 * offline and writes to no real stream, but the CALL SITE is the handler's own
 * commit point, and that is what the axis observes.
 *
 * The optional call is deliberate. Outside an observed dispatch there is
 * nothing to record into, and if the adapter ever stops carrying the recorder
 * this handler silently becomes indistinguishable from its silent twin — which
 * is the failure the emission axis then reports, rather than a thrown error
 * from the harness.
 */
const appendingRealHandler: CompositeHandler = async (): Promise<ToolResult> => {
  observedEmissionRecorder()?.record(
    REAL_REGISTRY_EMISSION_EVENT,
    `append:${REAL_REGISTRY_EMISSION_TOOL}.${REAL_REGISTRY_EMISSION_ACTION}`,
  );
  return probeEnvelope({ success: true, data: { audited: true } });
};

/** The real handler that declares the emission and never performs it. */
const silentRealHandler: CompositeHandler = async (): Promise<ToolResult> =>
  probeEnvelope({ success: true, data: { audited: true } });

/**
 * A real action in a real registry instance, bound to a real handler, observed
 * through the real dispatch surface. The `silent` variant is the acceptance
 * case: a REAL handler that declares an emission it never performs must be
 * caught on the emission axis, and the `appending` variant shows the rule is
 * discriminating rather than blanket.
 */
export function realRegistryEmissionCase(
  variant: EmissionVariant,
  stateDir: string,
  makeContext: DispatchContextFactory,
): RealRegistryCase {
  const action = buildRealProbeAction({
    toolName: REAL_REGISTRY_EMISSION_TOOL,
    actionName: REAL_REGISTRY_EMISSION_ACTION,
    // The open-role marker, as the built-ins overwhelmingly declare. This probe
    // is about emissions; declaring a restrictive role its handler ignores would
    // seed an authorization defect that has nothing to do with the axis under
    // observation and would redden a second axis for a fixture-only reason.
    roles: [OPEN_ROLE_MARKER],
    description:
      'Oracle emission probe — a real read that records an audit append where it commits.',
  });
  const tool: CompositeTool = {
    name: REAL_REGISTRY_EMISSION_TOOL,
    description: 'Oracle emission probe tool.',
    actions: [action],
    hidden: true,
  };

  const handler = variant === 'appending' ? appendingRealHandler : silentRealHandler;
  const binding = realProbeBinding(tool.name, handler);

  const actionId = `${tool.name}.${action.name}`;
  const declaration: ContractDeclaration = {
    ...realActionDeclaration(actionId, action),
    // Every other field is registry-derived, and this one would be too if the
    // probe's event were a catalog event — the contract normalizer admits only
    // catalog names, and this one is deliberately outside the catalog so the
    // probe writes to no shipped stream. It is stated on the declaration BOTH
    // variants share, so the two remain byte-identical under
    // `deriveGeneratedDescriptor` — no generated artifact can tell the
    // appending handler from the silent one, and only the observation can.
    declaredEmissions: [{ event: REAL_REGISTRY_EMISSION_EVENT, condition: 'always' }],
  };
  return {
    tool,
    action,
    binding,
    subject: {
      declaration,
      handler: compositeHandlerAdapter(
        binding.load,
        action.name,
        declaration.requiredRoles,
        stateDir,
        makeContext,
      ),
      probeInput: {},
      // No `authorizationSurface`: this subject probes emissions, and claiming
      // a surface would point the authorization axis at a handler never built
      // to enforce anything.
    },
  };
}

// ─── The emission axis's census, and its zero-observation tooth ──────────────
//
// `axisCoverage` ranges over the closed `ORACLE_AXES` union, of which the
// emission axis is deliberately not a member: the seam reports it on its own
// `OracleReport.emissionVerdict`, which folds into `ok`, into the suite's
// `failures` and into `summarizeReport`. The census below is therefore the
// emission axis's own coverage row — without it, it would be the one axis with
// no vacuity reading at all.
//
// It is more than the missing row, though. A row in `axisCoverage` fails
// nothing: three of the five union axes sit at `observed: 0` across the whole
// live surface and the suite still reports `ok`. The emission axis gets a TOOTH
// instead — observing nothing anywhere is itself a failure — which is strictly
// stronger than membership in the union would have bought it.
//
// The tooth is confined to this axis BY CONSTRUCTION, not by convention: it
// reads `report.emissionVerdict` and never touches `report.verdicts`, so it has
// no way to redden the union axes that are legitimately all-not-observed.

/** How often the emission axis actually reached a verdict across a set of reports. */
export interface EmissionAxisCoverage {
  readonly axis: EmissionAxis;
  readonly pass: number;
  readonly fail: number;
  readonly notObserved: number;
  /** `pass + fail` — the number of subjects on which the axis genuinely looked. */
  readonly observed: number;
}

/**
 * Census the emission axis across `reports`. `not-observed` is counted apart
 * from `pass` for the same reason `axisCoverage` does it: "we did not look"
 * must never be readable as "we looked and it was fine".
 */
export function emissionAxisCoverage(reports: readonly OracleReport[]): EmissionAxisCoverage {
  let pass = 0;
  let fail = 0;
  let notObserved = 0;
  for (const report of reports) {
    if (report.emissionVerdict.status === 'pass') pass += 1;
    else if (report.emissionVerdict.status === 'fail') fail += 1;
    else notObserved += 1;
  }
  return { axis: EMISSION_AXIS, pass, fail, notObserved, observed: pass + fail };
}

/**
 * The subject a suite-level census reports under. Vacuity is a property of the
 * RUN rather than of any one action, and saying so beats blaming an arbitrary
 * subject for it.
 */
export const EMISSION_CENSUS_SUBJECT = '<oracle-suite>';

/**
 * The zero-observation tooth: `fail` when the emission axis reached a verdict
 * on NO subject across `reports`.
 *
 * A suite in that state ran the axis, got nothing back, and reported `ok` — the
 * shape a guard takes when it has stopped being able to fail. Either no subject
 * declares an emission, or the recorder no longer reaches the handler through
 * {@link compositeHandlerAdapter}; both leave the axis looking inspected while
 * being structurally incapable of a verdict.
 *
 * A `fail` counts as OBSERVED. Breaking the recorder's path turns a determinate
 * `pass` into a determinate `fail`, which the suite already catches; this tooth
 * is for the quieter case where the axis stops reaching any verdict at all.
 */
export function checkEmissionAxisObserved(
  reports: readonly OracleReport[],
): EmissionAxisVerdict {
  const coverage = emissionAxisCoverage(reports);
  if (reports.length === 0) {
    return {
      axis: EMISSION_AXIS,
      actionId: EMISSION_CENSUS_SUBJECT,
      status: 'not-observed',
      diagnostic: 'no reports to census — the emission axis was never run',
    };
  }
  if (coverage.observed === 0) {
    return {
      axis: EMISSION_AXIS,
      actionId: EMISSION_CENSUS_SUBJECT,
      status: 'fail',
      diagnostic:
        `the emission axis observed NOTHING across ${reports.length} subject(s) — all ` +
        `${coverage.notObserved} reported 'not-observed' and none reached a verdict. Either no ` +
        `subject declares an emission or the recorder no longer reaches the handler, and a green ` +
        `run would be reporting on an axis that never looked`,
    };
  }
  return {
    axis: EMISSION_AXIS,
    actionId: EMISSION_CENSUS_SUBJECT,
    status: 'pass',
    diagnostic:
      `the emission axis reached a verdict on ${coverage.observed} of ${reports.length} ` +
      `subject(s) (pass ${coverage.pass}, fail ${coverage.fail})`,
  };
}

export interface EmissionSuiteReport {
  /** The suite's own `ok` AND the emission axis having actually observed something. */
  readonly ok: boolean;
  readonly suite: OracleSuiteReport;
  readonly coverage: EmissionAxisCoverage;
  /** The zero-observation tooth's verdict over this run. */
  readonly vacuity: EmissionAxisVerdict;
}

/**
 * Run the oracle over `subjects` and apply the zero-observation tooth to the
 * result. `suite` is the unmodified `runOracleSuite` report, so the five
 * {@link OracleAxis} verdicts and the suite's own `ok` are visible untouched
 * beside the emission-only judgement.
 */
export async function runEmissionOracleSuite(
  subjects: readonly OracleSubject[],
): Promise<EmissionSuiteReport> {
  const suite = await runOracleSuite(subjects);
  const vacuity = checkEmissionAxisObserved(suite.reports);
  return {
    ok: suite.ok && vacuity.status !== 'fail',
    suite,
    coverage: emissionAxisCoverage(suite.reports),
    vacuity,
  };
}

// ─── The shipped-emitter probe corpus ────────────────────────────────────────
//
// `realHandlerSubjects` admits an action only if it declares `readOnly`, which
// excludes EVERY action that declares an emission: appending an event is a
// mutation, so the emitting population and the probed population were disjoint,
// and the only subject that ever reached the emission axis was a fixture action.
//
// The corpus below is the emitting population's own admission rule. It admits a
// MUTATING action, because the mutation is confined to a caller-owned temporary
// state directory — a private event store and nothing else. What it will not
// admit is a handler that leaves that directory: one that reaches the network,
// shells out to git, inspects or writes the host repository, or runs the
// project toolchain in a subprocess.
//
// Membership is by SAFETY, not by outcome. A member that declines the probe, or
// that declares an unconditional emission and is then observed appending
// nothing, stays a member — dropping it would tune the corpus to the answer it
// is supposed to be able to give.
//
// The corpus is deliberately a modest subset (workflow lifecycle, task
// bookkeeping, a handful of local orchestration verbs). The rest is EXCLUDED
// WITH A REASON rather than omitted, and {@link emissionProbeCorpus} reports
// any declared emitter that is in neither list — so a newly-declared emission
// cannot join the population without being classified.

/** An action dispatched into the isolated state dir before the probe itself. */
export interface EmissionProbeStep {
  readonly actionId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** One shipped emitter the oracle can invoke inside an isolated state dir. */
export interface EmissionProbe {
  readonly actionId: string;
  /** Prerequisite dispatches, in order. Empty when the action needs no prior state. */
  readonly setup: readonly EmissionProbeStep[];
  /** The probe input, valid against the action's own declared schema. */
  readonly input: Readonly<Record<string, unknown>>;
}

/** A declared emitter the corpus does not probe, and why. */
export interface ExcludedEmitter {
  readonly actionId: string;
  readonly reason: string;
}

export interface EmissionProbeCorpus {
  readonly probes: readonly EmissionProbe[];
  readonly excluded: readonly ExcludedEmitter[];
  /** Every action whose contract declares an emission — the population partitioned. */
  readonly declaredEmitters: readonly string[];
  /** Declared emitters that are neither probed nor excluded. */
  readonly unclassified: readonly string[];
  /** Exclusions naming an action that no longer declares an emission. */
  readonly stale: readonly string[];
}

/** The feature the workflow-lifecycle probes create inside their own state dir. */
export const EMISSION_PROBE_FEATURE_ID = 'oracle-emission-probe';

/** Every registered action whose contract declares at least one emission. */
export function declaredEmittingActions(): readonly {
  readonly action: ToolAction;
  readonly actionId: string;
}[] {
  return realRegistryActions()
    .filter(({ action }) => contractEmissionsOf(action).length > 0)
    .map(({ action, actionId }) => ({ action, actionId }));
}

function initWorkflow(workflowType: string): EmissionProbeStep {
  return {
    actionId: 'exarchos_workflow.init',
    input: { featureId: EMISSION_PROBE_FEATURE_ID, workflowType },
  };
}

const FEATURE_INPUT = { featureId: EMISSION_PROBE_FEATURE_ID };

/**
 * The probed members. Each input was constructed against the action's declared
 * schema and each one was executed against a private state directory before
 * being written down here — the set is measured, not proposed.
 */
const EMISSION_PROBES: readonly EmissionProbe[] = [
  { actionId: 'exarchos_workflow.init', setup: [], input: initWorkflow('feature').input },
  {
    actionId: 'exarchos_workflow.update',
    setup: [initWorkflow('feature')],
    input: { ...FEATURE_INPUT, updates: { notes: 'emission probe' } },
  },
  {
    actionId: 'exarchos_workflow.cancel',
    setup: [initWorkflow('feature')],
    input: { ...FEATURE_INPUT, reason: 'emission probe' },
  },
  {
    actionId: 'exarchos_workflow.feedback',
    setup: [],
    input: { ...FEATURE_INPUT, message: 'emission probe feedback' },
  },
  {
    actionId: 'exarchos_workflow.rehydrate',
    setup: [initWorkflow('feature')],
    input: FEATURE_INPUT,
  },
  {
    actionId: 'exarchos_workflow.checkpoint',
    setup: [initWorkflow('feature')],
    input: FEATURE_INPUT,
  },
  {
    actionId: 'exarchos_orchestrate.task_claim',
    setup: [],
    input: { ...FEATURE_INPUT, taskId: 'emission-probe-task', agentId: 'emission-probe-agent' },
  },
  {
    actionId: 'exarchos_orchestrate.task_fail',
    setup: [],
    input: { ...FEATURE_INPUT, taskId: 'emission-probe-task', error: 'emission probe failure' },
  },
  {
    actionId: 'exarchos_orchestrate.stack_place',
    setup: [],
    input: { streamId: 'emission-probe-stream', position: 1, taskId: 'emission-probe-task' },
  },
  {
    actionId: 'exarchos_orchestrate.request_synthesize',
    // Only a oneshot workflow admits this verb, so the prerequisite carries the
    // type rather than the probe reporting a refusal it could have avoided.
    setup: [initWorkflow('oneshot')],
    input: FEATURE_INPUT,
  },
  { actionId: 'exarchos_orchestrate.prune_stale_workflows', setup: [], input: {} },
  { actionId: 'exarchos_orchestrate.cutover_decide', setup: [], input: {} },
  {
    actionId: 'exarchos_orchestrate.classify_review_items',
    setup: [],
    input: {
      ...FEATURE_INPUT,
      actionItems: [{ file: 'src/probe.ts', severity: 'low', description: 'emission probe item' }],
    },
  },
];

const GATE_EXCLUSION =
  'gate action — resolves the host repository and runs the project toolchain in a subprocess, ' +
  'so the probe is neither offline nor confined to an isolated state dir';

const WORKTREE_EXCLUSION = 'creates or removes git worktrees in the host checkout';

const GATE_ACTIONS: readonly string[] = [
  'check_static_analysis',
  'check_integration_suite',
  'check_security_scan',
  'check_context_economy',
  'check_operational_resilience',
  'check_workflow_determinism',
  'check_review_verdict',
  'check_convergence',
  'check_provenance_chain',
  'check_design_completeness',
  'check_plan_coverage',
  'check_exploration_depth',
  'check_test_adequacy',
  'check_contract_drift',
  'check_mock_boundary',
  'check_post_merge',
  'check_task_decomposition',
  'check_event_emissions',
  'check_invariant_conformance',
  'mutation-adequacy',
  'post_delegation_check',
  'pre_synthesis_check',
];

/**
 * Why each remaining declared emitter is not probed. Hand-authored on purpose:
 * a family predicate would silently absorb a new emitter that happens to match
 * it, and the whole point of the census is that a new one has to be looked at.
 */
const HAND_AUTHORED_EXCLUSIONS: readonly ExcludedEmitter[] = [
  ...GATE_ACTIONS.map((name) => ({
    actionId: `exarchos_orchestrate.${name}`,
    reason: GATE_EXCLUSION,
  })),
  {
    actionId: 'exarchos_workflow.transition',
    reason:
      'a phase transition is admitted only against an on-disk plan artifact, which the probe ' +
      'would have to author in the host repository',
  },
  {
    actionId: 'exarchos_workflow.cleanup',
    reason: 'removes worktrees and branches through git — the probe would mutate the host checkout',
  },
  {
    actionId: 'exarchos_orchestrate.task_complete',
    reason: 'admission requires prior gate evidence the probe would have to manufacture',
  },
  {
    actionId: 'exarchos_orchestrate.review_triage',
    reason: 'requires pull-request identifiers only a live remote can supply',
  },
  {
    actionId: 'exarchos_orchestrate.prepare_delegation',
    reason: 'requires an on-disk plan and a task roster the probe does not author',
  },
  {
    actionId: 'exarchos_orchestrate.prepare_synthesis',
    reason: 'resolves and inspects the host repository through its declared repo root',
  },
  {
    actionId: 'exarchos_orchestrate.discover_bridge',
    reason: 'requires an on-disk discovery artifact',
  },
  {
    actionId: 'exarchos_orchestrate.prepare_review',
    reason: 'reads the spec artifact under review out of the host repository',
  },
  {
    actionId: 'exarchos_orchestrate.doctor',
    reason: 'probes the host toolchain through subprocesses',
  },
  {
    actionId: 'exarchos_orchestrate.onboard',
    reason: 'installs harness content into the host and shells out to do it',
  },
  {
    actionId: 'exarchos_orchestrate.invariants_add',
    reason: "writes the repository's invariant catalog outside the isolated state dir",
  },
  {
    actionId: 'exarchos_orchestrate.invariants_amend',
    reason: "writes the repository's invariant catalog outside the isolated state dir",
  },
  { actionId: 'exarchos_orchestrate.acquire_worktree', reason: WORKTREE_EXCLUSION },
  { actionId: 'exarchos_orchestrate.release_worktree', reason: WORKTREE_EXCLUSION },
  { actionId: 'exarchos_orchestrate.prune_worktrees', reason: WORKTREE_EXCLUSION },
  { actionId: 'exarchos_orchestrate.reconcile_worktrees', reason: WORKTREE_EXCLUSION },
];

/** The reason an `openWorld` emitter is excluded — the registry's own annotation. */
export const OPEN_WORLD_EXCLUSION =
  'declares openWorld — the probe would leave the local system';

/**
 * The corpus, partitioned against the live declared-emission population.
 *
 * The `openWorld` exclusions are DERIVED from the registry annotation rather
 * than listed, so they cannot drift from what the action declares. Everything
 * else is named by hand, and anything named by neither is reported in
 * `unclassified` instead of quietly falling out of the population.
 */
export function emissionProbeCorpus(): EmissionProbeCorpus {
  const population = declaredEmittingActions();
  const declaredEmitters = population.map(({ actionId }) => actionId);
  const probed = new Set(EMISSION_PROBES.map((probe) => probe.actionId));

  const excluded: ExcludedEmitter[] = [];
  const named = new Set<string>();
  for (const { action, actionId } of population) {
    if (probed.has(actionId) || !action.annotations.openWorld) continue;
    excluded.push({ actionId, reason: OPEN_WORLD_EXCLUSION });
    named.add(actionId);
  }
  for (const entry of HAND_AUTHORED_EXCLUSIONS) {
    if (named.has(entry.actionId)) continue;
    excluded.push(entry);
    named.add(entry.actionId);
  }

  const known = new Set(declaredEmitters);
  return {
    probes: EMISSION_PROBES,
    excluded,
    declaredEmitters,
    unclassified: declaredEmitters.filter((id) => !probed.has(id) && !named.has(id)),
    stale: [...named].filter((id) => !known.has(id)).sort(compareText),
  };
}

/**
 * The floor on probes able to reach a DETERMINATE emission verdict — one that
 * declares an unconditional edge, which `checkDeclaredEmission` resolves to
 * `pass` or `fail` rather than to `not-observed`. Measured from the corpus, and
 * pinned to a floor: the set may grow, never quietly shrink.
 */
export const EMISSION_PROBE_DETERMINATE_FLOOR = 9;

export interface EmissionProbeFloorVerdict {
  readonly ok: boolean;
  /** The probed actions declaring at least one unconditional emission. */
  readonly determinate: readonly string[];
  readonly diagnostic: string;
}

/**
 * Whether the corpus still carries enough determinate-capable emitters.
 *
 * Membership is read from each action's REGISTRY declaration, never from the
 * probe entry — a corpus that could satisfy its own floor by claiming to be
 * determinate would be measuring its literals.
 */
export function checkEmissionProbeFloor(corpus: EmissionProbeCorpus): EmissionProbeFloorVerdict {
  const byId = new Map(declaredEmittingActions().map((entry) => [entry.actionId, entry.action]));
  const determinate = corpus.probes
    .filter((probe) => {
      const action = byId.get(probe.actionId);
      return (
        action !== undefined &&
        contractEmissionsOf(action).some((emission) => emission.condition === 'always')
      );
    })
    .map((probe) => probe.actionId)
    .sort(compareText);
  const ok = determinate.length >= EMISSION_PROBE_DETERMINATE_FLOOR;
  return {
    ok,
    determinate,
    diagnostic: ok
      ? `${determinate.length} probed emitter(s) declare an unconditional edge ` +
        `(floor ${EMISSION_PROBE_DETERMINATE_FLOOR})`
      : `only ${determinate.length} probed emitter(s) declare an unconditional edge, below the ` +
        `floor of ${EMISSION_PROBE_DETERMINATE_FLOOR} — the corpus can no longer put the emission ` +
        `axis in front of a shipped handler that must append`,
  };
}

/** What one probe run observed. */
export interface EmissionProbeRun {
  readonly actionId: string;
  /** Whatever the shipped handler returned. */
  readonly result: unknown;
  /** Event types the store confirmed durable during the probe — not its setup. */
  readonly appended: readonly string[];
}

async function invokeShippedAction(
  actionId: string,
  input: Readonly<Record<string, unknown>>,
  stateDir: string,
  makeContext: DispatchContextFactory,
): Promise<unknown> {
  const entry = realRegistryActions().find((candidate) => candidate.actionId === actionId);
  if (entry === undefined) {
    throw new Error(`oracle fixtures: '${actionId}' is not a registered action`);
  }
  const binding = bindingFor(buildBindingTable(), entry.tool.name);
  if (binding === undefined || !isImplementationBinding(binding)) {
    throw new Error(`oracle fixtures: no implementation binding for tool '${entry.tool.name}'`);
  }
  const roles = registryRequiredRoles(entry.action);
  const handler = compositeHandlerAdapter(
    binding.load,
    entry.action.name,
    roles,
    stateDir,
    makeContext,
  );
  return handler(
    { ...input },
    { caller: { subjectId: 'emission-probe', roles: [...roles] }, effects: createEffectRecorder() },
  );
}

/**
 * Run one probe against `stateDir`, which the CALLER owns and removes — the
 * corpus never names a path, so two probes running side by side cannot collide
 * on a shared one.
 *
 * Appends are read off the event store's own durable-observation seam, so what
 * is reported is what the store confirmed persisted, not what the handler said
 * it would do. The setup dispatches run OUTSIDE that scope: their appends are
 * the prerequisite state, not the probe's behavior.
 */
export async function runEmissionProbe(
  probe: EmissionProbe,
  stateDir: string,
  makeContext: DispatchContextFactory,
): Promise<EmissionProbeRun> {
  for (const step of probe.setup) {
    await invokeShippedAction(step.actionId, step.input, stateDir, makeContext);
  }
  const appended: string[] = [];
  const result = await runWithAppendObserver(
    (observation) => {
      appended.push(observation.type);
    },
    () => invokeShippedAction(probe.actionId, probe.input, stateDir, makeContext),
  );
  return { actionId: probe.actionId, result, appended };
}
