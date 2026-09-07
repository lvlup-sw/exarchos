// RESERVED(issue: #1473, owner: exarchos, expires: 2026-11-30) — the DR-2 event-coupling
// union. Production code with no production importer YET: task 010 annotates the registered
// event types against it and task 012 resolves its weld references at boot. Deliberately NOT
// claimed under a `declared-test-infra` class — this is not gate machinery, it is the
// declaration type the registry migrates onto, and misfiling it would buy a permanent
// exemption for a module that is supposed to become load-bearing next task (DR-7 module-intent
// gate). If tasks 010/012 never land, this expires and is deleted.
//
// ─── The five-tier event registration union (DR-2) ───────────────────────────
//
// ## The finding this closes
//
// `EVENT_EMISSION_REGISTRY` records AUTHORSHIP, not RELIABILITY. `source: 'auto' | 'model'`
// says who composes the payload, not what the emission is welded to. Every registered type
// requires *some* tool call; the `model` ones are REPORT-COUPLED — a dedicated append that
// accomplishes nothing else, and therefore the first thing dropped under context pressure.
//
// This module makes that class unwritable at proof rung 2 (types) instead of detectable at
// rung 4 (contract tests). Every variant below demands a WELD: an identifier naming the thing
// the emission rides on. There is no arm you can fill in by naming only the event itself, so a
// registration that reports and nothing else has no form to take. `_EventRegistration_*` at the
// bottom of this file are the proofs, and `tsconfig.json` excludes `**/*.test.ts`, so they are
// checked by the build's `tsc` rather than being decorative assertions inside a test.
//
// ## Two axes, not one
//
// COUPLING (`tier`) and LIFECYCLE (`lifecycle`) are orthogonal, and conflating them is
// unsatisfiable. The shipped `EventEmissionSource` is
// `'auto' | 'model' | 'hook' | 'planned' | 'retired'` (`schemas.ts`), and `planned` (schema
// exists, not yet emitted) / `retired` (schema exists, no longer emitted) are lifecycle STATES:
// no total function tier -> source can produce them, so no tier assignment could reproduce the
// current registry. `registerEventType` confirms the split by accepting only
// `'auto' | 'model' | 'hook'` — the two lifecycle values are not registrable through the
// runtime seam at all.
//
// So the emission axis is DERIVED (`EMISSION_SOURCE_BY_TIER`, total over `EventTier`) and the
// lifecycle axis is DECLARED. {@link resolveEmissionSource} composes them lifecycle-first, and
// `_EventRegistration_TwoAxes_ReproduceEventEmissionSource` proves the two together are exactly
// the shipped five-value union — no wider, no narrower.
//
// ## Additivity — the hard constraint
//
// Nothing here modifies, wraps, or is intersected into an existing registration type.
// `EVENT_EMISSION_REGISTRY` and `registerEventType` compile untouched; task 010 annotates
// against this union rather than being reshaped by it. Every import is `import type`, so this
// module contributes ZERO runtime import edges — when task 010 makes `schemas.ts` import this
// file, the back-edge to `schemas.ts` below is already elided (`.dependency-cruiser.cjs` runs
// with the default `tsPreCompilationDeps: false`) and no cycle appears.
//
// ## What this module deliberately does NOT do
//
//   • It does not import `contract/declaration.ts`. Shaping the subject and LIFTING it into a
//     `Declaration<'event', EventRegistration>` are different jobs; importing the envelope here
//     would make this module a declaration CONSUMER, and a consumer that also imports a
//     declaration store (`schemas.ts`) fails `layer-boundaries-seam.ts`. The union is
//     structurally usable as `Declaration`'s `subject` with no import at all.
//   • It does not annotate any event type (task 010), derive the registry (task 011), resolve
//     weld references at boot (task 012), or census the report-coupled count (task 013).
//
// ## One knowing divergence from the IR-shape rule
//
// `contract/declaration.ts` requires declarations to be data, not behaviour — "no live schema
// objects". The `judgment` arm carries `contentSchema: z.ZodSchema`, a live object, because
// DR-2 specifies it: the whole point of the arm is that model-composed CONTENT is validated
// while the EMISSION rides the gate. It sits in the subject payload, never in the envelope's
// identity fields, so `(kind, id)` addressability and comparability are unaffected.
// ────────────────────────────────────────────────────────────────────────────

