/**
 * The event registration union. Each registered event type declares two independent axes: a
 * coupling tier, which names the weld that its emission rides on, and a lifecycle. Every tier
 * arm demands a weld field, so a registration that only reports has no constructible form.
 * The emission source is derived from the tier, and a non-active lifecycle overrides it.
 *
 * The `_EventRegistration_*` type aliases at the end of this file prove these claims. They live
 * in source because the build excludes `*.test.ts`, so its `tsc` checks them. Every import is
 * `import type`, so this module adds no runtime import edges. It does not import
 * `contract/declaration.ts`, but the union is usable as the `subject` of a `Declaration`.
 */

import type { z } from 'zod';
import type { EventEmissionSource } from './schemas.js';
import type { EffectClass } from '../architecture/effect-ledger.js';
import type { EffectProvider } from '../contract/reachability/providers.js';
import type { SupportedGateClass } from '../verbs/gates/gate-provider-registry.js';

/**
 * The six coupling tiers, in weld-strength order. Each tier names the emitter: `substrate` (the
 * store), `capability` (an effect provider), `observation` (a reconciler), `judgment` (a gate),
 * `workflow-local` (one workflow definition), and `harness` (developer tooling outside the
 * governed source root). `harness` exists because only the evaluation harness under `tools/`
 * appends `eval.judge.calibrated`, and no other tier describes that emitter.
 *
 * A new tier must go here, because `_EventRegistration_DeclaredTiers_MatchTheVariantArms` fails
 * on a parallel arm. The tuple has an explicit readonly type, not `as const`, so this module
 * spends nothing from the type-assertion budget of the repository.
 */
export const EVENT_TIERS: readonly [
  'substrate',
  'capability',
  'observation',
  'judgment',
  'workflow-local',
  'harness',
] = ['substrate', 'capability', 'observation', 'judgment', 'workflow-local', 'harness'];

/**
 * `'substrate' | 'capability' | 'observation' | 'judgment' | 'workflow-local' | 'harness'`.
 */
export type EventTier = (typeof EVENT_TIERS)[number];

/**
 * The lifecycle axis, independent of {@link EventTier}. A `planned` event has a schema but no
 * emitter yet. A `retired` event keeps its schema so that old logs replay, but nothing emits it.
 * A `retired` entry keeps the tier of its live period, and {@link findTierSourceDisagreement}
 * does not report it.
 */
export const EVENT_LIFECYCLES: readonly ['active', 'planned', 'retired'] = [
  'active',
  'planned',
  'retired',
];

/** `'active' | 'planned' | 'retired'`. */
export type EventLifecycle = (typeof EVENT_LIFECYCLES)[number];

/**
 * The sources that an event can register with: `EventEmissionSource` minus the lifecycle values.
 * `_EventRegistration_EmissionAxis_IsTheRegistrableSet` pins it to the set that
 * `registerEventType` accepts, so a new `EventEmissionSource` member cannot widen it silently.
 */
export type EmissionSource = Exclude<EventEmissionSource, EventLifecycle>;

/**
 * The store mechanism that makes a `substrate` emission part of the operation:
 *   - `transition-record`: the event is the HSM transition, and projected state folds over it.
 *   - `append-path`: the atomic append transaction emits it, not a caller.
 *   - `session-lifecycle`: store, session or stream bookkeeping around an append.
 *   - `concurrency-outcome`: the outcome of the CAS, circuit or retry control of the store.
 *   - `compensation-record`: the compensation and rollback bookkeeping of the store.
 *   - `operation-record`: a handler appends it inside its non-idempotent operation, with no
 *     consumer fold. This weld is the weakest, and `capability` cannot hold it.
 * The union is closed, because a free-text `string` lets any event claim `substrate`.
 */
export type SubstrateRationale =
  | 'transition-record'
  | 'append-path'
  | 'session-lifecycle'
  | 'concurrency-outcome'
  | 'compensation-record'
  | 'operation-record';

/**
 * The effect provider that a `capability` event is welded to. It derives from
 * {@link EffectProvider}, so it follows that field. It is not closed to the shipped tool names,
 * because such a copy of `EFFECT_PROVIDERS` can drift. An unknown id fails at boot, not at
 * compile time.
 */
export type EffectProviderId = EffectProvider['tool'];

/**
 * A fold that reads a `capability` event: a `ProjectionReducer.id` or a `ViewProjection` name.
 * It is a plain `string`, because this layer cannot list every projection and view without a
 * layer inversion. The tier gets its check from the non-empty
 * {@link CapabilityRegistration.consumedBy} tuple instead.
 */
