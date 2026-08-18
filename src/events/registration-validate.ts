// ─── Boot-time weld resolution for the DR-2 event registrations (task 012) ──
//
// DR-2's acceptance criterion, verbatim: *"A `capability` registration naming an unresolvable
// `EffectProviderId` fails at boot."* This module is that gate, and
// {@link assertRegistrationWeldsAtStartup} is what `dispatch/core/context.ts::initializeContext` calls
// before it does anything else — so the failure lands on the shared production boot of BOTH
// facades (the CLI and `exarchos mcp` both route through `index.ts` `main()` →
// `initializeContext`), never at a caller's first append.
//
// ## What "resolvable" means, and why it is not a list in this file
//
// `EffectProviderId` is `EffectProvider['tool']` (`event-registration.ts`) — the composite tool
// that IS a provider's identity in `contract/reachability/providers.ts`. So resolution is
// membership in the LIVE `EFFECT_PROVIDERS` map, read here as a value. Transcribing the five
// shipped tool literals into this module would install exactly the second authority DR-6's census
// exists to detect, and would make this gate vacuous the moment the two copies diverged: a weld
// naming a provider that no longer exists would still "resolve" against the transcription.
//
// One refinement, and it is the difference between the PROPERTY and a PROXY. Membership in
// `EFFECT_PROVIDERS` is only a faithful stand-in for "names a live effect provider" while that map
// still agrees with the effect ledger it is derived from — `providers.ts` says so itself: a
// provider whose `(owner, area, effectClass)` no live `EFFECT_OWNERSHIP` rule backs is STALE. So
// {@link resolvableProviderIds} resolves against the LEDGER-BACKED subset, not the raw array, and
// {@link validateRegistrationWelds} additionally reports the drift as its own diagnostic
// ({@link PROVIDER_REGISTRY_DRIFT_CODE}) so the operator is told which authority broke rather than
// being handed a wave of unresolvable welds with no cause. Both numbers ride the verdict
// (`bootResolvedCount`, `resolvableProviderCount`), so neither can be inspected without the other.
//
// ## The second comparison: declaring tool vs declared provider
//
// Reference integrity asks whether a declared provider names SOMETHING live. It cannot ask whether
// it names the RIGHT thing, and that is a different way for the same weld to be wrong: an event
// registered to `exarchos_workflow` whose only emission edge is declared on an `exarchos_orchestrate`
// action resolves perfectly and still describes the wrong tool.
//
// Both sides of that comparison are composite tool ids. `CapabilityRegistration.provider` is
// `EffectProviderId`, which is `EffectProvider['tool']`; the other side is the `CompositeTool.name`
// the emitting action is registered under. So the check is an equality on ONE id space, read from
// two independent authorities — the annotation table and {@link declaredEmissionEdges} over the
// live tool registry.
//
// What it is NOT, and this is load-bearing: it resolves no module path and walks no filesystem.
// An `AutoEmission` carries an event name and a condition, a `ToolAction` carries no module, and
// the only path-shaped input anywhere near this seam is an async walk of `src/` — which does not
// exist inside the compiled single-file binary and could not run at boot if it did.
//
// It ships at `observe` severity. The shipped catalog contains real disagreements, and refusing
// every entry point over a break set nobody has dispositioned would be a worse gate than none.
//
// ## The third comparison: a weld nothing declares it emits
//
// Both comparisons above range over emission EDGES, so both are blind in the same direction: a
// capability registration nothing emits contributes no edge and is therefore examined by neither.
// It resolves (its provider is live), it never disagrees (there is no declaring tool to disagree
// with), and it declares an effect and a consumer fold that the tree does not contain. That is
// stale cover, and {@link STALE_CAPABILITY_COVER_CODE} is the arm that reports it.
//
// Its eligible population is narrowed on the LIFECYCLE axis, which is orthogonal to the tier axis
// the other two inherit. `planned` and `retired` are the states in which nothing is supposed to
// emit the event, so a missing edge is the tree conforming rather than a fault; excluding them is
// mandatory or the check fires on correct code and gets switched off. The exclusion is a table over
// the axis ({@link STALE_COVER_LIFECYCLE_POLICY}), never a list of exempt event names — the
// difference is that a table cannot go stale, and the reasoning is with the policy.
//
// ## Denominator integrity — seven ways this could go quietly wrong, seven diagnostics
//
// A boot check that resolves nothing must FAIL, not report clean — and so must one that has
// quietly stopped resolving most of what it used to:
//
//   • EMPTY_CAPABILITY_DENOMINATOR — no annotated registration is boot-resolvable at all. The
//     annotation table was emptied, renamed, or every `capability` entry was re-tiered, so no
//     weld could be unresolvable BY CONSTRUCTION.
//   • EMPTY_PROVIDER_REGISTRY — no provider id resolves. `EFFECT_PROVIDERS` was emptied, or the
//     ledger stopped backing every entry, so the resolution set is empty and the check would
//     otherwise fail every weld for the wrong reason (or, with an empty subject set, none).
//   • EMPTY_EMISSION_DENOMINATOR — boot-resolvable events exist, but no declared emission edge
//     names one, so the provider comparison ranged over nothing. Conditioned on a NON-empty weld
//     set precisely so it does not restate EMPTY_CAPABILITY_DENOMINATOR: that code already owns
//     the case where the subject side is what went missing.
//   • NARROWED_EMISSION_DENOMINATOR — the comparison still ranges over something, but over far
//     less than it was measured to. See below; this is the one the vacuity guards cannot see.
//   • EMPTY_STALE_COVER_DENOMINATOR — boot-resolvable welds exist and the lifecycle axis excluded
//     every one of them, so the stale-cover check had no subject. Conditioned on a NON-empty weld
//     set for the same reason as the code above: the vanished-capability-arm case already has an
//     owner, and this one owns what that owner cannot see.
//   • PROVIDER_REGISTRY_DRIFT — a provider entry the ledger no longer backs (or a tool claimed
//     twice). Delegated to `validateEffectProviders`, never re-implemented.
//
// The seventh is STALE_CAPABILITY_COVER itself — a per-event fault rather than a denominator one,
// listed here because its denominator is the one above and neither is readable without the other.
//
// ## Why emptiness is not enough, and why the floor only ratchets one way
//
// Emptiness is a CLIFF, and a vacuity guard can stand at the edge of it. Narrowing is a SLOPE, and
// every point on it satisfies "non-empty": a comparison that used to range over the whole welded
// intersection and now ranges over five edges reports the same shape as a healthy one — same
// verdict fields, same "conforming" reading, no guard tripped. The population that shrinks it is
// not even authored here. It is the product of two other tables (which events are welded, and
// which actions declare an `autoEmits`), so it can collapse as a side effect of an edit that
// touched neither this module nor anything a reader would think to re-measure.
//
// {@link EMISSION_DENOMINATOR_FLOOR} is therefore a measured floor, and it RATCHETS. Growth is
// ordinary — every event registered at the capability tier that something declares it emits widens
// the intersection, and a check that reddened on that would punish the work it exists to support.
// Shrinkage is the defect, so the comparison is `<`, never `!==`. Lowering the floor is a
// deliberate edit of one line with a reason attached, which is exactly the visibility a silent
// narrowing denies.
//
// The floor is a CONSTANT rather than another injectable population, and that is a considered
// asymmetry with everything else in this module. Varying the threshold would exercise the
// comparison operator; varying the emission set exercises the property — and the emission set is
// already a parameter, so the falsifier that matters (an intersection that is genuinely smaller)
// is constructible without opening the floor to a caller who could relax it to zero.
//
// ## Severity: which faults stop the process, expressed as a SECOND table
//
// Reference integrity is not the only thing worth reconciling at this seam, and the checks that
// come after it will legitimately report against the live tree before the tree is repaired. A gate
// with no severity axis cannot say that: any non-empty diagnostic list refuses startup, so the
// first such check makes the tree unbootable for every entry point at once.
//
// {@link DIAGNOSTIC_SEVERITY_POLICY} is therefore the severity decision, and it is deliberately a
// SEPARATE table from {@link WELD_RESOLUTION_POLICY}: one is keyed by tier and answers "where is
// this weld resolved", the other is keyed by diagnostic code and answers "does this fault stop the
// process". Neither restates the other, and each is total over its own axis by type — a new
// diagnostic code cannot reach the boot path without somebody deciding whether it blocks.
//
//   • `blocking` — {@link assertRegistrationWeldsAtStartup} throws. The four reference-integrity
//     codes are here, so the set of inputs that refuse startup is what it has always been.
//   • `observe`  — reported on the boot channel and the process continues. `ok` still goes false
//     (something WAS found), but `bootable` stays true. The two emission-coupling codes are here
//     while their break set is being dispositioned; they graduate by flipping two rows.
//
// ## Scope: why only `capability` is resolved here, expressed as DATA
//
// {@link WELD_RESOLUTION_POLICY} is `Readonly<Record<EventTier, WeldResolutionPolicy>>` — TOTAL
// over the tier axis by type, so a sixth tier cannot be added without deciding how its weld is
// resolved. The scope decision is a table the gate reads, not prose in a test body:
//
//   • `capability`      → resolved HERE, at boot, against the effect-provider registry.
//   • `substrate` / `observation` / `judgment` → their weld vocabularies are CLOSED literal
//     unions with data forms pinned by mutual assignability (`event-registration.ts`), so an
//     unresolvable value does not compile. Re-checking them at boot would be a second authority
//     for a fact `tsc` already owns.
//   • `workflow-local`  → NOT resolvable at boot, and honestly so: `WorkflowDefinitionId` keys
//     `ExarchosConfig.workflows`, which is user-authored per project and not loaded at the point
//     this gate runs (`initializeContext`'s config read happens later, and only when the caller
//     supplies a `projectRoot`). Claiming to resolve it would be a check that passes because it
//     looked at nothing.
//
// ## A known hole, named rather than papered over
//
// `CapabilityRegistration.consumedBy` is the OTHER open reference alias on the capability arm, and
// it is NOT resolved here. `ConsumerId`'s population is `ProjectionReducer.id` plus the
// `ViewProjection` names, and `event-registration.ts` records why it stayed `string`: enumerating
// it from this layer means importing every projection and view, which is a layering inversion.
// The tier's teeth today are the non-empty tuple (a report with extra steps does not compile) plus
// this provider gate; a `consumedBy` naming a reducer that was deleted still boots. That is a real
// gap in DR-2's capability arm and it wants a task of its own — it is not this one, and it is
// recorded here so it cannot be mistaken for covered ground.
// ────────────────────────────────────────────────────────────────────────────

import {
  EFFECT_PROVIDERS,
  ruleBacksProvider,
  validateEffectProviders,
  type EffectProvider,
} from '../contract/reachability/providers.js';
import { EFFECT_OWNERSHIP, type EffectOwnershipRule } from '../architecture/effect-ledger.js';
import { TOOL_REGISTRY, type CompositeTool } from '../registry.js';
import { EVENT_ANNOTATIONS } from './event-annotations.js';
import {
  weldReferenceOf,
  type CapabilityRegistration,
  type EffectProviderId,
  type EventLifecycle,
  type EventRegistration,
  type EventTier,
  type EventTierVariant,
} from './event-registration.js';

// ─── The policy, as data ────────────────────────────────────────────────────

/** The diagnostic code for a capability weld naming a provider that does not resolve. */
export const UNRESOLVABLE_PROVIDER_CODE = 'UNRESOLVABLE_PROVIDER';
/** The diagnostic code for the provider map having drifted from the effect ledger. */
export const PROVIDER_REGISTRY_DRIFT_CODE = 'PROVIDER_REGISTRY_DRIFT';
/**
 * The diagnostic code for an emission edge whose declaring composite tool is not the provider the
 * event's `capability` registration declares.
 */
export const EMISSION_PROVIDER_MISMATCH_CODE = 'EMISSION_PROVIDER_MISMATCH';
/**
 * The diagnostic code for a capability registration that is supposed to be emitted and that no
 * declared emission edge names — a weld claiming cover nothing in the tool registry backs.
 */
export const STALE_CAPABILITY_COVER_CODE = 'STALE_CAPABILITY_COVER';

/**
 * The measured size of the set the provider comparison ranges over: declared emission edges whose
 * event carries a boot-resolvable weld.
 *
 * It is a FLOOR, not an expectation. The comparison is `compared < EMISSION_DENOMINATOR_FLOOR`, so
 * a wider intersection passes untouched — registering more capability events, or declaring more
 * emissions on the actions that already carry them, is the ordinary direction of travel and must
 * not redden anything. A narrower one is the fault: it means the comparison silently stopped
 * covering ground it used to cover, while still passing every non-empty check in this file.
 *
 * Raising it is free and welcome. LOWERING it is the deliberate act this number exists to force —
 * one line, in a commit that can be asked why.
 */
export const EMISSION_DENOMINATOR_FLOOR = 46;

/**
 * How one tier's weld reference is resolved. `authority` names the live registry a `boot`-resolved
 * ref is looked up in; the other two arms carry only a rationale, because there is nothing to look
 * up at boot.
 */