import type { z } from 'zod';
import type { EventEmissionSource } from './schemas.js';
import type { EffectClass } from '../architecture/effect-ledger.js';
import type { EffectProvider } from '../contract/reachability/providers.js';
import type { SupportedGateClass } from '../verbs/gates/gate-provider-registry.js';

// ─── The two axes, in DATA form ─────────────────────────────────────────────
//
// Annotated with explicit readonly tuple types rather than a const assertion: both produce the
// same literal element types, and the annotation form keeps this module free of type
// assertions entirely (the repo counts them — `src/tsconfig-strictness.test.ts` — and a
// coupling foundation should not spend from that budget). Same idiom as `DECLARATION_KINDS`.

/**
 * The six coupling tiers, in weld-strength order: substrate (the store emits it), capability
 * (an effect provider emits it), observation (a reconciler emits it), judgment (a gate emits
 * it), workflow-local (one workflow definition owns it), harness (developer tooling outside
 * the governed source root emits it).
 *
 * Adding a tier here is the ONLY way to introduce one — a further coupling class cannot be
 * smuggled in as a parallel arm without failing
 * `_EventRegistration_DeclaredTiers_MatchTheVariantArms` below.
 *
 * ── Why `harness` was added (and the precedent it follows) ──────────────────
 *
 * The same way {@link SubstrateRationale}'s `operation-record` was added: the CATALOG forced
 * it. `eval.judge.calibrated` is actively emitted and actively folded by `eval-results`, and
 * its only append is in the evaluation harness under `tools/` — a developer entry point run
 * from the command line over graded cases, not a composite tool and not reachable through
 * dispatch. It was registered `capability` with provider `exarchos_view` because that is the
 * only arm requiring a consumer, but the claim that arm makes is that AN EFFECT PROVIDER
 * EMITS IT, and none does: every `exarchos_view` action is a read of a projection,
 * `eval_results` included, so no action on that provider could carry the edge without
 * asserting that reading the view emits the calibration.
 *
 * The five original tiers all name emitters INSIDE the governed source root. None of them is
 * true of a harness, so the registration had no honest form and the stale-cover tooth reported
 * it forever — correctly, and with no repair available that was not a lie. That is the
 * signature of a missing vocabulary word rather than a missing declaration.
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
 * The lifecycle axis — orthogonal to {@link EventTier}. `planned` = the data schema and
 * type-map entry exist but nothing emits the event yet; `retired` = they are KEPT so legacy
 * logs stay replayable (INV-1) but nothing emits it any more.
 *
 * A `retired` entry is NOT a coupling defect: it still declares the tier it was welded to when
 * it was live, and {@link findTierSourceDisagreement} must not report it.
 */
export const EVENT_LIFECYCLES: readonly ['active', 'planned', 'retired'] = [
  'active',
  'planned',
  'retired',
];

/** `'active' | 'planned' | 'retired'`. */
export type EventLifecycle = (typeof EVENT_LIFECYCLES)[number];

/**
 * The EMISSION axis: the sources an event can actually be registered with. Derived by
 * subtracting the lifecycle axis from the shipped `EventEmissionSource` rather than restated,
 * so there is one authority for the vocabulary and the subtraction IS the rev-3 correction
 * expressed as a type.
 *
 * `_EventRegistration_EmissionAxis_IsTheRegistrableSet` pins the result against the set
 * `registerEventType` accepts, so a future addition to `EventEmissionSource` cannot widen this
 * silently.
 */
export type EmissionSource = Exclude<EventEmissionSource, EventLifecycle>;

// ─── Weld vocabulary ────────────────────────────────────────────────────────
//
// The identifiers each tier must name. Three are REUSED from a live authority; four are narrow
// placeholders whose owning task is named on each. Structural aliases, not nominal brands —
// same call as `contract/declaration.ts` made for `AuthorityId`/`RepresentationId`: making them
// unforgeable would force a conversion step into every annotation site and break additivity.
// Reference INTEGRITY is a runtime concern, and it is task 012's whole job.

/**
 * Why a `substrate` event is substrate — the store mechanism that makes its emission
 * inseparable from the operation.
 *
 * **This union is CLOSED on purpose, and that is load-bearing.** `substrate` is the tier with
 * the weakest weld: it names a mechanism rather than a resolvable id. If `rationale` were a
 * free-text `string`, `{ tier: 'substrate', rationale: 'because' }` would be constructible for
 * ANY event, and the whole union would collapse into a universal escape hatch — report-coupling
 * would simply be re-registered as substrate. A closed vocabulary means claiming substrate
 * means claiming one of these specific mechanisms.
 *
 * Adding a member is ADDITIVE and reshapes nothing, so task 010 may extend this list if the
 * registry turns out to hold a substrate mechanism these five do not name. Widening it to
 * `string` would not be additive — it would delete the guarantee.
 */