export type ConsumerId = string;

/**
 * The reconciler that produces an `observation` event. It is closed for the same reason as
 * {@link SubstrateRationale}: an open id lets any event name a reconciler that does not exist.
 */
export type ReconcilerId = 'worktree' | 'branch' | 'pr';

/**
 * The external world that an `observation` event is reconciled against. `effect-port-seam.ts`
 * limits the reconciler port to `process` and `network`, so `'filesystem'` is not a ground truth.
 */
export type GroundTruthSource = Extract<EffectClass, 'process' | 'network'>;

/**
 * The key under `ExarchosConfig.workflows` that owns a `workflow-local` event. It is a plain
 * `string`, because users author definitions at runtime. `keyof Record<string, T>` is
 * `string | number`, which is wider.
 */
export type WorkflowDefinitionId = string;

/**
 * The repo-relative, forward-slash path of the module that appends a `harness` event, for example
 * `tools/evals/evals/harness.ts`. It is a plain `string`, and the path must be outside `src/`.
 * `auditHarnessWelds` in `registration-validate.ts` rejects a path under `src/`, because an
 * emitter there has a real weld.
 */
export type HarnessModuleId = string;

/**
 * {@link SubstrateRationale} as data, in the same order. A runtime guard needs each closed
 * vocabulary as data, because a type cannot be iterated. A proof at the end of this file pins
 * each tuple to its union in both directions.
 */
export const SUBSTRATE_RATIONALES: readonly [
  'transition-record',
  'append-path',
  'session-lifecycle',
  'concurrency-outcome',
  'compensation-record',
  'operation-record',
] = [
  'transition-record',
  'append-path',
  'session-lifecycle',
  'concurrency-outcome',
  'compensation-record',
  'operation-record',
];

/** {@link ReconcilerId} as data. A new member goes into both. */
export const RECONCILER_IDS: readonly ['worktree', 'branch', 'pr'] = ['worktree', 'branch', 'pr'];

/** {@link GroundTruthSource} as data: the two effect classes of the reconciler port. */
export const GROUND_TRUTH_SOURCES: readonly ['process', 'network'] = ['process', 'network'];

/**
 * {@link SupportedGateClass} as data. It is not a value import from
 * `verbs/gates/gate-provider-registry.ts`, because that module builds its registry at load and
 * this module has only type imports. A proof at the end of this file fails on a new gate class.
 */
export const JUDGMENT_GATE_CLASSES: readonly [
  'test-adequacy',
  'contract-drift',
  'mock-boundary',
  'static-analysis',
  'integration-suite',
  'plan-coverage',
  'provenance-chain',
  'review-verdict',
  'prepare-synthesis',
  'security-scan',
  'convergence',
  'invariant-conformance',
  'task-decomposition',
  'spec-coverage',
  'context-economy',
  'coverage-thresholds',
  'debug-review',
  'exploration-depth',
  'operational-resilience',
  'post-delegation',
  'post-merge',
  'pr-stack',
  'pre-synthesis',
  'workflow-determinism',
] = [
  'test-adequacy',
  'contract-drift',
  'mock-boundary',
  'static-analysis',
  'integration-suite',
  'plan-coverage',
  'provenance-chain',
  'review-verdict',
  'prepare-synthesis',
  'security-scan',
  'convergence',
  'invariant-conformance',
  'task-decomposition',
  'spec-coverage',
  'context-economy',
  'coverage-thresholds',
  'debug-review',
  'exploration-depth',
  'operational-resilience',
  'post-delegation',
  'post-merge',
  'pr-stack',
  'pre-synthesis',
  'workflow-determinism',
];

/** Emitted by the event store's own machinery as an inseparable part of an operation. */
export interface SubstrateRegistration {
  readonly tier: 'substrate';
  readonly rationale: SubstrateRationale;
}

/** Emitted by an effect provider while performing the effect, and read by named consumers. */
export interface CapabilityRegistration {
  readonly tier: 'capability';
  readonly provider: EffectProviderId;
  /** Non-empty, because a capability that nobody consumes is a report. `[]` does not compile. */
  readonly consumedBy: readonly [ConsumerId, ...ConsumerId[]];
}

/** Emitted by a reconciler that sensed the world and found it diverged from projected state. */
export interface ObservationRegistration {
  readonly tier: 'observation';
  readonly reconciler: ReconcilerId;
  readonly groundTruth: GroundTruthSource;
}

