// Fixtures for the contract oracle. Only tests import this test-only module.
// - Seeded breaks: per axis, a correct and a broken subject with one byte-identical declaration and different handlers.
// - Live output subjects: real `TOOL_REGISTRY` actions whose real `wrap` or `wrapError` envelope meets the declared `outputSchema`.
// - Real-handler subjects: real handlers from the binding table, called with a real `DispatchContext`.
// Generation emits the same artifact for both halves of a seeded break, so the oracle catches what generation consistency cannot.
//
// The roles, effects, and emissions of live and real subjects come from the registry through {@link realActionDeclaration}.
// An axis that the oracle did not exercise reports `not-observed`, which is not a pass.
// Effects are `not-observed` for real handlers, because composite handlers do not write to the effect recorder.
// Only an `always` emission edge gives a verdict. The evidence is the event store confirmation of a durable append.

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
import {
  runWithAppendObserver,
  type AppendObservation,
} from '../../events/observation/append-observation.js';
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
  emissionWasSelected,
  type ActionSafety,
  type ContractDeclaration,
  type DeclaredEmission,
  type EmissionAxis,
  type EmissionAxisVerdict,
  type EmissionSelectedReport,
  type ObservableHandler,
  type ObservationContext,
  type OracleAxis,
  type OracleReport,
  type OracleSubject,
  type OracleSuiteReport,
  type VolatileCarrier,
} from './oracle-seam.js';

/** The declared output schema: a keyed object with one optional legacy field. */
export const BASELINE_OUTPUT_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number(),
  /** Present at v1.0.0. It is optional, so a drop breaks only the compatibility axis, not the malformed-output axis. */
  legacyField: z.string().optional(),
});

export const BASELINE_INPUT_SCHEMA = z.object({ id: z.string() });

/** The recorded observation of the prior version, v1.0.0, which carries `legacyField`. */
export const COMPAT_BASELINE = {
  previousVersion: '1.0.0',
  previousOutput: { id: 'req-1', name: 'baseline', count: 3, legacyField: 'legacy' },
} as const;

/**
 * The one declaration that every seeded subject shares. It makes all five axes observable.
 * The surface version is a patch ahead of the compat baseline, which is a non-breaking transition.
 */
export function baselineDeclaration(actionId: string): ContractDeclaration {
  return {
    actionId,
    safety: 'local-mutation' satisfies ActionSafety,
    readOnly: false,
    idempotent: true,
    requiredRoles: ['lead'],
    declaredEffects: ['filesystem'],
    inputSchema: BASELINE_INPUT_SCHEMA,
    outputSchema: BASELINE_OUTPUT_SCHEMA,
    surfaceVersion: '1.0.1',
  };
}

const PROBE_INPUT = { id: 'req-1' };

/** The correct, contract-faithful output for the probe input. */
function faithfulOutput(): Record<string, unknown> {
  return { id: 'req-1', name: 'baseline', count: 3, legacyField: 'legacy' };
}

/** The correct handler. It refuses unauthorized callers, records only the declared effect, and keeps every prior field. */
function correctHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    return faithfulOutput();
  };
}

/** A seeded subject. Its handler reads `ctx.caller`, so the oracle can withhold the principal. */
function makeSubject(actionId: string, handler: ObservableHandler): OracleSubject {
  return {
    declaration: baselineDeclaration(actionId),
    handler,
    probeInput: PROBE_INPUT,
    compatBaseline: COMPAT_BASELINE,
    authorizationSurface: 'observation-context',
  };
}

/** Axis 1: a handler declared idempotent that returns a per-call counter. Only the idempotency contract breaks. */
function incorrectHandler(): ObservableHandler {
  let calls = 0;
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    calls += 1;
    return { id: 'req-1', name: 'baseline', count: calls, legacyField: 'legacy' };
  };
}

/** Axis 2: a handler that never enforces the declared role requirement. */
function missingAuthHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    return faithfulOutput();
  };
}