export type SubstrateRationale =
  /** The event IS the HSM transition; projected state is a fold over these. */
  | 'transition-record'
  /** Emitted inside the atomic append transaction itself, not by a caller. */
  | 'append-path'
  /** Store/session/stream bookkeeping around an append (checkpoint, rehydrate, cleanup). */
  | 'session-lifecycle'
  /** Records the outcome of the store's own concurrency control (CAS, circuit, retry). */
  | 'concurrency-outcome'
  /** The store's compensation/rollback bookkeeping — the INV-9 compensation contract. */
  | 'compensation-record'
  /**
   * The durable record a handler writes of the non-idempotent operation it is performing,
   * appended INSIDE the operation rather than by a caller — the INV-13 intent/result split
   * (`*.requested` before the effect, `*.executed` after it) and the operation-audit records
   * that follow the same rule.
   *
   * **Added by task 010, using the extension licence this doc block grants above, because the
   * catalog forced it.** 66 of the 170 registrations are handler-owned records with NO consumer
   * fold anywhere in `views/`, `projections/`, or `telemetry/`. `capability` cannot hold them —
   * `consumedBy` is a non-empty tuple on purpose — and none of the five original rationales names
   * a mechanism outside the store's own machinery. Without this member those 66 have no
   * constructible variant at all, which would have made task 010 unshippable rather than making
   * a finding visible.
   *
   * This is the WEAKEST weld in the union and it is deliberately named so it reads that way: it
   * says only "the code performing the operation owns the append", which is the emission-axis
   * claim (`auto`) and nothing more. It is the population task 013's G3 successor should look at
   * next — see the module header of `event-annotations.ts`.
   */
  | 'operation-record';

/**
 * The effect provider whose effect this `capability` event is welded to. Resolvable against
 * `EFFECT_PROVIDERS` (`contract/reachability/providers.ts`), whose identity for a provider is
 * its composite tool — hence the derivation from {@link EffectProvider} rather than a restated
 * `string`, so this alias narrows automatically if that field ever does.
 *
 * Structurally `string` today. It is NOT closed to the five shipped tool literals on purpose:
 * that would transcribe `EFFECT_PROVIDERS` into a second authority that can drift, and would
 * make task 012's boot-time resolution check vacuous. Unresolvable ids are a boot failure, not
 * a compile failure — the same split `contract/ir/references.ts` already draws.
 */
export type EffectProviderId = EffectProvider['tool'];

/**
 * A consumer that reads a `capability` event — the projection reducer, view projection, or
 * other fold that turns the emission into state someone depends on.
 *
 * **Explicitly widened to `string`**, which is worth stating plainly rather than dressing up:
 * the consumer population is not enumerable from this layer without importing every projection
 * and view, which is both a layering inversion and a runtime import graph this module is
 * deliberately without. The id space is `ProjectionReducer.id` (`projections/types.ts`, e.g.
 * `'task-store@v1'`) plus the exported `ViewProjection` names.
 *
 * The capability tier's teeth do not come from this alias — they come from
 * {@link CapabilityRegistration.consumedBy} being a NON-EMPTY tuple. "Declared a capability,
 * consumed by nobody" is a report with extra steps, and it does not compile.
 */
export type ConsumerId = string;

/**
 * The reconciler that produces an `observation` event.
 *
 * **Placeholder — owned by task 032 (DR-11), which defines `Reconciler<S>`.** Closed rather
 * than `string` for the same reason {@link SubstrateRationale} is: an open id would let any
 * event claim observation by naming a reconciler that does not exist. The three members are the
 * subjects DR-11/DR-12 name (git for worktrees and branches, the VCS API for PRs). Task 032 may
 * ADD members without reshaping anything here.
 */
export type ReconcilerId = 'worktree' | 'branch' | 'pr';

/**
 * The external world an `observation` event is reconciled against.
 *
 * Derived from the live {@link EffectClass} vocabulary rather than invented, then restricted to
 * DR-11's declared reconciler port: `effect-port-seam.ts` governs the reconciler layer as
 * exactly `process` + `network`, so a reconciler structurally cannot reach the filesystem and
 * `'filesystem'` is not an honest ground truth for one (INV-1: sensing, never state).
 */