/**
 * Emitted by a gate as it returns its verdict. The model composes the content, which
 * {@link contentSchema} validates, and the gate owns the emission. `contentSchema` is a live Zod
 * object, which the declaration IR otherwise forbids. It sits in the subject payload, not in the
 * identity fields, so `(kind, id)` addressing does not change.
 */
export interface JudgmentRegistration {
  readonly tier: 'judgment';
  readonly gate: SupportedGateClass;
  readonly contentSchema: z.ZodSchema;
}

/** Owned by exactly one workflow definition. It is not part of the global catalog. */
export interface WorkflowLocalRegistration {
  readonly tier: 'workflow-local';
  readonly workflow: WorkflowDefinitionId;
}

/**
 * Emitted by developer tooling outside the governed source root, and read by named consumers.
 * The weld is {@link HarnessModuleId}, the path of the module that appends. It names a file,
 * because a harness has no registered surface. A check against the tree keeps it from becoming
 * an escape hatch. `consumedBy` is non-empty for the same reason as in `capability`.
 */
export interface HarnessRegistration {
  readonly tier: 'harness';
  readonly module: HarnessModuleId;
  readonly consumedBy: readonly [ConsumerId, ...ConsumerId[]];
}

/**
 * The coupling arm: a discriminated union on `tier`. It is separate from the lifecycle
 * intersection, because an intersection of an object with a union does not reliably distribute
 * in a conditional type.
 */
export type EventTierVariant =
  | SubstrateRegistration
  | CapabilityRegistration
  | ObservationRegistration
  | JudgmentRegistration
  | WorkflowLocalRegistration
  | HarnessRegistration;

/**
 * One registered event: the weld of its emission ({@link EventTierVariant}) and whether it is
 * emitted ({@link EventLifecycle}). The axes are independent, so a `retired` capability event is
 * valid. It is usable as the `subject` of `Declaration<'event', EventRegistration>`.
 */
export type EventRegistration = {
  readonly lifecycle: EventLifecycle;
} & EventTierVariant;

/**
 * The tier to emission-source map. It is total over {@link EventTier}, so a new tier must
 * decide what emits it.
 */
export const EMISSION_SOURCE_BY_TIER: Readonly<Record<EventTier, EmissionSource>> = Object.freeze(
  {
    /** The store appends it inside the operation, and no caller can omit it. */
    substrate: 'auto',
    /** The effect provider appends it while it performs the effect. */
    capability: 'auto',
    /**
     * Reconcilers fire at boundaries: session start, phase transition, launcher spawn and
     * teardown. No timer and no daemon runs them. No live registration has this tier, so no
     * measurement confirms this value.
     */
    observation: 'hook',
    /**
     * The model composes the verdict content, and the gate owns the append. Only events that a
     * `SupportedGateClass` carries use this tier. Events from a model-walked runbook step with
     * no gate use `workflow-local`.
     */
    judgment: 'model',
    /**
     * A model-walked runbook step of a workflow phase composes these events.
     * `PHASE_EVENT_CONTRACTS` in `workflow/topology/phase-events.ts` maps each event to the phase
     * that owns it.
     */
    'workflow-local': 'model',
    /**
     * The harness code computes the payload and owns the append, as with `operation-record`.
     * `'model'` is wrong here, because it requires a `.describe()` on each schema field for a
     * model, and no model fills these fields. The arm demands a consumer to make up for the weak
     * weld.
     */
    harness: 'auto',
  },
);

/**
 * The two axes without the weld: the only inputs of {@link resolveEmissionSource}. A static
 * analyzer, such as `tools/audit/core/authority-live-proof.ts`, passes a pair that it parsed from
 * source and reuses the lifecycle-first rule. {@link EventRegistration} is assignable to it.
 */
export interface EmissionAxes {
  readonly lifecycle: EventLifecycle;
  readonly tier: EventTier;
}
/**
 * Returns the `EventEmissionSource` of a registration, lifecycle first. A `planned` or `retired`
 * lifecycle is the source. Only an `active` registration reads {@link EMISSION_SOURCE_BY_TIER}.
 * `_EventRegistration_TwoAxes_ReproduceEventEmissionSource` proves that the results are exactly
 * the shipped union.
 */
export function resolveEmissionSource(registration: EmissionAxes): EventEmissionSource {
  const { lifecycle } = registration;
  if (lifecycle !== 'active') return lifecycle;
  return EMISSION_SOURCE_BY_TIER[registration.tier];
}