export type WeldResolutionPolicy =
  | {
      readonly resolvedAt: 'boot';
      /** The live registry the ref is resolved against. */
      readonly authority: 'effect-provider-registry';
      readonly note: string;
    }
  | {
      /** A closed literal union with a data form — `tsc` already rejects an unresolvable value. */
      readonly resolvedAt: 'compile';
      readonly note: string;
    }
  | {
      /** No registry exists at boot to resolve against, and pretending otherwise is a vacuous check. */
      readonly resolvedAt: 'never';
      readonly note: string;
    };

/**
 * Which tiers this gate resolves, and against what.
 *
 * `Readonly<Record<EventTier, …>>` makes the table TOTAL over the tier axis: a sixth coupling tier
 * is a `tsc` error here until somebody decides how its weld is resolved. That is the whole reason
 * the scope lives in a table the gate reads rather than in a `if (tier === 'capability')` the
 * reader has to reverse-engineer.
 */
export const WELD_RESOLUTION_POLICY: Readonly<Record<EventTier, WeldResolutionPolicy>> =
  Object.freeze({
    substrate: {
      resolvedAt: 'compile',
      note:
        '`SubstrateRationale` is a closed literal union pinned to `SUBSTRATE_RATIONALES` by mutual ' +
        'assignability, so a rationale outside the vocabulary does not compile.',
    },
    capability: {
      resolvedAt: 'boot',
      authority: 'effect-provider-registry',
      note:
        '`EffectProviderId` is `EffectProvider["tool"]` and is structurally `string` on purpose — ' +
        'closing it to the five shipped literals would transcribe `EFFECT_PROVIDERS` into a second ' +
        'authority. Reference integrity is therefore a BOOT failure, which is this module.',
    },
    observation: {
      resolvedAt: 'compile',
      note:
        '`ReconcilerId` and `GroundTruthSource` are closed literal unions with pinned data forms. ' +
        'DR-11 (task 032) extends the vocabulary; it does not open it.',
    },
    judgment: {
      resolvedAt: 'compile',
      note:
        '`SupportedGateClass` is the shipped nine-class union, pinned to `JUDGMENT_GATE_CLASSES`. ' +
        'A tenth gate class reddens `event-registration.ts` before it can reach a registration.',
    },
    'workflow-local': {
      resolvedAt: 'never',
      note:
        '`WorkflowDefinitionId` keys `ExarchosConfig.workflows`, which is user-authored per project ' +
        'and not loaded when this gate runs. There is no registry to resolve against at boot, and a ' +
        'check that looks at nothing is not a check.',
    },
  });

/**
 * Whether one lifecycle state's registrations belong in the stale-cover population.
 *
 * A discriminated union rather than a bare boolean, because the EXCLUDED arm is the one that has to
 * carry a reason. `eligible: false` on its own records a decision with none of the thinking behind
 * it, and the next reader cannot tell a state that is structurally unnameable from one somebody
 * switched off to make a check go green.
 */
export type StaleCoverEligibility =
  | {
      readonly eligible: true;
      /** What a MISSING emission edge means here — the reason the check has a subject at all. */
      readonly note: string;
    }
  | {
      readonly eligible: false;
      /** Which half of the not-emitted axis this is: nothing emits it yet, or nothing emits it now. */
      readonly unemitted: 'not-yet' | 'not-any-more';
      readonly note: string;
    };

/**
 * Which lifecycle states the stale-cover check ranges over.
 *
 * `Readonly<Record<EventLifecycle, …>>` makes this TOTAL over the lifecycle axis, exactly as
 * {@link WELD_RESOLUTION_POLICY} is total over the tier axis: a fourth lifecycle state is a `tsc`
 * error here until somebody decides whether an unnamed registration in it is a defect. The two
 * tables stay apart because they answer different questions about the same registration — one asks
 * where its reference is resolved, this one asks whether anything is supposed to emit it — and the
 * axes are independent, so a `retired` capability event is an ordinary record rather than a
 * contradiction.
 *
 * **THE EXCLUSION IS THE POINT, and it is why this is a table over the axis and not a list of
 * exempt event names.** An event nothing emits yet, and an event nothing emits any more, are both
 * registrations that no emission edge CAN name: the tree is conforming and a check that reported
 * them would be firing on correct code. Written as a list of event types, that observation would be
 * true on the day it was taken and quietly false afterwards — every newly-planned event would
 * arrive unlisted and red, the list would be topped up until it was a rubber stamp, and the day a
 * genuinely stale active weld appeared it would be waved through with everything else. Read off the
 * lifecycle field, the exemption cannot go stale, because it is not a record of WHICH events are
 * non-emitting; it is the statement that a non-emitting event has no edge to be named by.
 */
export const STALE_COVER_LIFECYCLE_POLICY: Readonly<Record<EventLifecycle, StaleCoverEligibility>> =
  Object.freeze({
    active: {
      eligible: true,
      note:
        'Something is supposed to emit it. A capability registration is a claim that an effect ' +
        'provider appends the event and that at least one fold consumes it, so an active one that ' +
        'no declared emission edge names is a weld with nothing on the other end.',
    },
    planned: {
      eligible: false,
      unemitted: 'not-yet',
      note:
        'The data schema and the type-map entry exist and nothing emits the event yet. There is no ' +
        'edge to find, so the absence is the expected reading of a conforming tree, not a fault.',
    },
    retired: {
      eligible: false,
      unemitted: 'not-any-more',
      note:
        'The registration is KEPT so historical logs stay replayable, and nothing emits the event ' +
        'any more. Its weld still records what it was welded to while it was live; the missing ' +
        'emission edge is what retirement MEANS, so reporting it would be reporting the intent.',
    },
  });

// ─── Diagnostics ────────────────────────────────────────────────────────────

/**
 * Whether a diagnostic stops the process.
 *
 * `blocking` throws out of {@link assertRegistrationWeldsAtStartup}; `observe` is written to the
 * boot channel and startup continues. The distinction exists so a check can be armed and measured
 * against the live tree before it is allowed to refuse every entry point.
 */
export type WeldDiagnosticSeverity = 'blocking' | 'observe';

/** A single weld-resolution fault. `eventType`/`provider` are `null` for population-level faults. */
export type WeldResolutionDiagnostic =
  | {
      readonly code: typeof UNRESOLVABLE_PROVIDER_CODE;
      readonly eventType: string;
      readonly provider: string;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: typeof PROVIDER_REGISTRY_DRIFT_CODE;
      readonly eventType: null;
      readonly provider: string;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: 'EMPTY_CAPABILITY_DENOMINATOR';
      readonly eventType: null;
      readonly provider: null;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: 'EMPTY_PROVIDER_REGISTRY';
      readonly eventType: null;
      readonly provider: null;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: typeof EMISSION_PROVIDER_MISMATCH_CODE;
      readonly eventType: string;
      /** The provider the event's registration DECLARES. */
      readonly provider: string;
      /** The action carrying the emission edge. */
      readonly action: string;
      /** The composite tool that action belongs to — the side the registration does not name. */
      readonly declaringTool: string;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: 'EMPTY_EMISSION_DENOMINATOR';
      readonly eventType: null;
      readonly provider: null;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: 'NARROWED_EMISSION_DENOMINATOR';
      readonly eventType: null;
      readonly provider: null;
      /** How many edges the comparison actually ranged over — non-zero, or this is the empty case. */
      readonly compared: number;
      /** The measured size it is held at, so the shortfall is readable without a second lookup. */
      readonly floor: number;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: typeof STALE_CAPABILITY_COVER_CODE;
      readonly eventType: string;
      /** The provider the registration declares — the cover nothing in the registry is backing. */
      readonly provider: string;
      /**
       * The lifecycle that put this registration in the population, carried on the finding so the
       * exclusion axis is readable from the fault itself. A reader who thinks a lifecycle should
       * have been excluded can see which one admitted the event without re-reading the catalog.
       */
      readonly lifecycle: EventLifecycle;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: 'EMPTY_STALE_COVER_DENOMINATOR';
      readonly eventType: null;
      readonly provider: null;
      /**
       * Boot-resolvable welds the lifecycle axis excluded — the population that swallowed the
       * subject set, so a reader can tell "everything was retired" from "there were no welds".
       */
      readonly excludedByLifecycle: number;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    };

/**
 * Every code this gate can emit, read OFF the diagnostic union rather than listed beside it. A
 * second list would be a second authority: a code renamed on one side and not the other would go
 * unnoticed, and the severity table below would silently stop covering it.
 */
export type WeldDiagnosticCode = WeldResolutionDiagnostic['code'];

/**
 * Which diagnostics stop the process.
 *
 * `Readonly<Record<WeldDiagnosticCode, …>>` makes the table TOTAL over the diagnostic axis, the
 * same way {@link WELD_RESOLUTION_POLICY} is total over the tier axis: a new diagnostic is a `tsc`
 * error here until somebody decides whether it blocks boot. The two tables are kept apart on
 * purpose — this one has no opinion about which tier a weld belongs to, and that one has no
 * opinion about what a fault costs.
 *
 * The four REFERENCE-INTEGRITY rows are `blocking`. That is not a placeholder: it is the
 * behaviour this gate shipped with, written down.
 *
 * The five EMISSION-COUPLING rows are `observe`, and that is the whole reason the axis exists.
 * The comparison they carry reports against the live tree BEFORE the tree is reconciled — there
 * are real, measured disagreements in the shipped catalog — so arming it as `blocking` would take
 * every entry point down over a break set nobody has dispositioned yet. Graduating them is a
 * deliberate edit of these rows once that set is disposed of, not a side effect of some other
 * change.
 *
 * `NARROWED_EMISSION_DENOMINATOR` sits here for a second reason of its own: a floor that refused
 * startup would turn any legitimate re-tiering of a capability event into an unbootable tree for
 * every entry point at once, which is a far worse outcome than the narrowing it is watching for.
 *
 * `STALE_CAPABILITY_COVER` sits here for the same reason its sibling comparison does — the shipped
 * catalog carries a measured break set of active capability registrations nothing declares it
 * emits, and refusing every entry point over a set nobody has dispositioned would be a worse gate
 * than none. Its vacuity guard rides at the same severity so the two cannot be read apart: a fault
 * and the reason its denominator vanished should not arrive with different weights.
 */
export const DIAGNOSTIC_SEVERITY_POLICY: Readonly<Record<WeldDiagnosticCode, WeldDiagnosticSeverity>> =
  Object.freeze({
    [UNRESOLVABLE_PROVIDER_CODE]: 'blocking',
    [PROVIDER_REGISTRY_DRIFT_CODE]: 'blocking',
    EMPTY_CAPABILITY_DENOMINATOR: 'blocking',
    EMPTY_PROVIDER_REGISTRY: 'blocking',
    [EMISSION_PROVIDER_MISMATCH_CODE]: 'observe',
    EMPTY_EMISSION_DENOMINATOR: 'observe',
    NARROWED_EMISSION_DENOMINATOR: 'observe',
    [STALE_CAPABILITY_COVER_CODE]: 'observe',
    EMPTY_STALE_COVER_DENOMINATOR: 'observe',
  });