export type GroundTruthSource = Extract<EffectClass, 'process' | 'network'>;

/**
 * The workflow definition that owns a `workflow-local` event — the key under
 * `ExarchosConfig.workflows`.
 *
 * **Explicitly widened to `string`.** `keyof NonNullable<ExarchosConfig['workflows']>` would be
 * the tighter-looking derivation, but `keyof Record<string, T>` is `string | number` in
 * TypeScript, so it is strictly WORSE than `string`. Definitions are user-authored at runtime
 * and cannot be a closed literal union by construction.
 */
export type WorkflowDefinitionId = string;

/**
 * The module a `harness` event is appended from — repo-relative and forward-slashed, e.g.
 * `tools/evals/evals/harness.ts`.
 *
 * **Explicitly widened to `string`, and it must live OUTSIDE `src/`.** A closed union is not
 * available: the population is developer entry points, which arrive and leave with the tooling
 * rather than with the shipped surface. Containment is therefore checked rather than typed —
 * `assertHarnessModuleIsOutsideGovernedRoot` in `registration-validate.ts` refuses a path under
 * `src/`, because an emitter inside the governed root has a real weld available and must use it.
 * That is the same split the header draws for the other open aliases: shape is a type concern,
 * reference integrity is a boot concern.
 */
export type HarnessModuleId = string;

// NOTE ON `GateClass`: DR-2 names the judgment arm's field type `GateClass`. That binds to the
// SHIPPED `SupportedGateClass` (`verbs/gates/gate-provider-registry.ts`) — the nine classes
// with exactly one registered provider each, which is precisely what makes a judgment weld
// resolvable. No alias is introduced: a second name for one vocabulary is the defect class this
// whole program exists to close. (The unqualified `GateClass` in
// `evals/benchmarks/seeded-defects/corpus.ts` is the seeded-defect eval taxonomy, a different
// population; `SupportedGateClass` already subsumes its mechanical members.)

// ─── The closed weld vocabularies, in DATA form ─────────────────────────────
//
// Added by task 008 (DR-1), the first CONSUMER. The four vocabularies above are closed literal
// unions, but shipped as TYPES only — and a type cannot be iterated at runtime. `withSubject`
// (`contract/declaration-seam.ts`) narrows a declaration's `unknown` subject through a
// caller-supplied guard, so task 008 must decide at RUNTIME whether a value inhabits
// {@link EventRegistration}. Without a data form, that guard could only check
// `typeof rationale === 'string'` — which accepts `{ tier: 'substrate', rationale: 'because' }`
// and narrows it to a type it does not inhabit. That is an assertion wearing a guard's clothing,
// and it would re-open the universal escape hatch {@link SubstrateRationale} is closed to prevent.
//
// These are FORMS of the vocabularies above, not second authorities: each is pinned to its union
// by a mutual-assignability proof at the bottom of this file, so adding a member to either side
// without the other is a `tsc` error. Same idiom, and the same reasoning, as {@link EVENT_TIERS}
// — explicit readonly tuple annotations rather than const assertions, so this module still spends
// nothing from the repo's type-assertion budget.
//
// The OPEN reference aliases deliberately get no data form. `EffectProviderId`, `ConsumerId` and
// `WorkflowDefinitionId` are structurally `string`, so a non-empty-string check is FAITHFUL to
// what they promise; whether an id resolves to a live provider/consumer/workflow is reference
// integrity, which is a boot failure (task 012) and not a compile or guard failure — the split
// `contract/ir/references.ts` already draws.

/** {@link SubstrateRationale} as data. Weld-strength order, matching the union's declaration. */
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

/** {@link ReconcilerId} as data. Task 032 (DR-11) extends BOTH halves or neither. */
export const RECONCILER_IDS: readonly ['worktree', 'branch', 'pr'] = ['worktree', 'branch', 'pr'];

/**
 * {@link GroundTruthSource} as data — the reconciler port's two effect classes.
 *
 * `'filesystem'` is absent for the reason the type excludes it: a reconciler senses, it does not
 * hold state (INV-1). The proof below fails if `effect-port-seam.ts` ever widens the port, which
 * is the intended way to find out.
 */
export const GROUND_TRUTH_SOURCES: readonly ['process', 'network'] = ['process', 'network'];