/**
 * Builds the emission registry for a set of event types. It derives each source from the
 * registration of the type, so no source can disagree with its tier. It throws on an empty set,
 * because an empty registry reads as "no event has a source". It also throws on each type that
 * has no registration, and it names every such type.
 *
 * `registrationOf` is a parameter, not an import, so the module keeps zero runtime import edges
 * and a test can pass a seeded set. The caller sets the key type through its binding annotation.
 */
export function deriveEmissionRegistry(
  eventTypes: Iterable<string>,
  registrationOf: (eventType: string) => EventRegistration | undefined,
): Record<string, EventEmissionSource> {
  const derived: Record<string, EventEmissionSource> = {};
  const unannotated: string[] = [];
  let population = 0;

  for (const eventType of eventTypes) {
    population += 1;
    const registration = registrationOf(eventType);
    if (registration === undefined) {
      unannotated.push(eventType);
      continue;
    }
    derived[eventType] = resolveEmissionSource(registration);
  }

  if (population === 0) {
    throw new Error(
      'deriveEmissionRegistry: refusing to build an emission registry from an empty event-type ' +
        'population. An empty registry reads to every consumer as "no event has a source", so a ' +
        'moved or renamed catalog must fail here rather than pass clean.',
    );
  }
  if (unannotated.length > 0) {
    throw new Error(
      `deriveEmissionRegistry: ${unannotated.length} registered event type(s) carry no DR-2 ` +
        `registration, so no emission source can be derived for them: ${unannotated.sort().join(', ')}. ` +
        'Source is derived from tier and lifecycle — annotate the type rather than declaring a source ' +
        'for it.',
    );
  }

  return derived;
}
/** A declared `source` that the registration's own tier and lifecycle do not produce. */
export interface TierSourceDisagreement {
  readonly code: 'TIER_SOURCE_DISAGREEMENT';
  readonly tier: EventTier;
  readonly lifecycle: EventLifecycle;
  /** What `EVENT_EMISSION_REGISTRY` says today. */
  readonly declared: EventEmissionSource;
  /** What the two axes produce. */
  readonly derived: EventEmissionSource;
  readonly message: string;
}

/**
 * Compares a declared emission source with the source that the two axes derive. `undefined`
 * means that they agree. A `retired` registration that declares `'retired'` agrees, even when
 * its tier derives `'auto'` for an active event.
 */
export function findTierSourceDisagreement(
  registration: EventRegistration,
  declaredSource: EventEmissionSource,
): TierSourceDisagreement | undefined {
  const derived = resolveEmissionSource(registration);
  if (derived === declaredSource) return undefined;
  return Object.freeze({
    code: 'TIER_SOURCE_DISAGREEMENT',
    tier: registration.tier,
    lifecycle: registration.lifecycle,
    declared: declaredSource,
    derived,
    message:
      `tier '${registration.tier}' with lifecycle '${registration.lifecycle}' derives ` +
      `source '${derived}', but the registry declares '${declaredSource}'. Source is derived, ` +
      `never independently authored — change the tier, the lifecycle, or the emission site.`,
  });
}

/** The identifier a registration is welded to, tagged with the tier that produced it. */
export interface WeldReference {
  readonly tier: EventTier;
  /** The weld id: a rationale, a provider, a reconciler, a gate, a workflow, or a module path. */
  readonly ref: string;
}

/**
 * Returns the weld reference of a registration. The `default` arm binds the value to `never`,
 * so an unhandled new tier is a `tsc` error that names the variant.
 */
export function weldReferenceOf(registration: EventRegistration): WeldReference {
  switch (registration.tier) {
    case 'substrate':
      return { tier: registration.tier, ref: registration.rationale };
    case 'capability':
      return { tier: registration.tier, ref: registration.provider };
    case 'observation':
      return { tier: registration.tier, ref: registration.reconciler };
    case 'judgment':
      return { tier: registration.tier, ref: registration.gate };
    case 'workflow-local':
      return { tier: registration.tier, ref: registration.workflow };
    case 'harness':
      return { tier: registration.tier, ref: registration.module };
    default: {
      const unhandled: never = registration;
      return unhandled;
    }
  }
}

type Expect<T extends true> = T;
type IsNotAssignable<A, B> = A extends B ? false : true;
/** Set equality for unions of literals: mutual assignability, wrapped so neither side splits. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A registration that names its tier and nothing else — report-coupling, as a type. */
type BareRegistration<T extends EventTier> = {
  readonly lifecycle: EventLifecycle;
  readonly tier: T;
};

/** The bare form of every tier, as a union, so the proof below covers all of them. */
type AnyBareRegistration = { [T in EventTier]: BareRegistration<T> }[EventTier];