/** Axis 3: a handler with a network effect that its contract does not declare. */
function undeclaredEffectHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    ctx.effects.record('network', 'fetch:https://exfil.example/telemetry');
    return faithfulOutput();
  };
}

/** Axis 4: a handler that returns a string for `count`. The key set does not change, so the compatibility axis passes. */
function malformedOutputHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
    return { id: 'req-1', name: 'baseline', count: 'three', legacyField: 'legacy' };
  };
}

/**
 * Axis 5: a handler that drops `legacyField` under a patch version.
 * The field is optional, so the output schema passes, but the drop is a breaking change.
 */
function compatibilityBreakHandler(): ObservableHandler {
  return (_input: unknown, ctx: ObservationContext): Record<string, unknown> => {
    guardRoles(ctx, ['lead']);
    ctx.effects.record('filesystem', 'writeFile:./state.json');
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

/** A stable, axis-scoped ActionId, so diagnostics name the action. */
export function seedActionId(axis: OracleAxis): string {
  return `oracle_probe.${axis.replace(/-/g, '_')}`;
}

export interface SeededBreak {
  readonly axis: OracleAxis;
  readonly correct: OracleSubject;
  readonly broken: OracleSubject;
}

/**
 * A seeded break for `axis`: a `{ correct, broken }` pair with byte-identical declarations.
 * Each call makes fresh subjects, so a stateful broken handler does not leak across tests.
 */
export function seededBreak(axis: OracleAxis): SeededBreak {
  const actionId = seedActionId(axis);
  return {
    axis,
    correct: makeSubject(actionId, correctHandler()),
    broken: makeSubject(actionId, AXIS_HANDLERS[axis]()),
  };
}

/** A correct baseline subject that must pass all five axes. */
export function correctBaselineSubject(): OracleSubject {
  return makeSubject('oracle_probe.baseline', correctHandler());
}

/** The roles that the registry declares for this action, sorted. The authorization axis reports against this real set. */
export function registryRequiredRoles(action: ToolAction): readonly string[] {
  return [...action.roles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The effect classes that the registry declares for this action, from its server-trusted `annotations`.
 * - `filesystem` is always present, because each action runs over the on-disk event store.
 * - `network` is present when `annotations.openWorld` is true.
 * No annotation claims a subprocess, so a `process` effect is undeclared.
 */
export function registryDeclaredEffects(action: ToolAction): readonly EffectClass[] {
  const effects: EffectClass[] = ['filesystem'];
  if (action.annotations.openWorld) effects.push('network');
  return effects;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The `{event, condition}` set that the registry declares for this action, through `contractEmissionsOf`.
 * The condition stays, because the oracle requires an append only for an `always` edge, like the dispatch verifier.
 * The registry source keeps the oracle independent of the compiled `EvidencePolicy`.
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

/** The oracle declaration for a real registry action. Each field comes from the registry. */
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
 * The declaration for a subject whose observed value is a canned runtime envelope, not the handler.
 * It omits the emission set, because `() => envelope` never appends. The emission axis then reports `not-observed`.
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

/** Every `(tool, action)` pair in the registry, with its ActionId. */
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

/** The canonical runtime error envelope, a data-agnostic output sample. */
export function sampleErrorEnvelope(): unknown {
  return wrapError(new Error('sample failure for output-contract observation'));
}

/** The canonical runtime success envelope over empty `data`. */
export function sampleSuccessEnvelope(): unknown {
  return wrap({});
}

/**
 * A live subject per real action, whose observed output is the runtime error envelope.
 * Each declared `outputSchema` must accept it. A canned envelope has no principal, so authorization is `not-observed`.
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
 * A live subject per real action whose `outputSchema` accepts the runtime success envelope over empty data.
 * The function skips an action whose typed `data` rejects empty data, and returns its id in `skipped`.
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

/**
 * The per-call carriers that a real composite handler stamps, declared once for every real subject.
 * The oracle masks a carrier only when the observed value has the claimed shape.
 * `_perf` holds the measurements of one call. `data.generatedAt` and `data.session.start` hold the computation time.
 */
const RUNTIME_CARRIERS: readonly VolatileCarrier[] = [
  { path: '_perf', kind: 'measurement-block' },
  { path: 'data.generatedAt', kind: 'generation-timestamp' },
  { path: 'data.session.start', kind: 'generation-timestamp' },
];

/** Why a real action was not probed. The report makes a smaller probe set visible. */
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
 * The calling test builds the `EventStore`, because the composition-root census allows `new EventStore` only in the composition root.
 */
export type DispatchContextFactory = (stateDir: string) => DispatchContext;

/**
 * One durable append, as the emission recorder records it. The evidence comes from the async-scoped append seam of the store.
 * A rejected append or an idempotency cache hit gives no observation. Concurrent subjects do not see the appends of each other.
 */
function appendEvidence(observation: AppendObservation): string {
  return `store append: ${observation.streamId}#${observation.sequence}`;
}

/**
 * Adapt a real composite handler to an {@link ObservableHandler}. The adapter never refuses for the handler.
 * A caller with a required role runs inside the trusted caller-authorization scope that production dispatch opens.
 * A caller without one runs with no scope and no `callerIdentity`, like an unauthenticated transport.
 * The adapter installs the append observer for the call, so the emission recorder sees durable appends.
 * Without an emission recorder, it opens no observer scope, because a scope shadows an enclosing observer.
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

    const emissions = ctx.emissions;
    if (emissions === undefined) return invoke();
    return runWithAppendObserver(
      (observation) => emissions.record(observation.type, appendEvidence(observation)),
      invoke,
    );
  };
}

/** The binding table entry for `toolName`. */
function bindingFor(
  table: readonly ImplementationBinding[],
  toolName: string,
): ImplementationBinding | undefined {
  return table.find((binding) => binding.tool === toolName);
}

/**
 * Real-handler subjects over the live registry. The registry declaration decides admission.
 * The oracle probes an action only when it is `readOnly`, is not `openWorld`, has a binding, and accepts an empty input.
 * A handler that declines the probe goes into `notProbed`, because a refusal is not the behavior of the action.
 * The runtime-carrier mask applies only to the idempotency comparison. Schema validation sees the unmasked envelope.
 */
export async function realHandlerSubjects(
  stateDir: string,
  makeContext: DispatchContextFactory,
): Promise<RealHandlerObservationSet> {
  const subjects: OracleSubject[] = [];
  const notProbed: UnprobedAction[] = [];
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
      volatileCarriers: RUNTIME_CARRIERS,
    });
  }

  return { subjects, notProbed };
}

/** The stable error code of a `success: false` result, or `undefined` when the handler served the call. */
function refusalCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { success?: unknown; error?: { code?: unknown } };
  if (record.success !== false) return undefined;
  return typeof record.error?.code === 'string' ? record.error.code : 'UNKNOWN';
}

/**
 * The tool name of the controlled authorization case. Most built-in actions declare the open role `any`.
 * So this case registers a real action with a restrictive role through the real validator, binding table, and dispatch scope.
 */
export const REAL_REGISTRY_PROBE_TOOL = 'exarchos_oracle_probe';
/** The real action name the controlled case registers. */
export const REAL_REGISTRY_PROBE_ACTION = 'guarded_read';
/** The restrictive role that the action of the controlled case declares. */
export const REAL_REGISTRY_PROBE_ROLE = 'lead';

/**
 * The stable code that the enforcing handler declines with. It resolves from `AUTHORIZATION_CODES`.
 * So the fixture cannot use a code that the contract surface does not classify as an authorization refusal.
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
 * `enforcing` checks the real trusted-caller boundary, and `skipping` serves every caller.
 * The oracle must catch the `skipping` defect.
 */
export type AuthorizationVariant = 'enforcing' | 'skipping';

export interface RealRegistryCase {
  /** A real `CompositeTool` that `validateAction` accepts. */
  readonly tool: CompositeTool;
  readonly action: ToolAction;
  /** The real implementation binding for the tool. */
  readonly binding: ImplementationBinding;
  readonly subject: OracleSubject;
}

/**
 * The wire envelope of a probe handler, typed as the `ToolResult` that `CompositeHandler` declares.
 * Shipped composite handlers make the same cast. All probes use this one site for it.
 */
function probeEnvelope(result: ToolResult): ToolResult {
  return toEnvelope(result) as unknown as ToolResult;
}

/**
 * The real handler that enforces authorization. It reads the trusted caller snapshot from `getDispatchContext()`.
 * Without the snapshot, it fails closed with `TRUSTED_CALLER_REQUIRED`.
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

/** The real handler that skips authorization. It never checks the boundary. */
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
 * Build a real probe action and run it through `validateAction`, the validator of the registry.
 * Each controlled case uses this one path, so no probe gets looser annotations or skips the validator.
 * The probe is not in the built-in registry, so it uses `unregisteredActionOutputSchema` and is an `ExtensionToolAction`.
 */
function buildRealProbeAction(spec: RealProbeSpec): ExtensionToolAction {
  const draft: ExtensionActionDraft = {
    name: spec.actionName,
    description: spec.description,
    schema: z.object({}).strict(),
    phases: new Set(['delegate']),
    roles: new Set(spec.roles),
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
  validateAction(action, spec.toolName);
  return action;
}

/** Mint the implementation binding for a probe tool through `buildBindingTable`, as the shipped table does. */
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
 * A real action, bound to a real handler, observed through the real dispatch-authority surface.
 * The oracle must catch the `skipping` variant on the `missing-authorization` axis.
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
      authorizationSurface: 'dispatch-authority',
    },
  };
}