/**
 * {@link SupportedGateClass} as data — the classes with exactly one registered provider each.
 *
 * Deliberately NOT imported from `verbs/gates/gate-provider-registry.ts` as a value. That module
 * builds its provider registry at module load, and every import in THIS file is `import type`
 * precisely so the module contributes zero runtime import edges (see the header). The
 * mutual-assignability proof below binds this tuple to the shipped union just as tightly as an
 * import would, at no runtime cost: one more gate class is a compile error here.
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

// ─── The variants ───────────────────────────────────────────────────────────

/** Emitted by the event store's own machinery as an inseparable part of an operation. */
export interface SubstrateRegistration {
  readonly tier: 'substrate';
  readonly rationale: SubstrateRationale;
}

/** Emitted by an effect provider while performing the effect, and read by named consumers. */
export interface CapabilityRegistration {
  readonly tier: 'capability';
  readonly provider: EffectProviderId;
  /**
   * Non-empty by construction. A capability nobody consumes is a report, and DR-2's whole claim
   * is that a report has no variant — so `consumedBy: []` must not compile.
   */
  readonly consumedBy: readonly [ConsumerId, ...ConsumerId[]];
}

/** Emitted by a reconciler that sensed the world and found it diverged from projected state. */
export interface ObservationRegistration {
  readonly tier: 'observation';
  readonly reconciler: ReconcilerId;
  readonly groundTruth: GroundTruthSource;
}

/**
 * Emitted by a gate as it returns its verdict. The model composes the CONTENT (validated by
 * {@link contentSchema}); it does not compose the emission. That separation is what moves a
 * verdict off the report-coupled path without pretending the payload is deterministic.
 */
export interface JudgmentRegistration {
  readonly tier: 'judgment';
  readonly gate: SupportedGateClass;
  readonly contentSchema: z.ZodSchema;
}

/** Owned by exactly one workflow definition; not part of the global catalog. */
export interface WorkflowLocalRegistration {
  readonly tier: 'workflow-local';
  readonly workflow: WorkflowDefinitionId;
}

/**
 * Emitted by developer tooling OUTSIDE the governed source root, and read by named consumers.
 *
 * The weld is {@link HarnessModuleId} — the repo-relative path of the module performing the
 * append. That is a weaker identifier than a provider or a gate class, and deliberately so: it
 * names a file rather than a registered surface, because a harness has no registered surface to
 * name. It is still a WELD in the sense this union requires — you cannot fill this arm in by
 * naming only the event — and it is checkable against the tree, which is what stops it becoming
 * the escape hatch every other arm is closed to prevent.
 *
 * `consumedBy` is non-empty for the same reason `capability`'s is: an event nobody folds is a
 * report, and a harness that appends a row nothing reads is exactly the report-coupled shape
 * this union exists to make unwritable. A harness event with no consumer has no form here.
 */
export interface HarnessRegistration {
  readonly tier: 'harness';
  readonly module: HarnessModuleId;
  readonly consumedBy: readonly [ConsumerId, ...ConsumerId[]];
}

/**
 * The coupling arm — a genuine discriminated union on `tier`, kept separate from the lifecycle
 * intersection so quantification over the arms is unambiguous (an intersection of an object
 * with a union does not reliably distribute in a conditional type).
 */
export type EventTierVariant =
  | SubstrateRegistration
  | CapabilityRegistration
  | ObservationRegistration
  | JudgmentRegistration
  | WorkflowLocalRegistration
  | HarnessRegistration;

/**
 * One registered event's declaration: WHAT its emission is welded to ({@link EventTierVariant})
 * and WHETHER it is emitted at all ({@link EventLifecycle}). The two axes are independent — a
 * `retired` capability event is a coherent, common record, not a contradiction.
 *
 * Structurally usable as `Declaration<'event', EventRegistration>`'s `subject` without this
 * module importing the envelope (see the header).
 */
export type EventRegistration = {
  readonly lifecycle: EventLifecycle;
} & EventTierVariant;

// ─── Emission derivation (the emission axis only) ───────────────────────────

/**
 * The total tier -> emission-source map. Total over {@link EventTier} by type, so a new tier
 * cannot be added without deciding what emits it.
 *
 * These are the coupling claims each tier makes, and task 010 — which annotated the 170 live
 * registrations against them — is where they first met a real population. Task 010 changed
 * VALUES in this record; it did not change its shape.
 *
 * **Measured against the catalog by task 010 (see `event-annotations.ts` for the annotations
 * that constitute the measurement):**
 *
 * | tier | members | verdict |
 * |---|---|---|
 * | `substrate` | 95 | `'auto'` VALIDATED — every active one declares `auto` |
 * | `capability` | 50 | `'auto'` VALIDATED — every active one is appended by code, not composed |
 * | `observation` | **0** | UNVALIDATABLE — DR-11's reconcilers do not exist yet |
 * | `judgment` | 7 | `'model'` VALIDATED — all seven declare `model` |
 * | `workflow-local` | 18 | `'model'` — CHANGED from `'auto'` by task 010; see below |
 */