/**
 * A record that holds only `tier` and `lifecycle` is not assignable to {@link EventRegistration}
 * at any tier. `IsNotAssignable` distributes over the union, so the check covers every bare form.
 * The alias stops being `true` when an arm can exist without its weld field.
 * @proof
 */
export type _EventRegistration_ReportCoupledVariant_HasNoConstructibleForm = Expect<
  IsNotAssignable<AnyBareRegistration, EventRegistration>
>;

/** Every coupling arm carries at least one field beyond the discriminant. */
type WeldFieldsOf<R> = R extends unknown ? Exclude<keyof R, 'tier'> : never;
type CarriesAWeld<R> = R extends unknown
  ? [WeldFieldsOf<R>] extends [never]
    ? false
    : true
  : never;

/**
 * The same claim from the arms: no arm holds only the discriminant. A new arm with no weld makes
 * the check `true | false`, which `Expect` rejects.
 * @proof
 */
export type _EventRegistration_EveryTierArm_CarriesAWeldField = Expect<
  [CarriesAWeld<EventTierVariant>] extends [true] ? true : false
>;

/**
 * A `capability` with no consumers has no constructible form. It names a provider, so the
 * bare-form proof does not reach it. The non-empty {@link CapabilityRegistration.consumedBy}
 * tuple rejects it.
 * @proof
 */
export type _EventRegistration_CapabilityWithNoConsumers_HasNoConstructibleForm = Expect<
  IsNotAssignable<
    {
      readonly lifecycle: 'active';
      readonly tier: 'capability';
      readonly provider: EffectProviderId;
      readonly consumedBy: readonly [];
    },
    EventRegistration
  >
>;

/**
 * `EVENT_TIERS` and the arms of the union are the same set. An arm that is not listed, or a
 * listed tier with no arm, is a compile error.
 * @proof
 */
export type _EventRegistration_DeclaredTiers_MatchTheVariantArms = Expect<
  MutuallyAssignable<EventTierVariant['tier'], EventTier>
>;

/**
 * The derived emission axis is exactly the set that `registerEventType` accepts. A new
 * `EventEmissionSource` member cannot widen {@link EmissionSource} unnoticed.
 * @proof
 */
export type _EventRegistration_EmissionAxis_IsTheRegistrableSet = Expect<
  MutuallyAssignable<EmissionSource, 'auto' | 'model' | 'hook'>
>;

/**
 * {@link EmissionSource} plus the non-`active` lifecycle values is exactly `EventEmissionSource`.
 * Every source is derivable, and nothing derivable falls outside the registry.
 * @proof
 */
export type _EventRegistration_TwoAxes_ReproduceEventEmissionSource = Expect<
  MutuallyAssignable<EmissionSource | Exclude<EventLifecycle, 'active'>, EventEmissionSource>
>;

/**
 * No lifecycle value is a tier. An edit that merges the two axes breaks this check.
 * @proof
 */
export type _EventRegistration_LifecycleAxis_IsDisjointFromTheTierAxis = Expect<
  IsNotAssignable<EventLifecycle, EventTier>
>;

/**
 * {@link SUBSTRATE_RATIONALES} is exactly {@link SubstrateRationale}. These data-form proofs keep
 * the runtime guard in `event-declarations.ts` exactly as wide as the types.
 * @proof
 */
export type _EventRegistration_SubstrateRationaleData_MatchesTheUnion = Expect<
  MutuallyAssignable<(typeof SUBSTRATE_RATIONALES)[number], SubstrateRationale>
>;

/**
 * {@link RECONCILER_IDS} is exactly {@link ReconcilerId}.
 * @proof
 */
export type _EventRegistration_ReconcilerIdData_MatchesTheUnion = Expect<
  MutuallyAssignable<(typeof RECONCILER_IDS)[number], ReconcilerId>
>;

/**
 * {@link GROUND_TRUTH_SOURCES} is exactly {@link GroundTruthSource}.
 * @proof
 */
export type _EventRegistration_GroundTruthData_MatchesTheUnion = Expect<
  MutuallyAssignable<(typeof GROUND_TRUTH_SOURCES)[number], GroundTruthSource>
>;

/**
 * {@link JUDGMENT_GATE_CLASSES} is exactly {@link SupportedGateClass}. A new gate class upstream
 * fails the build here.
 * @proof
 */
export type _EventRegistration_JudgmentGateData_MatchesTheUnion = Expect<
  MutuallyAssignable<(typeof JUDGMENT_GATE_CLASSES)[number], SupportedGateClass>
>;