/**
 * How often the emission axis reached a verdict across a set of reports.
 * `axisCoverage` covers only `ORACLE_AXES`, and the emission axis is not in that union.
 * So this census is the coverage row of the emission axis, read from `report.emissionVerdict` only.
 */
export interface EmissionAxisCoverage {
  readonly axis: EmissionAxis;
  readonly pass: number;
  readonly fail: number;
  readonly notObserved: number;
  /** `pass + fail`: the number of subjects on which the axis looked. */
  readonly observed: number;
}

/**
 * Census the emission axis across `reports`. It counts `not-observed` apart from `pass`.
 * {@link emissionWasSelected} drops reports without the axis, so the type checker knows `report.emissionVerdict` is defined.
 */
export function emissionAxisCoverage(reports: readonly OracleReport[]): EmissionAxisCoverage {
  let pass = 0;
  let fail = 0;
  let notObserved = 0;
  for (const report of reports.filter(emissionWasSelected)) {
    if (report.emissionVerdict.status === 'pass') pass += 1;
    else if (report.emissionVerdict.status === 'fail') fail += 1;
    else notObserved += 1;
  }
  return { axis: EMISSION_AXIS, pass, fail, notObserved, observed: pass + fail };
}

/** The subject of a suite-level census. Vacuity is a property of the run, not of one action. */
export const EMISSION_CENSUS_SUBJECT = '<oracle-suite>';