export const EMISSION_SOURCE_BY_TIER: Readonly<Record<EventTier, EmissionSource>> = Object.freeze(
  {
    // The store appends it inside the operation; no caller can omit it.
    substrate: 'auto',
    // The effect provider appends it while performing the effect.
    capability: 'auto',
    // Reconcilers fire at boundaries — session start, phase transition, launcher
    // spawn/teardown (DR-12: "boundary hook", no timer and no daemon).
    //
    // UNVALIDATED, AND DELIBERATELY LEFT SO. This tier has ZERO members in the live
    // catalog: the `Reconciler<S>` port and its `divergence.detected` event are not
    // written yet, and no registration derives `'hook'`. The nearest candidate,
    // `benchmark.completed`, names none of the reconciler subjects and has no emitter
    // anywhere in the tree, so its lifecycle records it as planned rather than as a
    // boundary-hook append. Nothing in the catalog can validate this value in EITHER
    // direction, and rewriting it to `'auto'` on the strength of the
    // `subagent.tokens_used` precedent would substitute one unvalidated judgment for
    // another. It stays as authored, named here as the one entry no measurement reaches.
    observation: 'hook',
    // The model composes the verdict CONTENT; the gate owns the append.
    //
    // VALIDATED, but NOT sufficient on its own — the correction task 010 measured. Task 009
    // expected this to be the only tier deriving 'model' and therefore to carry all 25
    // report-coupled registrations. Only 7 of the 25 can name a `SupportedGateClass` that
    // carries their verdict; the other 18 are emitted from a model-walked runbook step with
    // no gate anywhere near them, and annotating those `judgment` would have planted 18
    // welds naming a gate that never appends the event. Those 18 are `workflow-local`.
    judgment: 'model',
    // CHANGED FROM 'auto' BY TASK 010 — measured, not inherited.
    //
    // `'auto'` was unvalidatable: no built-in event is owned by a user `ExarchosConfig.workflows`
    // definition, so on task 009's reading this tier had zero members and its value was a guess.
    // The catalog does hold the coupling, one level down. `PHASE_EVENT_CONTRACTS`
    // (`workflow/topology/phase-events.ts`) is a live, mechanically-checked authority that
    // maps model-emitted events to the workflow PHASE that owns them, and the gate's header states
    // why they stay model-emitted: "their transition site is a model-walked runbook step
    // bracketing a `native:` harness tool". A workflow definition's step composing the emission
    // IS what `source: 'model'` records, so `'model'` is the measured value.
    'workflow-local': 'model',
    // The harness CODE owns the append — the same claim `operation-record` makes, and the reason
    // that rationale maps to `'auto'`. A calibration payload is computed (true/false positives and
    // negatives counted over graded cases), not composed by a model, so `'model'` would be wrong
    // in a way the catalog immediately proves: `'model'` obliges every schema field to carry a
    // `.describe()` for the model filling it in, and there is no model here to describe anything
    // to. `modelEmittedFieldsAreDescribed` in `schemas.test.ts` is what said so.
    //
    // This is the tier's honest weakness, stated rather than hidden: `'auto'` claims only that the
    // code performing the operation owns the append, and it is why the arm demands a consumer —
    // an append nobody folds is the report-coupled shape this union exists to forbid.
    harness: 'auto',
  },
);

/**
 * The two axes WITHOUT the weld — precisely the inputs {@link resolveEmissionSource} reads.
 *
 * Stated as its own type so a static analyser can hand the derivation a pair it parsed out of
 * source text (`scripts/authority-live-proof.ts` does exactly this) instead of re-implementing
 * the lifecycle-first composition, which would install a second authority for the one rule this
 * module exists to own. {@link EventRegistration} is assignable to it, so every existing caller
 * is unaffected.
 *
 * This is NOT a weakening of `_EventRegistration_ReportCoupledVariant_HasNoConstructibleForm`:
 * that proof is about what inhabits {@link EventRegistration}, and a weldless pair still does
 * not. It is only what this one pure function needs to look at.
 */