/** The verdict, carrying EVERY denominator so no count can be read without its population. */
export interface WeldResolutionVerdict {
  /** No diagnostic of ANY severity was reported — the fully clean tree. */
  readonly ok: boolean;
  /**
   * No BLOCKING diagnostic was reported, so startup proceeds. This is the boot decision, and it is
   * deliberately weaker than {@link ok}: an observe-severity finding leaves the tree bootable while
   * still refusing to report clean.
   */
  readonly bootable: boolean;
  /** Annotated registrations whose tier policy is `resolvedAt: 'boot'` — the SUBJECT denominator. */
  readonly bootResolvedCount: number;
  /** Distinct provider ids backed by exactly one live ledger rule — the REGISTRY denominator. */
  readonly resolvableProviderCount: number;
  /** Emission edges declared across the tool registry — the EMISSION population. */
  readonly emissionEdgeCount: number;
  /**
   * Emission edges whose event is a boot-resolved weld — the denominator of the provider
   * comparison, and the only one of the three that can be non-empty while this one is zero.
   *
   * This is the number {@link EMISSION_DENOMINATOR_FLOOR} holds a floor under, so a reader of a
   * verdict can see how wide the comparison actually was rather than inferring it from the absence
   * of findings — an absence a narrowed comparison produces just as convincingly as a healthy one.
   */
  readonly comparedEmissionEdgeCount: number;
  /**
   * Boot-resolved welds whose lifecycle admits them to the stale-cover check — the subject
   * population of that check, and the only denominator in this verdict the lifecycle axis narrows.
   *
   * It rides the verdict rather than staying implicit for the reason every other count here does,
   * and more sharply: a check that finds nothing because it is looking at nothing publishes exactly
   * the shape of one that finds nothing because the tree is clean. Zero is a FAULT
   * (`EMPTY_STALE_COVER_DENOMINATOR`), never a pass, and this number is how a reader sees which of
   * the two they are holding.
   */
  readonly staleCoverEligibleCount: number;
  readonly diagnostics: readonly WeldResolutionDiagnostic[];
  /** How many of {@link diagnostics} are `blocking` — the count that decides {@link bootable}. */
  readonly blockingCount: number;
  /** How many of {@link diagnostics} are `observe` — reported, survivable, still not clean. */
  readonly observeCount: number;
  /** Deterministic, human-readable summary (green light or the fault list). */
  readonly report: string;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The ordering key for one diagnostic, joined on a separator no field can contain.
 *
 * `action` is part of the key because the emission-coupling comparison can report SEVERAL faults
 * for one `(event, provider)` pair — one per declaring action — and a key that stopped at the
 * provider would leave those rows ordered by scan order rather than by anything a reader (or a
 * golden report) can predict.
 */
const diagnosticSortKey = (d: WeldResolutionDiagnostic): string =>
  [d.code, d.eventType ?? '', d.provider ?? '', 'action' in d ? d.action : ''].join('\u0000');

/**
 * The provider ids that actually resolve: every tool claimed by EXACTLY ONE provider entry that is
 * itself backed by EXACTLY ONE live `EFFECT_OWNERSHIP` rule.
 *
 * Both "exactly one"s are `providers.ts`'s own requirement, reused through its exported
 * {@link ruleBacksProvider} rather than restated. A tool claimed twice is an ambiguous provider and
 * a stale entry is not a live provider at all — in neither case does the id name one thing, which
 * is what an `EffectProviderId` is supposed to do.
 *
 * Sorted, so a failure message is stable.
 */
export function resolvableProviderIds(
  providers: readonly EffectProvider[] = EFFECT_PROVIDERS,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
): readonly string[] {
  const backedCountByTool = new Map<string, number>();
  for (const provider of providers) {
    const backing = rules.filter((rule) => ruleBacksProvider(rule, provider)).length;
    if (backing !== 1) continue;
    backedCountByTool.set(provider.tool, (backedCountByTool.get(provider.tool) ?? 0) + 1);
  }
  const resolvable: string[] = [];
  for (const [tool, count] of backedCountByTool) {
    if (count === 1) resolvable.push(tool);
  }
  return Object.freeze(resolvable.sort(byString));
}

/**
 * One boot-resolvable weld: the event, the reference its tier policy resolves, and the LIFECYCLE
 * state the registration carries.
 *
 * `lifecycle` rides on the same record as `ref` rather than being recovered downstream from a
 * second walk of the annotation table, because the two questions this module asks about a
 * registration — does its reference resolve, and is anything supposed to emit it — must be asked of
 * the same row. A second walk would be a second authority for which registrations are in scope, and
 * the two could disagree the moment {@link WELD_RESOLUTION_POLICY} moved.
 */
export interface BootResolvedWeld {
  readonly eventType: string;
  readonly ref: string;
  readonly lifecycle: EventLifecycle;
}

/**
 * The boot-resolvable welds in an annotation table: `(eventType, ref, lifecycle)` for every
 * registration whose tier policy says `resolvedAt: 'boot'`.
 *
 * The ref comes from {@link weldReferenceOf}, whose `switch` has no `default` beyond the `never`
 * binding — so "what is this registration welded to" has ONE runtime authority and a sixth tier
 * cannot slip past it. Sorted by event type.
 */
export function bootResolvedWelds(
  annotations: Readonly<Record<string, EventRegistration>> = EVENT_ANNOTATIONS,
  policy: Readonly<Record<EventTier, WeldResolutionPolicy>> = WELD_RESOLUTION_POLICY,
): readonly BootResolvedWeld[] {
  const welds: BootResolvedWeld[] = [];
  for (const [eventType, registration] of Object.entries(annotations)) {
    if (policy[registration.tier].resolvedAt !== 'boot') continue;
    welds.push({
      eventType,
      ref: weldReferenceOf(registration).ref,
      lifecycle: registration.lifecycle,
    });
  }
  return Object.freeze(welds.sort((a, b) => byString(a.eventType, b.eventType)));
}

/**
 * The welds the stale-cover check ranges over: those whose lifecycle
 * {@link STALE_COVER_LIFECYCLE_POLICY} marks eligible.
 *
 * The filter reads the TABLE, and that is the whole mechanism. Written as `lifecycle === 'active'`
 * the same rows would come out today and the policy would become decoration — a second authority
 * that agrees by luck until somebody edits one of the two. `lifecyclePolicy` is a parameter with
 * the live default for the same reason every other population in this module is one: a filter that
 * could only ever consult one hard-wired table could not be shown to be consulting it at all.
 */
export function staleCoverEligibleWelds(
  welds: readonly BootResolvedWeld[],
  lifecyclePolicy: Readonly<
    Record<EventLifecycle, StaleCoverEligibility>
  > = STALE_COVER_LIFECYCLE_POLICY,
): readonly BootResolvedWeld[] {
  return Object.freeze(welds.filter((weld) => lifecyclePolicy[weld.lifecycle].eligible));
}

/**
 * One declared emission edge, flattened out of the tool registry: an action says it emits an event,
 * and the action belongs to a composite tool.
 *
 * {@link declaringTool} is the tool the emitting action is registered under — the SAME id space as
 * `EffectProviderId`, which is `EffectProvider['tool']`. That is what makes the two sides
 * comparable at all, and it is why nothing here touches a module path: an `AutoEmission` carries an
 * event name and a condition, a `ToolAction` carries no module, and the only path-shaped input in
 * reach is a filesystem walk of `src/` that does not exist inside the single-file binary and could
 * not run at boot if it did.
 */
export interface EmissionEdge {
  /** The event type the action declares it emits. */
  readonly event: string;
  /** The action carrying the declaration. */
  readonly action: string;
  /** The composite tool that action is registered under. */
  readonly declaringTool: string;
}

/**
 * Flatten the tool registry into `(event, action, declaringTool)` triples — the EMISSION population
 * the provider comparison reads.
 *
 * The registry is read as a VALUE, exactly as {@link resolvableProviderIds} reads the provider map:
 * transcribing which tool owns which action into this module would install the second authority the
 * comparison exists to detect, and the comparison would then agree with itself. Sorted so a report
 * is stable.
 */
export function declaredEmissionEdges(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): readonly EmissionEdge[] {
  const edges: EmissionEdge[] = [];
  for (const tool of registry) {
    for (const action of tool.actions) {
      for (const emission of action.autoEmits ?? []) {
        edges.push({ event: emission.event, action: action.name, declaringTool: tool.name });
      }
    }
  }
  return Object.freeze(
    edges.sort(
      (a, b) =>
        byString(a.event, b.event) ||
        byString(a.declaringTool, b.declaringTool) ||
        byString(a.action, b.action),
    ),
  );
}

/**
 * Reconcile every boot-resolvable weld against the live provider registry. Pure and total: returns
 * a verdict, never throws. `ok === true` is the boot green light.
 *
 * Every population is a PARAMETER with a live default, so a caller (a test, a kill fixture) can
 * seed an unresolvable provider without mutating the frozen catalog. A gate that could only ever
 * read one hard-wired input could not be shown to be capable of reporting anything.
 */
export function validateRegistrationWelds(
  annotations: Readonly<Record<string, EventRegistration>> = EVENT_ANNOTATIONS,
  providers: readonly EffectProvider[] = EFFECT_PROVIDERS,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
  policy: Readonly<Record<EventTier, WeldResolutionPolicy>> = WELD_RESOLUTION_POLICY,
  severityPolicy: Readonly<
    Record<WeldDiagnosticCode, WeldDiagnosticSeverity>
  > = DIAGNOSTIC_SEVERITY_POLICY,
  emissions: readonly EmissionEdge[] = declaredEmissionEdges(),
  lifecyclePolicy: Readonly<
    Record<EventLifecycle, StaleCoverEligibility>
  > = STALE_COVER_LIFECYCLE_POLICY,
): WeldResolutionVerdict {
  const diagnostics: WeldResolutionDiagnostic[] = [];
  // One lookup, so severity is stamped from the table at every emission site and never decided
  // inline. A diagnostic constructed with a hard-coded severity would be a third authority.
  const severityOf = (code: WeldDiagnosticCode): WeldDiagnosticSeverity => severityPolicy[code];

  // ── The registry side, and its drift ─────────────────────────────────────
  // Reported BEFORE the welds so the cause is named, not just its consequences.
  for (const drift of validateEffectProviders(providers, rules).diagnostics) {
    diagnostics.push({
      code: PROVIDER_REGISTRY_DRIFT_CODE,
      eventType: null,
      provider: drift.tool,
      severity: severityOf(PROVIDER_REGISTRY_DRIFT_CODE),
      message:
        `[${drift.code}] ${drift.message} A weld cannot be resolved against a provider map that ` +
        `has drifted from the effect ledger — reconcile ` +
        `contract/reachability/providers.ts with architecture/effect-ledger.ts.`,
    });
  }

  const resolvable = resolvableProviderIds(providers, rules);
  const resolvableSet = new Set(resolvable);
  if (resolvable.length === 0) {
    diagnostics.push({
      code: 'EMPTY_PROVIDER_REGISTRY',
      eventType: null,
      provider: null,
      severity: severityOf('EMPTY_PROVIDER_REGISTRY'),
      message:
        'no effect-provider id resolves — the provider map is empty or nothing in it is backed by ' +
        'a live EFFECT_OWNERSHIP rule. Every capability weld would fail for a reason that is not ' +
        'about the weld, so this is reported as its own fault rather than as N unresolvable welds.',
    });
  }

  // ── The subject side ─────────────────────────────────────────────────────
  const welds = bootResolvedWelds(annotations, policy);
  if (welds.length === 0) {
    diagnostics.push({
      code: 'EMPTY_CAPABILITY_DENOMINATOR',
      eventType: null,
      provider: null,
      severity: severityOf('EMPTY_CAPABILITY_DENOMINATOR'),
      message:
        'no annotated registration is boot-resolvable — nothing in the catalog carries a tier whose ' +
        `WELD_RESOLUTION_POLICY entry is resolvedAt: 'boot' (today that is the 'capability' tier). ` +
        'The annotation table was emptied, moved, or fully re-tiered; a resolution check over an ' +
        'empty subject set cannot fail and must therefore not report clean.',
    });
  }

  for (const weld of welds) {
    if (resolvableSet.has(weld.ref)) continue;
    diagnostics.push({
      code: UNRESOLVABLE_PROVIDER_CODE,
      eventType: weld.eventType,
      provider: weld.ref,
      severity: severityOf(UNRESOLVABLE_PROVIDER_CODE),
      message:
        `event '${weld.eventType}' is registered tier 'capability' with provider '${weld.ref}', ` +
        `which names no live effect provider. Resolvable ids: [${resolvable.join(', ')}]. ` +
        'Either the weld names a provider that never existed, or the provider it named was ' +
        'renamed/removed from contract/reachability/providers.ts.',
    });
  }

  // ── The emission side: does the declaring tool match the declared provider? ─
  //
  // Reference integrity above asks whether the declared provider names SOMETHING live. This asks
  // the other half: whether it names the RIGHT thing — the composite tool that actually declares
  // the emission. Both sides are composite tool ids, so the comparison is a direct equality on one
  // id space rather than a resolution through anything.
  //
  // Scope is inherited, not re-decided: the subject set is {@link bootResolvedWelds}, so the
  // capability-only scope keeps its one authority in WELD_RESOLUTION_POLICY. An event nothing emits
  // contributes no edge and is silently in scope with nothing to compare — which is exactly what
  // the vacuity guard below exists to notice.
  const providerByEvent = new Map(welds.map((weld) => [weld.eventType, weld.ref]));
  const compared = emissions.filter((edge) => providerByEvent.has(edge.event));
  if (welds.length > 0 && compared.length === 0) {
    diagnostics.push({
      code: 'EMPTY_EMISSION_DENOMINATOR',
      eventType: null,
      provider: null,
      severity: severityOf('EMPTY_EMISSION_DENOMINATOR'),
      message:
        `no declared emission edge names a boot-resolvable event, over ${welds.length} such ` +
        `event(s) and ${emissions.length} declared edge(s) in total. Either the tool registry ` +
        "declares no `autoEmits` at all (the field was renamed, or the registry barrel moved), or " +
        'nothing it emits is registered at the capability tier. The provider comparison ranged ' +
        'over an empty set and therefore cannot have found anything, which must not read as clean.',
    });
  }

  // The case the guard above CANNOT see. `compared.length > 0` is what keeps the two disjoint by
  // construction rather than by convention: emptiness belongs to the code above, and everything
  // this one reports is a set that was non-empty and still too small. A comparison narrowed to a
  // handful of edges produces a verdict indistinguishable from a healthy one — non-empty
  // populations, no mismatch, `ok: true` — so nothing else in this file would notice it.
  if (compared.length > 0 && compared.length < EMISSION_DENOMINATOR_FLOOR) {
    diagnostics.push({
      code: 'NARROWED_EMISSION_DENOMINATOR',
      eventType: null,
      provider: null,
      compared: compared.length,
      floor: EMISSION_DENOMINATOR_FLOOR,
      severity: severityOf('NARROWED_EMISSION_DENOMINATOR'),
      message:
        `the provider comparison ranged over ${compared.length} emission edge(s), below the ` +
        `measured floor of ${EMISSION_DENOMINATOR_FLOOR}, out of ${emissions.length} declared ` +
        `edge(s) against ${welds.length} boot-resolvable event(s). The set is not empty, so every ` +
        'vacuity check in this gate is satisfied and the comparison still reports on whatever is ' +
        'left — which is how a narrowing hides. Either an annotation was re-tiered off the ' +
        'capability arm, or actions stopped declaring the `autoEmits` that named those events. If ' +
        'the shrink is intended, lower EMISSION_DENOMINATOR_FLOOR in the same change and say why.',
    });
  }

  for (const edge of compared) {
    const declared = providerByEvent.get(edge.event);
    if (declared === undefined || declared === edge.declaringTool) continue;
    diagnostics.push({
      code: EMISSION_PROVIDER_MISMATCH_CODE,
      eventType: edge.event,
      provider: declared,
      action: edge.action,
      declaringTool: edge.declaringTool,
      severity: severityOf(EMISSION_PROVIDER_MISMATCH_CODE),
      // All four sides in one message, so a single boot tells an operator which annotation and
      // which action disagree without a second run to find the other half.
      message:
        `action '${edge.action}' on composite tool '${edge.declaringTool}' declares it emits ` +
        `'${edge.event}', but that event is registered tier 'capability' with provider ` +
        `'${declared}'. The declaring tool and the declared provider are the same id space ` +
        '(EffectProvider["tool"]), so one of the two is wrong: either the annotation names the ' +
        'wrong provider, or the emission is declared on the wrong tool.',
    });
  }

  // ── The stale-cover check: an active weld nothing declares it emits ───────
  //
  // Everything above can only speak about events something DOES emit. A capability registration
  // that contributes no emission edge is invisible to all of it and passes by not being looked at,
  // which is the cheapest way for a weld to be wrong: it declares a provider and a consumer fold,
  // and the tree contains neither the emission nor anything that notices the emission is missing.
  // That is cover rather than coupling, and it is what this arm reports.
  //
  // The population is narrowed by LIFECYCLE and by nothing else. A `planned` or `retired`
  // registration is one no edge can name, so firing on it would be firing on a conforming tree —
  // and the exclusion is read out of a table that is total over the axis rather than out of a list
  // of exempt event names, which would need topping up every time an event was planned and would
  // be a rubber stamp within a release. See {@link STALE_COVER_LIFECYCLE_POLICY}.
  const eligible = staleCoverEligibleWelds(welds, lifecyclePolicy);
  const excludedByLifecycle = welds.length - eligible.length;

  // Conditioned on a non-empty WELD set for the same reason EMPTY_EMISSION_DENOMINATOR is: the case
  // where the capability arm itself went missing already has an owner, and two codes reporting one
  // fact would leave a reader guessing which is the cause. What this one owns is the case that code
  // cannot see — welds exist, and the lifecycle axis excluded every one of them.
  if (welds.length > 0 && eligible.length === 0) {
    diagnostics.push({
      code: 'EMPTY_STALE_COVER_DENOMINATOR',
      eventType: null,
      provider: null,
      excludedByLifecycle,
      severity: severityOf('EMPTY_STALE_COVER_DENOMINATOR'),
      message:
        `no boot-resolvable weld is stale-cover eligible, over ${welds.length} such weld(s) — the ` +
        `lifecycle axis excluded every one of them. A capability arm holding nothing that anything ` +
        'is supposed to emit is either a catalog that has been retired wholesale or a lifecycle ' +
        'field that has stopped being read, and in both cases the stale-cover check ranged over an ' +
        'empty set and cannot have found anything. An absence measured over nothing must not read ' +
        'as clean.',
    });
  }

  // Membership in the DECLARED population, not in the compared one. The two coincide by
  // construction — a declared edge naming a boot-resolved event is exactly what `compared` collects
  // — and taking it from `emissions` says the honest thing: the question is whether ANY action in
  // the registry claims to emit this event, with no filter of this module's in between.
  const namedByAnEdge = new Set(emissions.map((edge) => edge.event));
  for (const weld of eligible) {
    if (namedByAnEdge.has(weld.eventType)) continue;
    diagnostics.push({
      code: STALE_CAPABILITY_COVER_CODE,
      eventType: weld.eventType,
      provider: weld.ref,
      lifecycle: weld.lifecycle,
      severity: severityOf(STALE_CAPABILITY_COVER_CODE),
      message:
        `event '${weld.eventType}' is registered tier 'capability' with provider '${weld.ref}' ` +
        `and lifecycle '${weld.lifecycle}', and no action in the tool registry declares that it ` +
        'emits it. The registration claims an effect provider appends the event and that something ' +
        'folds the result, so with no declared emission edge it is cover rather than coupling — ' +
        'and the provider comparison cannot report on it either, because there is no declaring ' +
        'tool to compare the declared provider against. Either an action is missing the autoEmits ' +
        "entry that would name it, or nothing emits the event and the registration's lifecycle " +
        'should say so.',
    });
  }

  const sorted = [...diagnostics].sort((a, b) =>
    byString(diagnosticSortKey(a), diagnosticSortKey(b)),
  );
  // ── The severity split ───────────────────────────────────────────────────
  // `ok` keeps its original meaning — nothing at all was found — because a check that reports an
  // observation has NOT found the tree clean. `bootable` is the strictly weaker boot decision, and
  // it is the only one `assertRegistrationWeldsAtStartup` reads.
  const blocking = sorted.filter((d) => d.severity === 'blocking');
  const observed = sorted.filter((d) => d.severity === 'observe');
  const ok = sorted.length === 0;
  const bootable = blocking.length === 0;

  const line = (d: WeldResolutionDiagnostic): string =>
    `  [${d.code}] ${d.eventType ?? d.provider ?? '<catalog>'}: ${d.message}`;
  // Observations are a TRAILING block rather than an inline tag, so a report with none of them is
  // the plain refusal (or the plain green light) with nothing appended — the severity axis costs a
  // reader who has no observations to read exactly nothing.
  const observedBlock =
    observed.length === 0
      ? ''
      : `\nobserve-only — ${observed.length} finding(s) reported without blocking boot:\n` +
        observed.map(line).join('\n');

  // Every count is rendered beside the population it was measured over, so no number in this
  // report can be read without the denominator that gives it a meaning.
  const overPopulations =
    `${welds.length} boot-resolved weld(s), ${eligible.length} stale-cover eligible, ` +
    `${resolvable.length} live provider(s) and ${compared.length} compared emission edge(s)`;

  const report = ok
    ? `event registration welds OK — ${welds.length} boot-resolved weld(s) ` +
      `(${eligible.length} stale-cover eligible) against ${resolvable.length} live effect ` +
      `provider(s) and ${compared.length} compared emission edge(s)`
    : bootable
      ? `event registration welds BOOTABLE — 0 blocking fault(s) over ${overPopulations}` +
        observedBlock
      : `event registration weld resolution FAILED — ${blocking.length} fault(s) over ` +
        `${overPopulations}:\n` +
        blocking.map(line).join('\n') +
        observedBlock;

  return {
    ok,
    bootable,
    bootResolvedCount: welds.length,
    resolvableProviderCount: resolvable.length,
    emissionEdgeCount: emissions.length,
    comparedEmissionEdgeCount: compared.length,
    staleCoverEligibleCount: eligible.length,
    diagnostics: sorted,
    blockingCount: blocking.length,
    observeCount: observed.length,
    report,
  };
}

// ─── The break set, and its disposition ─────────────────────────────────────
//
// A diagnostic nobody has to answer for is an alarm with the wires cut. The comparison above ships
// at `observe` precisely BECAUSE the live catalog disagrees with itself in places, and that
// concession is only defensible while every disagreement it reports has been looked at and written
// down. Left open, `observe` decays into `ignore`: the day a genuinely new break appears it arrives
// inside a wall of findings that has been scrolling past unread since the check was armed.
//
// So the break set is a LEDGER, and {@link auditDisagreementDispositions} is the two-way ratchet
// over it:
//
//   • UNDISPOSITIONED_DISAGREEMENT — the comparison reports an edge no row answers for. This is the
//     arm carrying the weight: a new disagreement, arriving from an annotation edit or a relocated
//     action, REDDENS rather than joining the observed pile.
//   • STALE_DISPOSITION — a row answers for an edge the comparison no longer reports. Each row's
//     reasoning is about one measured fact; once that fact is gone the row is a claim the tree no
//     longer supports, and keeping it would let the ledger outlive its subject.
//
// The denominator is the comparison's OWN output, never a list typed here. A row is matched on all
// FOUR sides, because all four are what was reasoned about. Rename the action and the old row goes
// stale while the new edge goes undispositioned — the correct pair of answers, since nobody has
// looked at the new fact yet.
//
// ## The two classifications, and why the distinction is not a matter of taste
//
// `genuine-mismatch` is NOT "we decided to live with it". It is the case where the id space cannot
// express the truth, so there is no value to repair the annotation TO. `EffectProviderId` is
// `EffectProvider['tool']`, and every provider is pinned to one module area by a live ledger rule —
// so an event whose append lives in an area no provider claims has no correct annotation available
// at all. Both sides are then reporting different true things, and the comparison naming both is
// the intended outcome rather than a defect awaiting repair.
//
// `annotation-error` is the opposite: a correct value EXISTS in the vocabulary and the row does not
// carry it. Recording it here does not apply it. Editing the shipped catalog changes what every
// consumer of the annotation table reads, so it belongs in a change reviewable as one — alongside
// the graduation of these codes to `blocking` — not as a side effect of taking the measurement.
// What the row buys is that the repair becomes a decided one-line edit instead of a rediscovery.

/** How a measured disagreement was answered for. */
export type DisagreementClassification = 'genuine-mismatch' | 'annotation-error';

/**
 * The four sides that identify ONE measured disagreement — the same four
 * {@link EMISSION_PROVIDER_MISMATCH_CODE} reports, renamed only where the diagnostic's field name
 * (`eventType`, `provider`) would read ambiguously next to `declaringTool`.
 */
export interface DisagreementIdentity {
  /** The event both sides are talking about. */
  readonly event: string;
  /** The action carrying the emission declaration. */
  readonly action: string;
  /** The provider the event's `capability` registration declares. */
  readonly declaredProvider: string;
  /** The composite tool that action is registered under. */
  readonly declaringTool: string;
}

/** The mismatch arm of the diagnostic union, named so callers can project it without re-`Extract`ing. */
export type ProviderDisagreement = Extract<
  WeldResolutionDiagnostic,
  { code: typeof EMISSION_PROVIDER_MISMATCH_CODE }
>;

/**
 * One row of the ledger: a measured disagreement, what it turned out to be, and why.
 *
 * `rationale` is a required field rather than an optional comment because the whole value of this
 * table is the reasoning. A row that recorded only a classification would let "somebody decided"
 * stand in for "somebody worked it out", which is the state this ledger exists to end.
 */
export interface DisagreementDisposition extends DisagreementIdentity {
  readonly classification: DisagreementClassification;
  readonly rationale: string;
}

/**
 * Why the five gate actions' `admission.evidence-recorded` edges are an ANNOTATION ERROR and not a
 * mismatch the vocabulary is unable to express.
 *
 * Shared by all five rows because it is one fact about one event, not five findings: the five
 * actions differ only in which gate they run, and the emission they declare is minted by the same
 * call in the same module for every one of them.
 */
const EVIDENCE_RECORDED_RATIONALE =
  'ANNOTATION ERROR. `admission.evidence-recorded` has exactly one permitted emitter and it is a ' +
  'MODULE, not a tool: `verbs/gates/gate-ownership-census.ts` pins the canonical evidence emitter ' +
  'to `verbs/gates/gate-runner.ts` and fails closed (ALTERNATE_EVIDENCE_EMITTER) on any other ' +
  'module that appends the type — and the live census reports no alternate emitter. `verbs/` is ' +
  'the area of exactly one effect provider, `exarchos_orchestrate` (owner `orchestrate-fs`), so ' +
  'the declaring tool is right and the declared `exarchos_workflow` (area `workflow/`) is wrong. ' +
  'Every production caller of that runner sits under `verbs/` too; not one sits under `workflow/`. ' +
  'The decisive point is internal to the catalog: `gate.executed` is appended by the SAME runGate ' +
  'body inside the same durable boundary, is declared on these same five actions in the same ' +
  'autoEmits arrays, and is annotated `exarchos_orchestrate` — where it AGREES. One append site ' +
  'cannot have two owning composite tools, so the two rows cannot both be right. Sibling ' +
  'admission rows emitted from `verbs/` (`admission.rollout-decision`, ' +
  '`admission.enforcement-enabled`) already carry `exarchos_orchestrate` and agree. REMEDY: change ' +
  "this event's `provider` to `exarchos_orchestrate`. Deliberately NOT applied here — it edits the " +
  'shipped catalog every annotation consumer reads, and belongs with the change that graduates ' +
  'these codes out of `observe`.';

/**
 * Why the three task lifecycle edges are a GENUINE mismatch: the id space has no value that would
 * be correct, so agreement could only be bought by making one side assert something false.
 */
const TASK_LIFECYCLE_RATIONALE =
  'GENUINE MISMATCH. All three task lifecycle events are appended by `tasks/tools.ts`, and ' +
  '`tasks/` is claimed by no entry in the effect-provider map and by no filesystem rule in the ' +
  'effect ledger. The id space the comparison ranges over therefore cannot name the truth: ' +
  '`exarchos_workflow` is area `workflow/`, `exarchos_orchestrate` is area `verbs/`, and the ' +
  'append is in neither. Each side is honest about a different fact — `verbs/composite.ts` is ' +
  'genuinely the composite router that reaches the handler, and the annotation genuinely names the ' +
  'workflow-state authority these events feed and that folds them. Neither is a transcription slip ' +
  'and there is no third value to repair to. Adopting the declaring tool would buy agreement by ' +
  'making the annotation assert an append site that does not exist, which is the comparison ' +
  'agreeing with itself rather than with the tree. Closing this means giving `tasks/` an owner in ' +
  'the effect ledger and a provider entry, or relocating the append into an area that already has ' +
  'one — a change to the ownership model, not to a row in a table. Until then, the comparison ' +
  'naming both sides IS the correct report.';

/**
 * **The measured break set.** Every disagreement the provider comparison reports on the live
 * catalog, with a disposition apiece.
 *
 * Measured, not designed: the rows below were read off the comparison's own output over the shipped
 * annotation table and the shipped tool registry. {@link auditDisagreementDispositions} re-derives
 * that output on every run and reconciles it against this table in both directions, so the ledger
 * cannot drift from what the gate actually reports — in either direction.
 */
export const PROVIDER_DISAGREEMENT_DISPOSITIONS: readonly DisagreementDisposition[] = Object.freeze([
  {
    event: 'admission.evidence-recorded',
    action: 'check_contract_drift',
    declaredProvider: 'exarchos_workflow',
    declaringTool: 'exarchos_orchestrate',
    classification: 'annotation-error',
    rationale: EVIDENCE_RECORDED_RATIONALE,
  },
  {
    event: 'admission.evidence-recorded',
    action: 'check_integration_suite',
    declaredProvider: 'exarchos_workflow',
    declaringTool: 'exarchos_orchestrate',
    classification: 'annotation-error',
    rationale: EVIDENCE_RECORDED_RATIONALE,
  },
  {
    event: 'admission.evidence-recorded',
    action: 'check_mock_boundary',
    declaredProvider: 'exarchos_workflow',
    declaringTool: 'exarchos_orchestrate',
    classification: 'annotation-error',
    rationale: EVIDENCE_RECORDED_RATIONALE,
  },
  {
    event: 'admission.evidence-recorded',
    action: 'check_static_analysis',
    declaredProvider: 'exarchos_workflow',
    declaringTool: 'exarchos_orchestrate',
    classification: 'annotation-error',
    rationale: EVIDENCE_RECORDED_RATIONALE,
  },
  {
    event: 'admission.evidence-recorded',
    action: 'check_test_adequacy',
    declaredProvider: 'exarchos_workflow',
    declaringTool: 'exarchos_orchestrate',
    classification: 'annotation-error',
    rationale: EVIDENCE_RECORDED_RATIONALE,
  },
  {
    event: 'task.claimed',
    action: 'task_claim',
    declaredProvider: 'exarchos_workflow',
    declaringTool: 'exarchos_orchestrate',
    classification: 'genuine-mismatch',
    rationale: TASK_LIFECYCLE_RATIONALE,
  },
  {
    event: 'task.completed',
    action: 'task_complete',
    declaredProvider: 'exarchos_workflow',
    declaringTool: 'exarchos_orchestrate',
    classification: 'genuine-mismatch',
    rationale: TASK_LIFECYCLE_RATIONALE,
  },
  {
    event: 'task.failed',
    action: 'task_fail',
    declaredProvider: 'exarchos_workflow',
    declaringTool: 'exarchos_orchestrate',
    classification: 'genuine-mismatch',
    rationale: TASK_LIFECYCLE_RATIONALE,
  },
]);

/** A fault in the reconciliation between the reported break set and the ledger. */
export type DispositionDiagnostic =
  | {
      readonly code: 'UNDISPOSITIONED_DISAGREEMENT';
      readonly identity: DisagreementIdentity;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_DISPOSITION';
      readonly identity: DisagreementIdentity;
      readonly message: string;
    };

/** The reconciliation verdict, carrying both populations so neither count is readable alone. */
export interface DispositionAuditResult {
  /** Every reported disagreement is answered for, and every row still answers for something. */
  readonly ok: boolean;
  /** Disagreements the comparison reported — the denominator, derived from the live gate. */
  readonly reportedCount: number;
  /** Rows in the ledger. */
  readonly dispositionedCount: number;
  readonly diagnostics: readonly DispositionDiagnostic[];
}

/**
 * The ledger key for one disagreement: all FOUR sides, encoded as a JSON tuple.
 *
 * JSON rather than a joined string because the encoding is injective for free — two different
 * tuples cannot produce the same text, with no claim to defend about which characters a field can
 * contain. Keying on fewer than four sides is the failure this guards: one row would then answer
 * for edges nobody reasoned about.
 */
const identityKey = (identity: DisagreementIdentity): string =>
  JSON.stringify([
    identity.event,
    identity.action,
    identity.declaredProvider,
    identity.declaringTool,
  ]);

/**
 * The identity of one reported disagreement.
 *
 * This is the ONLY place a diagnostic is turned into a ledger key, which is what keeps the two in
 * step without a second proof: drop a field from the mismatch arm and this function stops
 * compiling, rather than the ledger quietly starting to match on three sides.
 */
export function disagreementIdentityOf(diagnostic: ProviderDisagreement): DisagreementIdentity {
  return {
    event: diagnostic.eventType,
    action: diagnostic.action,
    declaredProvider: diagnostic.provider,
    declaringTool: diagnostic.declaringTool,
  };
}

/**
 * The disagreements a verdict reports, as identities. Sorted, so the ledger can be read in the same
 * order the gate produces.
 */
export function reportedDisagreements(
  verdict: WeldResolutionVerdict = validateRegistrationWelds(),
): readonly DisagreementIdentity[] {
  const identities = verdict.diagnostics
    .filter((d): d is ProviderDisagreement => d.code === EMISSION_PROVIDER_MISMATCH_CODE)
    .map(disagreementIdentityOf);
  return Object.freeze(identities.sort((a, b) => byString(identityKey(a), identityKey(b))));
}

/**
 * Reconcile the reported break set against the ledger, in BOTH directions. Pure and total: returns
 * a verdict, never throws.
 *
 * Both populations are parameters with live defaults, for the same reason every population in this
 * module is: a reconciliation that could only ever read one hard-wired input could not be shown to
 * be capable of reporting anything, and the arm that matters here is the one that fires on an input
 * the shipped tree does not currently produce.
 */
export function auditDisagreementDispositions(
  reported: readonly DisagreementIdentity[] = reportedDisagreements(),
  dispositions: readonly DisagreementDisposition[] = PROVIDER_DISAGREEMENT_DISPOSITIONS,
): DispositionAuditResult {
  const diagnostics: DispositionDiagnostic[] = [];
  const dispositioned = new Set(dispositions.map(identityKey));
  const reportedKeys = new Set(reported.map(identityKey));

  for (const identity of reported) {
    if (dispositioned.has(identityKey(identity))) continue;
    diagnostics.push({
      code: 'UNDISPOSITIONED_DISAGREEMENT',
      identity,
      message:
        `action '${identity.action}' on composite tool '${identity.declaringTool}' declares it ` +
        `emits '${identity.event}', which is registered with provider ` +
        `'${identity.declaredProvider}' — and no row of the disposition ledger answers for it. ` +
        'Work out which side is wrong and record it: `genuine-mismatch` when the provider ' +
        'vocabulary has no value that would be correct (so the comparison naming both sides is the ' +
        'right report), `annotation-error` when a correct value exists and the annotation does not ' +
        'carry it. An observe-severity finding nobody has answered for is the state this ledger ' +
        'exists to prevent.',
    });
  }

  for (const row of dispositions) {
    if (reportedKeys.has(identityKey(row))) continue;
    diagnostics.push({
      code: 'STALE_DISPOSITION',
      identity: {
        event: row.event,
        action: row.action,
        declaredProvider: row.declaredProvider,
        declaringTool: row.declaringTool,
      },
      message:
        `the ledger dispositions a disagreement on '${row.event}' from action '${row.action}' ` +
        `('${row.declaredProvider}' vs '${row.declaringTool}') that the comparison no longer ` +
        'reports. The reasoning was about one measured fact and that fact is gone — the annotation ' +
        'was repaired, the emission moved, or the event left the capability arm. Delete the row: a ' +
        'disposition that outlives its subject is a claim about the tree the tree does not support.',
    });
  }

  // Code first, then identity — the same two-level ordering `declaredEmissionEdges` uses, so a
  // reader scanning a failure sees the undispositioned entries as one block rather than
  // interleaved with the stale rows.
  const sorted = [...diagnostics].sort(
    (a, b) =>
      byString(a.code, b.code) ||
      byString(identityKey(a.identity), identityKey(b.identity)),
  );
  return {
    ok: sorted.length === 0,
    reportedCount: reported.length,
    dispositionedCount: dispositions.length,
    diagnostics: Object.freeze(sorted),
  };
}

// ─── The stale-cover break set, and its disposition ─────────────────────────
//
// {@link STALE_CAPABILITY_COVER_CODE} ships at `observe` for the same reason the provider
// comparison does, and it carries the same obligation: the concession is defensible only while
// every finding it reports has been looked at and written down. So the stale-cover break set gets
// its own LEDGER and its own two-way ratchet ({@link auditStaleCoverDispositions}), built to the
// shape the provider ledger already established rather than to a second one:
//
//   • UNDISPOSITIONED_STALE_COVER — the tooth reports an active weld no row answers for. This is
//     the arm carrying the weight. A newly-stale weld — an action that stops declaring the
//     emission, an annotation flipped to `active` ahead of its emitter — REDDENS instead of
//     joining the observed pile.
//   • OBSOLETE_STALE_COVER_DISPOSITION — a row answers for a weld the tooth no longer reports.
//     The reasoning was about one measured fact; once an emission edge names the event, or the
//     lifecycle stops admitting it, the row is a claim the tree does not support.
//
// The denominator is the tooth's OWN output, never a list typed here.
//
// ## Keyed on three sides, and why the lifecycle is one of them
//
// A stale-cover finding names the event, the provider whose cover it claims, and the lifecycle
// that admitted it — and the row is matched on all three, because all three are what was reasoned
// about. The lifecycle side is the one worth defending: it is `active` on every row today, since
// {@link STALE_COVER_LIFECYCLE_POLICY} admits nothing else. That is exactly what makes it
// load-bearing. Widen the policy so a fourth state is eligible and its welds arrive
// undispositioned rather than inheriting an answer written about `active` ones; correct an
// annotation to `planned` and the row goes obsolete rather than silently answering for nothing.
//
// ## The two classifications, and why the distinction is not a matter of taste
//
// `unmodelled-emitter` is NOT "we decided to live with it". An emission edge is an `autoEmits`
// entry on a `ToolAction`, so an edge can only exist where an ACTION's own effect includes the
// append. Several of the welds below are appended by machinery the tool registry does not model
// as an action at all — the dispatch wrapper that runs around every action, a hook installed at
// process wiring, a supervisor's teardown path, a write surface reserved to a typed handler, an
// evaluation harness outside `src/`. There is no action whose effect this is, so there is no edge
// to declare, and the tooth naming the weld is the intended report rather than a defect awaiting
// repair. Closing one of these means giving the emission vocabulary a non-action arm — a change
// to what an emission edge IS, not a row in an array.
//
// `undeclared-emission` is the opposite: an action's own handler performs the append and its
// `autoEmits` array does not list it. A correct declaration exists and the registry does not carry
// it. Recording it here does NOT apply it, for the reason the provider ledger gives: adding edges
// changes what every consumer of the tool registry reads, and two of the repairs below would
// surface a provider disagreement the moment they landed. That belongs in a change reviewable as
// one, alongside the graduation of these codes out of `observe`. What the row buys is that the
// repair becomes a decided edit instead of a rediscovery.

/** How an active weld that no emission edge names was answered for. */
export type StaleCoverClassification = 'unmodelled-emitter' | 'undeclared-emission';

/**
 * The three sides that identify ONE reported stale cover — the same three
 * {@link STALE_CAPABILITY_COVER_CODE} reports, renamed only where the diagnostic's field name
 * (`eventType`, `provider`) would read ambiguously in a ledger row.
 */
export interface StaleCoverIdentity {
  /** The event whose registration claims cover nothing declares it emits. */
  readonly event: string;
  /** The provider the event's `capability` registration declares. */
  readonly declaredProvider: string;
  /** The lifecycle that admitted the weld to the stale-cover population. */
  readonly lifecycle: EventLifecycle;
}

/** The stale-cover arm of the diagnostic union, named so callers can project it without re-`Extract`ing. */
export type StaleCoverFinding = Extract<
  WeldResolutionDiagnostic,
  { code: typeof STALE_CAPABILITY_COVER_CODE }
>;

/**
 * One row of the ledger: a measured stale cover, WHERE the event is actually appended, what that
 * makes it, and why.
 *
 * `appendSite` is a required field of its own rather than a sentence inside {@link rationale},
 * because it is the evidence the classification rests on and the only part of the row a reader can
 * check against the tree in one step. A row that named a classification without it would record a
 * verdict with the measurement left out.
 */
export interface StaleCoverDisposition extends StaleCoverIdentity {
  readonly classification: StaleCoverClassification;
  /**
   * The module that performs the append, and the action that reaches it where one does. Repo
   * relative, so it is followable; a move that invalidates it is a documentation defect in this
   * row rather than a matching failure, since the reconciliation keys on the identity and never on
   * this field.
   */
  readonly appendSite: string;
  readonly rationale: string;
}

/**
 * Why the three per-dispatch telemetry rows have no declaring action: their append is the DISPATCH
 * WRAPPER's, and it runs around every action rather than inside any one of them.
 */
const TELEMETRY_MIDDLEWARE_RATIONALE =
  'UNMODELLED EMITTER. `projections/telemetry/middleware.ts` wraps the handler for EVERY action ' +
  'and appends these rows to the singleton telemetry stream from that wrapper — after the handler ' +
  'returns, keyed by the tool name it was invoked with, and swallowing its own failures so a ' +
  'telemetry drop can never fail a workflow. The append is therefore the wrapper effect, not any ' +
  "action's effect: no single action performs it, and declaring it on all of them would assert " +
  'that every action in the registry independently emits the telemetry row, which is false in ' +
  'every case and would put a hundred-odd edges into the comparison naming one append site. The ' +
  'sibling row minted by the same wrapper, `quality.hint.generated`, IS declared on one action, ' +
  'which is the same defect from the other side and out of scope here. Closing this means giving ' +
  'the emission vocabulary a way to say "the dispatch layer emits this", which is a change to what ' +
  'an emission edge is.';

/**
 * Why the two live-shadow evidence rows have no declaring action: the observer that appends them
 * is installed at process wiring and drains on its own settlement chain.
 */
const LIVE_SHADOW_OBSERVER_RATIONALE =
  'UNMODELLED EMITTER. `workflow/admission/live-shadow-observer.ts` appends these on the observer ' +
  'sink drain, from a target installed when the process is wired rather than from a dispatched ' +
  'action. The events record what the shadow evaluation OBSERVED about a transition somebody else ' +
  'performed, so there is no action whose effect they are — the action that triggered the ' +
  'transition did not emit them, and the observer is not an action. The reserved write surface ' +
  'confirms the same reading from the other side: `registry/gate-metadata.ts` holds both types in ' +
  'the reserved append registry, so `exarchos_event.append` REFUSES a caller-minted one and points ' +
  'at a typed handler that is not registered as an action either.';

/**
 * Why both halves of the prune liveness pair are undeclared rather than unmodelled: one action
 * drives the whole pass, and it declares two other events from the same handler.
 */
const PRUNE_PAIR_RATIONALE =
  'UNDECLARED EMISSION. `verbs/worktree/manager.ts` appends the pair from `WorktreeManager.prune()` ' +
  '— the start before the safety ladder runs and the terminal in a `finally`, so a throw mid-pass ' +
  'still closes the pair exactly once. That method has exactly one caller, `handlePruneWorktrees`, ' +
  'which IS the `prune_worktrees` action, and that action already declares the two ' +
  '`worktree.remove.*` events appended deeper in the same ladder. So the effect is the action’s ' +
  'and the declaration is simply missing. REMEDY: add both to the `prune_worktrees` autoEmits ' +
  'array. Deliberately NOT applied here — it widens the emission population every consumer of the ' +
  'tool registry reads, and belongs with the change that graduates this code out of `observe`.';

/**
 * Why the two unnamed shepherd-loop rows are undeclared: one handler appends all six, and four of
 * them are already declared on its action.
 */
const ASSESS_STACK_RATIONALE =
  'UNDECLARED EMISSION. `verbs/vcs/assess-stack.ts` appends this from `handleAssessStack`, which ' +
  'IS the `assess_stack` action. The decisive point is internal to that one handler: it appends ' +
  'six event types and the action declares four of them (`shepherd.started`, ' +
  '`shepherd.approval_requested`, `shepherd.completed`, `gate.executed`), all from the same body ' +
  'and the same dispatch. One handler cannot be the emitter of four of its appends and not of the ' +
  'other two, so the autoEmits array is incomplete rather than the emission being unmodelled. ' +
  'REMEDY: add it to the `assess_stack` autoEmits array. Deliberately NOT applied here, for the ' +
  'reason every remedy in this ledger is recorded rather than applied.';

/**
 * **The measured break set.** Every stale cover the tooth reports on the live catalog, with a
 * disposition apiece.
 *
 * Measured, not designed: the rows below were read off the tooth's own output over the shipped
 * annotation table and the shipped tool registry, and every `appendSite` was resolved by following
 * the append to the handler that reaches it. Three welds the same measurement found are NOT here,
 * because they were not dispositioned — `stack.restacked`, `turn.completed` and
 * `benchmark.completed` have no emitter anywhere in the tree, so their annotations were corrected
 * to `planned` and the lifecycle axis excludes them. A disposition is for a weld that is genuinely
 * active and genuinely unnamed; an annotation that claimed an append nothing performs is a wrong
 * annotation, and answering for it here would have preserved the wrong claim behind a rationale.
 */
export const STALE_COVER_DISPOSITIONS: readonly StaleCoverDisposition[] = Object.freeze([
  {
    event: 'admission.cutover-ready',
    declaredProvider: 'exarchos_workflow',
    lifecycle: 'active',
    classification: 'unmodelled-emitter',
    appendSite: 'src/workflow/admission/cutover-auto-export.ts (durable-append success hook)',
    rationale:
      'UNMODELLED EMITTER. The append runs inside `maybeExportCutoverReadiness`, a durable-append ' +
      'SUCCESS HOOK configured by `dispatch/core/context.ts::initializeContext` and fired from the ' +
      "shadow observer's settlement chain. Its trigger is another event landing, not an action " +
      'being dispatched, and it is single-flight and self-suppressing once it has exported — so ' +
      'no action invocation reliably produces it and none of them owns it. The sibling actions ' +
      '`cutover_readiness` and `cutover_decide` are the nearest candidates and neither appends ' +
      'this type: the first only reads the readiness report, and the second appends the two ' +
      'rollout events it already declares.',
  },
  {
    event: 'admission.disagreement-disposition',
    declaredProvider: 'exarchos_workflow',
    lifecycle: 'active',
    classification: 'unmodelled-emitter',
    appendSite:
      'src/workflow/admission/live-shadow-observer.ts (observer sink drain); ' +
      'src/events/tools.ts::handleAdmissionDisagreementDisposition (reserved typed handler)',
    rationale: LIVE_SHADOW_OBSERVER_RATIONALE,
  },
  {
    event: 'admission.shadow-attempt',
    declaredProvider: 'exarchos_workflow',
    lifecycle: 'active',
    classification: 'unmodelled-emitter',
    appendSite: 'src/workflow/admission/live-shadow-observer.ts (observer sink drain)',
    rationale: LIVE_SHADOW_OBSERVER_RATIONALE,
  },
  {
    event: 'ci.status',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite: 'src/verbs/vcs/assess-stack.ts::emitCiStatusEvents, via handleAssessStack (assess_stack)',
    rationale: ASSESS_STACK_RATIONALE,
  },
  {
    event: 'eval.judge.calibrated',
    declaredProvider: 'exarchos_view',
    lifecycle: 'active',
    classification: 'unmodelled-emitter',
    appendSite: 'tools/evals/evals/harness.ts (the evaluation harness, outside src/)',
    rationale:
      'UNMODELLED EMITTER. The only append is in the evaluation harness under `tools/`, which is a ' +
      'developer entry point run from the command line over a suite of graded cases — not a ' +
      'composite tool and not reachable through dispatch. Every `exarchos_view` action is a read ' +
      'of a projection, `eval_results` included, so there is no action on the declared provider ' +
      'that could carry the edge without asserting that reading the view emits the calibration. ' +
      'The registration itself is right: the harness genuinely appends the event and ' +
      '`eval-results` genuinely folds it. Closing this means either modelling the harness as a ' +
      'declaring surface or moving the append behind an action, and both are larger than a row.',
  },
  {
    event: 'launch.executed',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite:
      'src/runtime/launcher/liveness.ts::emitLaunchExecuted, reached from the launcher teardown ' +
      'and signal paths AND from handleViewPs (exarchos_view.ps with probe:true, via ' +
      'src/runtime/launcher/launch-reconcile.ts::reconcileLaunches)',
    rationale:
      'UNDECLARED EMISSION, and the asymmetry with its own START is the finding. Every catchable ' +
      'launcher exit funnels through one idempotent terminal seam, and the launcher supervisor is ' +
      'not an action — but that seam has a SECOND caller that is: the phantom-launch reconciler, ' +
      'which `ps` runs when the caller passes `probe: true` and which heals an in-flight launch ' +
      'whose supervisor is provably dead by appending exactly this terminal. So an action does ' +
      'perform the append, on a condition an `AutoEmission` can carry. REMEDY: declare it on ' +
      '`exarchos_view.ps` under the probe condition. Note what that surfaces and why it is not ' +
      'applied here: the declaring tool would be `exarchos_view` while this registration declares ' +
      '`exarchos_orchestrate`, so the edge lands as a provider disagreement the moment it exists. ' +
      'Both halves belong in the same reviewed change, not in the one that takes the measurement.',
  },
  {
    event: 'launch.executing_started',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'unmodelled-emitter',
    appendSite:
      'src/runtime/launcher/liveness.ts::emitLaunchExecutingStarted, from the launcher ' +
      'supervisor (src/runtime/launcher/lifecycle-core.ts)',
    rationale:
      'UNMODELLED EMITTER, and the honest half of a pair whose terminal is not. The claim is ' +
      'appended by the launcher supervisor as it starts a session, which is a long-lived process ' +
      'the runtime spawns — reached from the launcher verb, never from a dispatched action. ' +
      'Nothing reconciles a START into existence the way the phantom-launch reconciler does for ' +
      'the terminal, so unlike `launch.executed` there is no action-borne caller to declare it on. ' +
      'Closing this means modelling the launcher supervisor as a declaring surface.',
  },
  {
    event: 'merge.completed',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite: 'src/verbs/merge/execute-merge.ts, via handleMergeOrchestrate (merge_orchestrate)',
    rationale:
      'UNDECLARED EMISSION. The executor appends the terminal after it wins the `merge.executed` ' +
      'compare-and-set, inside a retry that re-reads the advanced tail; the git merge itself is ' +
      'never re-run. It is driven by `handleMergeOrchestrate`, which IS the `merge_orchestrate` ' +
      'action, and that action already declares the other three merge events — `merge.preflight`, ' +
      '`merge.executed` and `merge.recovered` — from the same handler. Three of four declared and ' +
      'the terminal missing is an incomplete array, not an unmodelled emitter. REMEDY: add ' +
      '`merge.completed` to the `merge_orchestrate` autoEmits array.',
  },
  {
    event: 'prune.executed',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite:
      'src/verbs/worktree/manager.ts::appendPruneExecuted (the prune finally), via ' +
      'handlePruneWorktrees (prune_worktrees)',
    rationale: PRUNE_PAIR_RATIONALE,
  },
  {
    event: 'prune.executing_started',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite:
      'src/verbs/worktree/manager.ts::appendPruneStarted (before the safety ladder), via ' +
      'handlePruneWorktrees (prune_worktrees)',
    rationale: PRUNE_PAIR_RATIONALE,
  },
  {
    event: 'review.routed',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite: 'src/review/tools.ts::emitRoutedEvents, via handleReviewTriage (review_triage)',
    rationale:
      'UNDECLARED EMISSION. `handleReviewTriage` computes a routing decision per pull request and ' +
      'appends one row apiece, idempotency-keyed on the pull request number — the append is the ' +
      "action's whole point, and `review_triage` is the action. It declares no emissions at all " +
      'today, so this is an empty array rather than an incomplete one, which is the easier case: ' +
      'nothing has to be reconciled with a sibling declaration. The downstream reader confirms the ' +
      'reading — `verbs/review/verify-review-triage.ts` queries the stream for exactly these rows ' +
      'to verify that the triage ran. REMEDY: add `review.routed` to the `review_triage` autoEmits ' +
      'array.',
  },
  {
    event: 'shepherd.escalated',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite:
      'src/verbs/vcs/assess-stack.ts::emitShepherdEscalated, via handleAssessStack (assess_stack)',
    rationale: ASSESS_STACK_RATIONALE,
  },
  {
    event: 'stack.position-filled',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite: 'src/stack/tools.ts, via the stack_place action on exarchos_view',
    rationale:
      'UNDECLARED EMISSION. The `stack_place` handler validates a position and appends this row; ' +
      'recording the position IS the action, and it is annotated a local mutation rather than a ' +
      'read, so nothing about the surface disguises the effect. REMEDY: add it to the ' +
      '`stack_place` autoEmits array. Note what that surfaces, and why it is recorded rather than ' +
      'applied: `stack_place` is registered on `exarchos_view` while this registration declares ' +
      '`exarchos_orchestrate`, so the new edge arrives as a provider disagreement and one of the ' +
      'two sides needs deciding in the same change — either the mutation belongs on the ' +
      'orchestrate surface, or the registration names the wrong provider. That is a placement ' +
      'question about a shipped action, not a row in a table.',
  },
  {
    event: 'subagent.tokens_used',
    declaredProvider: 'exarchos_event',
    lifecycle: 'active',
    classification: 'unmodelled-emitter',
    appendSite: 'src/lifecycle/subagent-stop.ts (the subagent-stop hook handler)',
    rationale:
      'UNMODELLED EMITTER. The append is performed by the subagent-stop hook handler, which reads ' +
      "the finished subagent's transcript, resolves the teammate by matching its working directory " +
      'against a worktree reservation, and appends the usage atom to the resolved feature stream. ' +
      'The harness fires the hook when a subagent stops; no action is dispatched, and the append ' +
      'is fail-open at every step, so a run that resolves no teammate emits nothing at all. The ' +
      'annotation is already explicit that the hook is the TRIGGER and exarchos code is the ' +
      'author, which is why the registration derives an automatic source — that reading is ' +
      'unaffected. What is missing is an action, and there is none to add.',
  },
  {
    event: 'tool.action_errored',
    declaredProvider: 'exarchos_event',
    lifecycle: 'active',
    classification: 'unmodelled-emitter',
    appendSite: 'src/projections/telemetry/middleware.ts (the dispatch telemetry wrapper)',
    rationale: TELEMETRY_MIDDLEWARE_RATIONALE,
  },
  {
    event: 'tool.completed',
    declaredProvider: 'exarchos_event',
    lifecycle: 'active',
    classification: 'unmodelled-emitter',
    appendSite: 'src/projections/telemetry/middleware.ts (the dispatch telemetry wrapper)',
    rationale: TELEMETRY_MIDDLEWARE_RATIONALE,
  },
  {
    event: 'tool.errored',
    declaredProvider: 'exarchos_event',
    lifecycle: 'active',
    classification: 'unmodelled-emitter',
    appendSite: 'src/projections/telemetry/middleware.ts (the dispatch telemetry wrapper)',
    rationale: TELEMETRY_MIDDLEWARE_RATIONALE,
  },
  {
    event: 'workflow.fix-cycle',
    declaredProvider: 'exarchos_workflow',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite:
      'src/workflow/hsm-transition-guard.ts, via handleTransition (exarchos_workflow.transition)',
    rationale:
      'UNDECLARED EMISSION. The transition guard is the authoritative decider for a phase move and ' +
      'it appends this row when the move re-enters a phase, folding in a one-based ordinal counted ' +
      'from the prior rows on the stream. Its callers are the transition handler, cancel and ' +
      'cleanup — and the transition handler IS the `transition` action, which already declares ' +
      '`workflow.transition` from the same guard invocation. One guard call cannot be the emitter ' +
      'of the transition row and not of the fix-cycle row it appends beside it. REMEDY: add ' +
      '`workflow.fix-cycle` to the `transition` autoEmits array, under the re-entry condition.',
  },
  {
    event: 'worktree.orphan_detected',
    declaredProvider: 'exarchos_orchestrate',
    lifecycle: 'active',
    classification: 'undeclared-emission',
    appendSite:
      'src/verbs/worktree/manager.ts::appendLifecycle, from probeAndReclaim, via handleViewPs ' +
      '(exarchos_view.ps with probe:true)',
    rationale:
      'UNDECLARED EMISSION. One private method appends both reclaim terminals from the ' +
      'ground-truth probe: `worktree.released` when the owner is provably dead and the path is ' +
      'free, this one when the owner is provably dead and a live foreign process still occupies ' +
      'it. The probe runs on demand from `ps` when the caller passes `probe: true`, so an action ' +
      'does reach the append, on a condition an `AutoEmission` can carry. Its sibling terminal is ' +
      'already declared — on `release_worktree`, which reaches the OTHER append site — so the ' +
      'registry today names one of the two reclaim outcomes and not the other. REMEDY: declare ' +
      'it on `exarchos_view.ps` under the probe condition, accepting the same provider question ' +
      '`launch.executed` raises from the same handler.',
  },
]);

/** A fault in the reconciliation between the reported stale-cover set and the ledger. */
export type StaleCoverDispositionDiagnostic =
  | {
      readonly code: 'UNDISPOSITIONED_STALE_COVER';
      readonly identity: StaleCoverIdentity;
      readonly message: string;
    }
  | {
      readonly code: 'OBSOLETE_STALE_COVER_DISPOSITION';
      readonly identity: StaleCoverIdentity;
      readonly message: string;
    };

/** The reconciliation verdict, carrying both populations so neither count is readable alone. */
export interface StaleCoverAuditResult {
  /** Every reported stale cover is answered for, and every row still answers for something. */
  readonly ok: boolean;
  /** Stale covers the tooth reported — the denominator, derived from the live gate. */
  readonly reportedCount: number;
  /** Rows in the ledger. */
  readonly dispositionedCount: number;
  readonly diagnostics: readonly StaleCoverDispositionDiagnostic[];
}

/**
 * The ledger key for one stale cover: all THREE sides, encoded as a JSON tuple.
 *
 * JSON for the reason the provider ledger uses it — the encoding is injective for free, with no
 * claim to defend about which characters a field can contain. Keying on fewer than three sides is
 * the failure this guards: keyed on the event alone, a row written about an `active` weld would go
 * on answering for the same event after a lifecycle widening put it in the population for an
 * entirely different reason.
 */
const staleCoverKey = (identity: StaleCoverIdentity): string =>
  JSON.stringify([identity.event, identity.declaredProvider, identity.lifecycle]);

/**
 * The identity of one reported stale cover.
 *
 * This is the ONLY place a diagnostic is turned into a ledger key, which is what keeps the two in
 * step without a second proof: drop a field from the stale-cover arm and this function stops
 * compiling, rather than the ledger quietly starting to match on two sides.
 */
export function staleCoverIdentityOf(diagnostic: StaleCoverFinding): StaleCoverIdentity {
  return {
    event: diagnostic.eventType,
    declaredProvider: diagnostic.provider,
    lifecycle: diagnostic.lifecycle,
  };
}

/**
 * The stale covers a verdict reports, as identities. Sorted, so the ledger can be read in the same
 * order the gate produces.
 */
export function reportedStaleCover(
  verdict: WeldResolutionVerdict = validateRegistrationWelds(),
): readonly StaleCoverIdentity[] {
  const identities = verdict.diagnostics
    .filter((d): d is StaleCoverFinding => d.code === STALE_CAPABILITY_COVER_CODE)
    .map(staleCoverIdentityOf);
  return Object.freeze(identities.sort((a, b) => byString(staleCoverKey(a), staleCoverKey(b))));
}

/**
 * Reconcile the reported stale-cover set against the ledger, in BOTH directions. Pure and total:
 * returns a verdict, never throws.
 *
 * Both populations are parameters with live defaults, for the reason every population in this
 * module is one: a reconciliation that could only ever read one hard-wired input could not be
 * shown to be capable of reporting anything, and the arm that matters here is the one that fires
 * on an input the shipped tree does not currently produce.
 */
export function auditStaleCoverDispositions(
  reported: readonly StaleCoverIdentity[] = reportedStaleCover(),
  dispositions: readonly StaleCoverDisposition[] = STALE_COVER_DISPOSITIONS,
): StaleCoverAuditResult {
  const diagnostics: StaleCoverDispositionDiagnostic[] = [];
  const dispositioned = new Set(dispositions.map(staleCoverKey));
  const reportedKeys = new Set(reported.map(staleCoverKey));

  for (const identity of reported) {
    if (dispositioned.has(staleCoverKey(identity))) continue;
    diagnostics.push({
      code: 'UNDISPOSITIONED_STALE_COVER',
      identity,
      message:
        `event '${identity.event}' is registered tier 'capability' with provider ` +
        `'${identity.declaredProvider}' and lifecycle '${identity.lifecycle}', no action in the ` +
        'tool registry declares that it emits it, and no row of the stale-cover ledger answers ' +
        'for it. Follow the append to the module that performs it and record what you find: ' +
        "`undeclared-emission` when an action's own handler reaches the append and its autoEmits " +
        'array does not list it (a correct declaration exists), `unmodelled-emitter` when the ' +
        'append belongs to machinery the registry does not model as an action at all — the ' +
        'dispatch wrapper, a hook, a supervisor, a reserved write surface — so there is no edge ' +
        'to declare. If NEITHER fits because nothing in the tree appends the event, the ' +
        "annotation is wrong rather than uncovered: correct the registration's lifecycle instead " +
        'of adding a row here. An observe-severity finding nobody has answered for is the state ' +
        'this ledger exists to prevent.',
    });
  }

  for (const row of dispositions) {
    if (reportedKeys.has(staleCoverKey(row))) continue;
    diagnostics.push({
      code: 'OBSOLETE_STALE_COVER_DISPOSITION',
      identity: {
        event: row.event,
        declaredProvider: row.declaredProvider,
        lifecycle: row.lifecycle,
      },
      message:
        `the ledger dispositions a stale cover on '${row.event}' (provider ` +
        `'${row.declaredProvider}', lifecycle '${row.lifecycle}') that the gate no longer ` +
        'reports. The reasoning was about one measured fact and that fact is gone — an action now ' +
        'declares the emission, the annotation moved to a lifecycle the check excludes, the ' +
        'provider changed, or the event left the capability arm. Delete the row: a disposition ' +
        'that outlives its subject is a claim about the tree the tree does not support.',
    });
  }

  // Code first, then identity — the same two-level ordering the provider ledger uses, so a reader
  // scanning a failure sees the undispositioned entries as one block rather than interleaved with
  // the obsolete rows.
  const sorted = [...diagnostics].sort(
    (a, b) =>
      byString(a.code, b.code) ||
      byString(staleCoverKey(a.identity), staleCoverKey(b.identity)),
  );
  return {
    ok: sorted.length === 0,
    reportedCount: reported.length,
    dispositionedCount: dispositions.length,
    diagnostics: Object.freeze(sorted),
  };
}

/**
 * Where an observe-severity finding goes when the gate does not throw.
 *
 * stderr, not stdout: the `exarchos mcp` facade owns stdout for the JSON-RPC stream, so a boot
 * notice written there would corrupt the protocol rather than inform anybody. Injectable for the
 * same reason every population above is — a report nothing can capture cannot be shown to happen.
 */
function reportToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Thrown when a registration's weld does not resolve — refuses process startup. */
export class RegistrationWeldError extends Error {
  override readonly name = 'RegistrationWeldError';
  readonly verdict: WeldResolutionVerdict;
  constructor(verdict: WeldResolutionVerdict) {
    super(verdict.report);
    this.verdict = verdict;
  }
}

/**
 * **The boot gate.** `dispatch/core/context.ts::initializeContext` calls this as its first statement, so a
 * `capability` registration naming an unresolvable `EffectProviderId` halts the process before an
 * EventStore is constructed — on the CLI facade and the `exarchos mcp` facade alike, because both
 * route through `initializeContext` (`index.ts` `main()`).
 *
 * Same shape as `contract/bindings/verify-bindings.ts::assertBindingsAtStartup`, deliberately: a
 * declaration whose reference does not resolve is a startup fault, never a first-call surprise.
 *
 * The refusal is SEVERITY-DRIVEN: only a `blocking` diagnostic throws. An `observe` finding is
 * written to `report` and startup continues, which is what lets a new check be armed against the
 * live tree without taking every entry point down with it. The four reference-integrity codes are
 * `blocking` in {@link DIAGNOSTIC_SEVERITY_POLICY}, so the set of inputs that HALT startup is
 * unchanged by the emission-coupling comparison; that comparison's two codes are `observe`, and on
 * the shipped catalog they produce a boot-channel report rather than a refusal.
 *
 * `emissions` trails `report` rather than sitting beside the other populations. Ordering by kind
 * would have renumbered an argument every existing caller already passes positionally, and a silent
 * re-binding of a severity table onto an emission parameter is a worse cost than one parameter out
 * of thematic order.
 */
export function assertRegistrationWeldsAtStartup(
  annotations: Readonly<Record<string, EventRegistration>> = EVENT_ANNOTATIONS,
  providers: readonly EffectProvider[] = EFFECT_PROVIDERS,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
  policy: Readonly<Record<EventTier, WeldResolutionPolicy>> = WELD_RESOLUTION_POLICY,
  severityPolicy: Readonly<
    Record<WeldDiagnosticCode, WeldDiagnosticSeverity>
  > = DIAGNOSTIC_SEVERITY_POLICY,
  report: (message: string) => void = reportToStderr,
  emissions: readonly EmissionEdge[] = declaredEmissionEdges(),
  lifecyclePolicy: Readonly<
    Record<EventLifecycle, StaleCoverEligibility>
  > = STALE_COVER_LIFECYCLE_POLICY,
): WeldResolutionVerdict {
  const verdict = validateRegistrationWelds(
    annotations,
    providers,
    rules,
    policy,
    severityPolicy,
    emissions,
    lifecyclePolicy,
  );
  if (!verdict.bootable) throw new RegistrationWeldError(verdict);
  // Survivable, but not silent. An observation nobody is told about is indistinguishable from a
  // check that was never run, which is the failure mode the severity arm exists to avoid.
  if (verdict.observeCount > 0) report(verdict.report);
  return verdict;
}

// ─── Compile-time proofs (verified by `npm run typecheck`) ──────────────────
//
// Exported type aliases in a non-test source file, per the `_EventRegistration_*` /
// `_EventAnnotations_*` idiom: `tsconfig.json` excludes `**/*.test.ts`, so the same assertions
// written in the co-located test would never be checked by the build.

type Expect<T extends true> = T;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The vocabulary this gate resolves is the vocabulary the union declares. `EffectProviderId` is
 * `EffectProvider['tool']` by definition, and this pins that the set membership check below is
 * against the SAME id space — not a look-alike.
 *
 * Falsifier: redefine `EffectProviderId` as a closed literal union, a brand, or anything other than
 * the provider map's key, and this alias stops being `true` — which is the moment the runtime
 * lookup would start resolving against a different vocabulary than the one being declared.
 @proof
 * */
export type _RegistrationValidate_ProviderId_IsTheProviderMapKey = Expect<
  MutuallyAssignable<EffectProviderId, EffectProvider['tool']>
>;

/**
 * The capability arm's `provider` field carries exactly that id space — so narrowing on
 * `tier === 'capability'` and resolving `.provider` is resolving the thing the union promises.
 @proof
 * */
export type _RegistrationValidate_CapabilityProvider_IsAProviderId = Expect<
  MutuallyAssignable<CapabilityRegistration['provider'], EffectProviderId>
>;

/**
 * **The scope proof.** `provider` appears on exactly ONE arm of the union, so a policy table that
 * marks only `capability` as boot-resolvable cannot be silently under-covering: were a future arm
 * to gain its own `provider`, this alias goes `false` and the build names it, rather than the gate
 * quietly skipping a second population of provider references.
 @proof
 * */
export type _RegistrationValidate_ProviderField_IsUniqueToTheCapabilityArm = Expect<
  MutuallyAssignable<Extract<EventTierVariant, { provider: unknown }>['tier'], 'capability'>
>;

/**
 * The policy table is TOTAL over the tier axis. `Readonly<Record<EventTier, …>>` already enforces
 * this at the declaration; stating it as a proof makes the intent survive a refactor that widens
 * the annotation to `Partial<…>` or an index signature — either of which would let a sixth tier
 * arrive with no resolution decision and be skipped at boot by omission.
 @proof
 * */
export type _RegistrationValidate_Policy_IsTotalOverTheTierAxis = Expect<
  MutuallyAssignable<keyof typeof WELD_RESOLUTION_POLICY, EventTier>
>;

/**
 * **The severity proof.** EVERY arm of the diagnostic union carries a severity, so no fault can
 * reach the boot decision without one. Drop the field from a single arm and
 * `WeldResolutionDiagnostic['severity']` stops resolving — the build names the arm rather than the
 * gate quietly treating an unstamped diagnostic as harmless (or, worse, as fatal by accident).
 @proof
 * */
export type _RegistrationValidate_EveryDiagnostic_CarriesASeverity = Expect<
  MutuallyAssignable<WeldResolutionDiagnostic['severity'], WeldDiagnosticSeverity>
>;

/**
 * The severity table is TOTAL over the diagnostic axis, mirroring the tier proof above and for the
 * same reason: widen the annotation to `Partial<…>` or an index signature and a new diagnostic
 * could arrive with no severity decision, defaulting into whichever arm the lookup happens to
 * produce. The codes are read off the union, so the two cannot drift apart.
 @proof
 * */
export type _RegistrationValidate_SeverityPolicy_IsTotalOverTheDiagnosticAxis = Expect<
  MutuallyAssignable<keyof typeof DIAGNOSTIC_SEVERITY_POLICY, WeldDiagnosticCode>
>;

/**
 * **The four-sides proof.** A disagreement is only diagnosable if the diagnostic names BOTH sides
 * and where each came from, so the mismatch arm carries the event, the declared provider, the
 * declaring tool and the action — all four, in the one record.
 *
 * Falsifier: drop any one field from the arm and the key set stops matching, so a diagnostic that
 * said only "these disagree" would fail the build rather than ship as a fault an operator has to
 * run the gate a second time to understand.
 @proof
 * */
export type _RegistrationValidate_MismatchDiagnostic_NamesBothSides = Expect<
  MutuallyAssignable<
    keyof Extract<WeldResolutionDiagnostic, { code: typeof EMISSION_PROVIDER_MISMATCH_CODE }>,
    'code' | 'eventType' | 'provider' | 'action' | 'declaringTool' | 'message' | 'severity'
  >
>;

/**
 * **The shortfall proof.** A narrowing is only actionable if the diagnostic carries BOTH numbers —
 * how far the comparison actually reached and how far it was measured to reach. A record naming
 * only one of them would leave a reader to guess the shortfall from prose, or to re-import the
 * constant to work it out.
 *
 * Falsifier: drop `compared` or `floor` from the arm and the key set stops matching, so the build
 * names it rather than shipping a fault an operator cannot size.
 @proof
 * */
export type _RegistrationValidate_NarrowedDiagnostic_CarriesTheShortfall = Expect<
  MutuallyAssignable<
    keyof Extract<WeldResolutionDiagnostic, { code: 'NARROWED_EMISSION_DENOMINATOR' }>,
    'code' | 'eventType' | 'provider' | 'compared' | 'floor' | 'message' | 'severity'
  >
>;

/**
 * The comparison is between two values of ONE id space. `EmissionEdge.declaringTool` is a
 * `CompositeTool['name']` and the other side is an {@link EffectProviderId}, which
 * `_RegistrationValidate_ProviderId_IsTheProviderMapKey` above pins to `EffectProvider['tool']`.
 *
 * Structurally both are `string` today, so this alias is not load-bearing on its own — it is the
 * statement that makes a future BRAND on either side a build failure here, at the equality, rather
 * than a silent always-false comparison that reports the whole catalog as broken.
 @proof
 * */
export type _RegistrationValidate_BothComparedSides_AreCompositeToolIds = Expect<
  MutuallyAssignable<EmissionEdge['declaringTool'], CompositeTool['name']>
>;

/**
 * **The lifecycle-exclusion proof.** The stale-cover policy is TOTAL over the lifecycle axis, the
 * same way the resolution policy is total over the tier axis and the severity policy is total over
 * the diagnostic axis.
 *
 * This is the one that makes the exclusion STRUCTURAL rather than a convention. A fourth lifecycle
 * state — or a widening of this annotation to `Partial<…>` or an index signature — would otherwise
 * let a registration arrive with no eligibility decision and be admitted or skipped by whatever the
 * lookup happened to produce, which is exactly the silent drift a hand-maintained exemption list
 * suffers from and the reason this is a table over the axis at all.
 @proof
 * */
export type _RegistrationValidate_StaleCoverPolicy_IsTotalOverTheLifecycleAxis = Expect<
  MutuallyAssignable<keyof typeof STALE_COVER_LIFECYCLE_POLICY, EventLifecycle>
>;

/**
 * The population the stale-cover check filters is the population the resolution check produced, so
 * the two cannot come to disagree about which registrations are in scope: `staleCoverEligibleWelds`
 * consumes {@link BootResolvedWeld}s and returns them, narrowing on lifecycle and nothing else.
 *
 * Falsifier: give the eligible set its own record shape and this alias stops holding — which is the
 * moment a second walk of the annotation table could start admitting rows the tier policy excluded.
 @proof
 * */
export type _RegistrationValidate_StaleCoverPopulation_IsASubsetOfTheResolvedWelds = Expect<
  MutuallyAssignable<
    ReturnType<typeof staleCoverEligibleWelds>[number],
    ReturnType<typeof bootResolvedWelds>[number]
  >
>;

/**
 * **The stale-cover shape proof.** The finding names the event, the cover it claims, and the
 * lifecycle that admitted it to the population — all three, in the one record.
 *
 * The lifecycle field is the load-bearing one and the reason this proof exists: without it a reader
 * looking at a wall of stale-cover findings cannot tell whether the exclusion axis is working, and
 * would have to re-read the catalog to check that the check was not reporting retired events.
 *
 * Falsifier: drop any of the three and the key set stops matching, so the build names it.
 @proof
 * */
export type _RegistrationValidate_StaleCoverDiagnostic_NamesTheEventAndItsLifecycle = Expect<
  MutuallyAssignable<
    keyof Extract<WeldResolutionDiagnostic, { code: typeof STALE_CAPABILITY_COVER_CODE }>,
    'code' | 'eventType' | 'provider' | 'lifecycle' | 'message' | 'severity'
  >
>;

/**
 * **The disposition-shape proof.** A ledger row is the four sides of one measured disagreement plus
 * the two fields that ARE the decision — and nothing else.
 *
 * Both halves matter. Drop a side and rows start answering for edges nobody looked at: keyed on the
 * event alone, one row would silently disposition all five gate actions the moment a sixth appeared.
 * Add a field the identity does not have and the ledger acquires a key the comparison cannot
 * produce, so the row could never match anything and would report as stale forever.
 *
 * Falsifier: widen or narrow either side and the key sets stop matching, so the build names it.
 @proof
 * */
export type _RegistrationValidate_Disposition_IsTheFourSidesPlusTheDecision = Expect<
  MutuallyAssignable<
    keyof DisagreementDisposition,
    keyof DisagreementIdentity | 'classification' | 'rationale'
  >
>;

/**
 * **The stale-cover disposition-shape proof.** A stale-cover row is the three sides of one measured
 * finding plus the three fields that ARE the decision — the classification, the append site it
 * rests on, and the reasoning — and nothing else.
 *
 * Both halves matter, for the reasons the provider proof gives. Drop a side and rows start
 * answering for findings nobody looked at: keyed on the event alone, a row written about an
 * `active` weld would go on answering after a lifecycle widening admitted the same event for a
 * different reason. Add a field the identity does not have and the ledger acquires a key the gate
 * cannot produce, so the row could never match and would report as obsolete forever.
 *
 * `appendSite` is inside the decision half deliberately: it is evidence, not identity. It is the
 * measurement the classification rests on, and keeping it out of the key is what makes a module
 * move a documentation defect in one row rather than a reconciliation that silently stops matching.
 *
 * Falsifier: widen or narrow either side and the key sets stop matching, so the build names it.
 @proof
 * */
export type _RegistrationValidate_StaleCoverDisposition_IsTheThreeSidesPlusTheDecision = Expect<
  MutuallyAssignable<
    keyof StaleCoverDisposition,
    keyof StaleCoverIdentity | 'classification' | 'appendSite' | 'rationale'
  >
>;

/**
 * The ledger keys on the SAME lifecycle vocabulary the eligibility table is total over, so the two
 * cannot drift into different ideas of what a lifecycle is. A row can only name a state
 * {@link STALE_COVER_LIFECYCLE_POLICY} has an entry for, and a widening of that axis therefore
 * reaches this ledger as new undispositioned findings rather than as rows that silently never match.
 *
 * Falsifier: retype the row's lifecycle side as `string` and this alias stops holding — the moment
 * a ledger key could be minted that no diagnostic can produce.
 @proof
 * */
export type _RegistrationValidate_StaleCoverIdentity_KeysOnTheLifecycleAxis = Expect<
  MutuallyAssignable<StaleCoverIdentity['lifecycle'], keyof typeof STALE_COVER_LIFECYCLE_POLICY>
>;