/**
 * Fail when the emission axis observed nothing. Two failures have different diagnostics, because they need different repairs.
 * - No report selected `declared-emission`, which includes zero reports.
 * - Reports selected the axis, but none reached a verdict.
 * In the second case, no subject declares an emission, or the recorder does not reach the handler through {@link compositeHandlerAdapter}.
 */
export function checkEmissionAxisObserved(
  reports: readonly OracleReport[],
): EmissionAxisVerdict {
  const selected: readonly EmissionSelectedReport[] = reports.filter(emissionWasSelected);
  if (selected.length === 0) {
    return {
      axis: EMISSION_AXIS,
      actionId: EMISSION_CENSUS_SUBJECT,
      status: 'fail',
      diagnostic:
        `zero of ${reports.length} report(s) had the emission axis selected — the axis was ` +
        `never asked to look at all, which is not the same defect as it looking and finding ` +
        `nothing`,
    };
  }
  const coverage = emissionAxisCoverage(selected);
  if (coverage.observed === 0) {
    return {
      axis: EMISSION_AXIS,
      actionId: EMISSION_CENSUS_SUBJECT,
      status: 'fail',
      diagnostic:
        `the emission axis observed NOTHING across ${selected.length} subject(s) — all ` +
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
      `the emission axis reached a verdict on ${coverage.observed} of ${selected.length} ` +
      `subject(s) (pass ${coverage.pass}, fail ${coverage.fail})`,
  };
}

export interface EmissionSuiteReport {
  /** True when the suite is `ok` and the emission axis observed something. */
  readonly ok: boolean;
  readonly suite: OracleSuiteReport;
  readonly coverage: EmissionAxisCoverage;
  /** The zero-observation verdict over this run. */
  readonly vacuity: EmissionAxisVerdict;
}

/** Run the oracle over `subjects` and apply the zero-observation check. `suite` is the unchanged `runOracleSuite` report. */
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

/** An action that runs in the isolated state directory before the probe. */
export interface EmissionProbeStep {
  readonly actionId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * One shipped emitter that the oracle can call inside an isolated state directory.
 * `realHandlerSubjects` admits only read-only actions, and an append is a mutation, so emitters need their own corpus.
 * A member mutates only a caller-owned temporary state directory. It never reaches the network, git, the host repository, or a subprocess.
 * Safety decides membership, not outcome. A member that declines the probe or appends nothing stays a member.
 */
export interface EmissionProbe {
  readonly actionId: string;
  /** Prerequisite dispatches, in order. It is empty when the action needs no prior state. */
  readonly setup: readonly EmissionProbeStep[];
  /** The probe input, which the declared schema of the action accepts. */
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
  /** Every action whose contract declares an emission. The other lists partition this population. */
  readonly declaredEmitters: readonly string[];
  /** Declared emitters that are neither probed nor excluded. */
  readonly unclassified: readonly string[];
  /** Exclusions naming an action that no longer declares an emission. */
  readonly stale: readonly string[];
  /** Hand-authored exclusions naming an action the corpus also probes. */
  readonly doublyClassified: readonly string[];
}

/** The feature that the workflow-lifecycle probes create in their state directory. */
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

/** The probed members. Each input matches the declared schema, and each member ran against a private state directory. */
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
  /** Only a oneshot workflow admits this verb, so the setup creates one. */
  {
    actionId: 'exarchos_orchestrate.request_synthesize',
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
 * Why each other declared emitter is not probed. The list is hand-written.
 * A family predicate absorbs a new matching emitter, but the census must make someone classify each new one.
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
    actionId: 'exarchos_orchestrate.prepare',
    reason:
      'compiles only a feature workflow standing in delegate, which the probe could reach only ' +
      'through the phase transition this corpus already excludes',
  },
  {
    actionId: 'exarchos_orchestrate.settle',
    reason:
      'adjudicates only a capsule a prepare call recorded, and prepare is excluded above; a probe ' +
      'of the refusal alone would append nothing and prove nothing about the emission',
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
  {
    actionId: 'exarchos_orchestrate.execute_intent',
    reason:
      'runs a compiled segment of OTHER registered actions, and the one shipped intent is the ' +
      'per-task gate chain excluded just above — probing it would run the project toolchain in ' +
      'a subprocess against the host repository, transitively and for every leaf',
  },
  { actionId: 'exarchos_orchestrate.acquire_worktree', reason: WORKTREE_EXCLUSION },
  { actionId: 'exarchos_orchestrate.release_worktree', reason: WORKTREE_EXCLUSION },
  { actionId: 'exarchos_orchestrate.prune_worktrees', reason: WORKTREE_EXCLUSION },
  { actionId: 'exarchos_orchestrate.reconcile_worktrees', reason: WORKTREE_EXCLUSION },
];

/** The exclusion reason for an emitter that the registry annotates as `openWorld`. */
export const OPEN_WORLD_EXCLUSION =
  'declares openWorld — the probe would leave the local system';

/**
 * The corpus, partitioned against the live declared-emission population.
 * The `openWorld` exclusions derive from the registry annotation. A declared emitter in no list goes into `unclassified`.
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
  const doublyClassified: string[] = [];
  for (const entry of HAND_AUTHORED_EXCLUSIONS) {
    if (probed.has(entry.actionId)) {
      doublyClassified.push(entry.actionId);
      continue;
    }
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
    doublyClassified: doublyClassified.sort(compareText),
  };
}

/**
 * The minimum number of probes that declare an unconditional edge, so `checkDeclaredEmission` gives `pass` or `fail`.
 * The set can grow, but it must not shrink below this floor.
 */
export const EMISSION_PROBE_DETERMINATE_FLOOR = 9;

export interface EmissionProbeFloorVerdict {
  readonly ok: boolean;
  /** The probed actions that declare at least one unconditional emission. */
  readonly determinate: readonly string[];
  readonly diagnostic: string;
}

/**
 * Check that the corpus has enough emitters with an unconditional edge.
 * The check reads each registry declaration, never the probe entry, so the corpus cannot meet the floor by a claim.
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
  /** The event types that the store confirmed durable during the probe, without the setup. */
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
 * Run one probe against `stateDir`, which the caller owns and removes. The corpus names no path, so parallel probes do not collide.
 * The appends come from the durable-observation seam of the store.
 * The setup dispatches run outside that scope, because their appends are prerequisite state.
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

/**
 * The side of the control pair that {@link shippedEmitterCase} builds.
 * `appending` runs the shipped handler. `silent` returns a valid envelope and appends nothing.
 * Both read the shipped declaration through {@link realActionDeclaration}, so only the observation tells them apart.
 */
export type EmissionVariant = 'appending' | 'silent';

/** A shipped emitter, or its silent twin, ready for observation. */
export interface ShippedEmitterCase {
  readonly actionId: string;
  /** The registered action, which is the only source of the declaration. */
  readonly action: ToolAction;
  /** The binding that runs: the shipped binding, or the binding of the twin. */
  readonly binding: ImplementationBinding;
  readonly subject: OracleSubject;
}

/** The silent twin handler, which commits nothing. */
const silentTwinHandler: CompositeHandler = async (): Promise<ToolResult> =>
  probeEnvelope({ success: true, data: {} });

/**
 * Prepare `probe` as an {@link OracleSubject} against a state directory that the caller owns and removes.
 * The setup dispatches run for both variants, so the silence of the twin comes from the missing append, not a missing precondition.
 * The subject has no `authorizationSurface`, because the pair differs only in emissions.
 */
export async function shippedEmitterCase(
  probe: EmissionProbe,
  variant: EmissionVariant,
  stateDir: string,
  makeContext: DispatchContextFactory,
): Promise<ShippedEmitterCase> {
  const entry = realRegistryActions().find((candidate) => candidate.actionId === probe.actionId);
  if (entry === undefined) {
    throw new Error(`oracle fixtures: '${probe.actionId}' is not a registered action`);
  }
  for (const step of probe.setup) {
    await invokeShippedAction(step.actionId, step.input, stateDir, makeContext);
  }

  const binding =
    variant === 'appending'
      ? bindingFor(buildBindingTable(), entry.tool.name)
      : realProbeBinding(entry.tool.name, silentTwinHandler);
  if (binding === undefined || !isImplementationBinding(binding)) {
    throw new Error(`oracle fixtures: no implementation binding for tool '${entry.tool.name}'`);
  }

  const declaration = realActionDeclaration(probe.actionId, entry.action);
  return {
    actionId: probe.actionId,
    action: entry.action,
    binding,
    subject: {
      declaration,
      handler: compositeHandlerAdapter(
        binding.load,
        entry.action.name,
        declaration.requiredRoles,
        stateDir,
        makeContext,
      ),
      probeInput: { ...probe.input },
      volatileCarriers: RUNTIME_CARRIERS,
    },
  };
}