export interface EmissionAxes {
  readonly lifecycle: EventLifecycle;
  readonly tier: EventTier;
}
/**
 * Resolve the registry's `EventEmissionSource` from a registration, LIFECYCLE FIRST.
 *
 * A non-`active` lifecycle IS the source: `planned` and `retired` describe whether the event is
 * emitted at all, which strictly precedes the question of what emits it. Only an `active`
 * registration consults {@link EMISSION_SOURCE_BY_TIER}.
 *
 * Total: every `(lifecycle, tier)` pair maps to exactly one source, and
 * `_EventRegistration_TwoAxes_ReproduceEventEmissionSource` proves the codomain is exactly the
 * shipped union.
 */
export function resolveEmissionSource(registration: EmissionAxes): EventEmissionSource {
  const { lifecycle } = registration;
  // Narrowed to 'planned' | 'retired', both members of EventEmissionSource. No assertion.
  if (lifecycle !== 'active') return lifecycle;
  return EMISSION_SOURCE_BY_TIER[registration.tier];
}

/**
 * Build the emission registry for a population of event types by DERIVING each source from that
 * type's registration. Task 011's mechanism: this is what replaced `EVENT_EMISSION_REGISTRY`'s
 * 170 hand-written source literals, so there is no longer a site at which a source can be
 * authored to disagree with the tier.
 *
 * Two fail-closed conditions, both of which exist because a census that resolves nothing must
 * never read as a clean run:
 *
 *   • **Empty population.** A moved, renamed or mis-imported catalog yields an empty
 *     `eventTypes`, which would otherwise produce an empty registry that every consumer reads as
 *     "no event has a source". That throws instead.
 *   • **Unannotated type.** A registered type the annotations do not cover has no tier and
 *     therefore no derivable source. Rather than defaulting it — the guess that let the old
 *     hand-written column drift — this throws at load and names every offender.
 *
 * `registrationOf` is a parameter rather than an import so this module keeps zero runtime import
 * edges, and so a caller (a test, a kill probe) can derive over a SEEDED population without
 * touching the live annotation table.
 *
 * The return type is keyed by `string` rather than a generic key: the caller supplies the concrete
 * key type by annotating the binding (`Record<EventType, EventEmissionSource>`), which TypeScript
 * accepts from a string-indexed record without an assertion.
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
 * Compare a declared emission source against the one the two axes derive. `undefined` means
 * they agree.
 *
 * The lifecycle axis is why this is not a plain tier lookup: a `retired` registration declaring
 * `'retired'` AGREES, even though its tier would derive `'auto'` were it active. Reporting that
 * as a disagreement is the rev-2 error — it would force every retired event to be re-tiered
 * into a coupling class it has not had since it stopped being emitted.
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

// ─── Weld references ────────────────────────────────────────────────────────

/** The identifier a registration is welded to, tagged with the tier that produced it. */
export interface WeldReference {
  readonly tier: EventTier;
  /** The id task 012 resolves at boot (a provider, a reconciler, a gate, a workflow). */
  readonly ref: string;
}

/**
 * Extract the weld reference from a registration.
 *
 * The switch has no `default`, so this function is the RUNTIME carrier of the union's
 * exhaustiveness: adding a sixth arm without handling it here is a `tsc` error, and the
 * `never` binding makes the failure name the unhandled variant instead of a missing return.
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

// ─── Compile-time proofs (verified by `npm run typecheck`) ──────────────────
//
// These exported type aliases live in a non-test source file, so the build's `tsc` — the
// static-analysis gate — actively verifies them; the project's tsconfig excludes `*.test.ts`,
// so a `@ts-expect-error` in a test would NOT be gate-enforced. `Expect<T extends true>` is a
// compile error unless T is `true`. Same idiom as the `_Pola*` proofs in
// `capabilities/resolver.ts`.

type Expect<T extends true> = T;
type IsNotAssignable<A, B> = A extends B ? false : true;
/** Set equality for unions of literals: mutual assignability, wrapped so neither side splits. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A registration that names its tier and nothing else — report-coupling, as a type. */
type BareRegistration<T extends EventTier> = {
  readonly lifecycle: EventLifecycle;
  readonly tier: T;
};

/** The bare form of EVERY tier, as a union, so the proof below quantifies over all five. */
type AnyBareRegistration = { [T in EventTier]: BareRegistration<T> }[EventTier];

/**
 * `EventRegistration_ReportCoupledVariant_HasNoConstructibleForm`.
 *
 * The DR-2 claim, stated as a type: a record carrying only `tier` + `lifecycle` — an event that
 * declares itself and welds to nothing — is not assignable to {@link EventRegistration} at ANY
 * tier. `IsNotAssignable` distributes over the union, so this is a universal quantification
 * over all five bare forms, not a spot check on one.
 *
 * Falsifier: give any arm a shape satisfiable without its weld field (make `rationale`
 * optional, widen it to `string`, allow `consumedBy: []`) and this alias stops being `true`.
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
 * The same claim from the other direction, and the one that survives a REFACTOR: rather than
 * testing one hand-written bare shape, it quantifies over the arms themselves and asserts none
 * of them is discriminant-only. A weldless sixth arm makes this `true | false`, which
 * `Expect` rejects.
 * @proof
 */
export type _EventRegistration_EveryTierArm_CarriesAWeldField = Expect<
  [CarriesAWeld<EventTierVariant>] extends [true] ? true : false
>;

/**
 * A `capability` declared with no consumers is unconstructible. This is the half of the
 * report-coupling claim the bare-form proof above cannot reach: such a record DOES name a
 * provider, so it looks welded, but nothing reads what it emits — a report with extra steps.
 * The non-empty tuple on {@link CapabilityRegistration.consumedBy} is what rejects it, and
 * relaxing that to `readonly ConsumerId[]` makes this alias `false`.
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
 * The `EVENT_TIERS` data form and the union's actual arms are the same set. This is the
 * exhaustiveness criterion at its sharpest: adding an arm without listing it (or listing a tier
 * with no arm) is a compile error, so no enumeration over `EVENT_TIERS` can silently miss a
 * variant.
 * @proof
 */
export type _EventRegistration_DeclaredTiers_MatchTheVariantArms = Expect<
  MutuallyAssignable<EventTierVariant['tier'], EventTier>
>;

/**
 * The derived emission axis is exactly the set `registerEventType` accepts
 * (`{ source: 'auto' | 'model' | 'hook' }`). The literal is written ONCE, here, against a value
 * derived from `EventEmissionSource` — two authorities compared, so adding a sixth member to
 * the shipped union cannot widen {@link EmissionSource} unnoticed.
 * @proof
 */
export type _EventRegistration_EmissionAxis_IsTheRegistrableSet = Expect<
  MutuallyAssignable<EmissionSource, 'auto' | 'model' | 'hook'>
>;

/**
 * The two axes together reproduce the shipped `EventEmissionSource` exactly — the rev-3
 * correction proven rather than asserted in prose. `EmissionSource` (from tier) plus the
 * non-`active` lifecycle states is the full five-value union: no source is underivable, and no
 * value is derivable that the registry cannot hold.
 * @proof
 */
export type _EventRegistration_TwoAxes_ReproduceEventEmissionSource = Expect<
  MutuallyAssignable<EmissionSource | Exclude<EventLifecycle, 'active'>, EventEmissionSource>
>;

/**
 * The lifecycle axis is NOT a coupling class: no lifecycle value is a tier, and no tier is a
 * lifecycle value. If a future edit collapsed them back into one axis this stops holding, which
 * is exactly the regression rev 3 corrected.
 * @proof
 */
export type _EventRegistration_LifecycleAxis_IsDisjointFromTheTierAxis = Expect<
  IsNotAssignable<EventLifecycle, EventTier>
>;

// ─── The data forms are FORMS, not second authorities (task 008) ────────────
//
// Each closed weld vocabulary's tuple and its union are the same set, checked both directions.
// This is what makes the runtime guard in `event-declarations.ts` sound rather than optimistic:
// it can only accept a `rationale` / `reconciler` / `groundTruth` / `gate` the TYPE also accepts.
// Extend either half alone and `tsc` fails here, at the pair, instead of silently letting the
// guard drift wider (or narrower) than the union it claims to decide.

/**
 * {@link SUBSTRATE_RATIONALES} is exactly {@link SubstrateRationale}.
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
 * {@link JUDGMENT_GATE_CLASSES} is exactly {@link SupportedGateClass} — the tooth that makes
 * the no-value-import decision safe. A gate class added upstream reddens the build here.
 * @proof
 */
export type _EventRegistration_JudgmentGateData_MatchesTheUnion = Expect<
  MutuallyAssignable<(typeof JUDGMENT_GATE_CLASSES)[number], SupportedGateClass>
>;
