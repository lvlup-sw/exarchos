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
// ## Non-empty denominator — four ways this could go quietly vacuous, four diagnostics
//
// A boot check that resolves nothing must FAIL, not report clean:
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
//   • PROVIDER_REGISTRY_DRIFT — a provider entry the ledger no longer backs (or a tool claimed
//     twice). Delegated to `validateEffectProviders`, never re-implemented.
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
 * The two EMISSION-COUPLING rows are `observe`, and that is the whole reason the axis exists.
 * The comparison they carry reports against the live tree BEFORE the tree is reconciled — there
 * are real, measured disagreements in the shipped catalog — so arming it as `blocking` would take
 * every entry point down over a break set nobody has dispositioned yet. Graduating them is a
 * deliberate edit of these two rows once that set is disposed of, not a side effect of some other
 * change.
 */
export const DIAGNOSTIC_SEVERITY_POLICY: Readonly<Record<WeldDiagnosticCode, WeldDiagnosticSeverity>> =
  Object.freeze({
    [UNRESOLVABLE_PROVIDER_CODE]: 'blocking',
    [PROVIDER_REGISTRY_DRIFT_CODE]: 'blocking',
    EMPTY_CAPABILITY_DENOMINATOR: 'blocking',
    EMPTY_PROVIDER_REGISTRY: 'blocking',
    [EMISSION_PROVIDER_MISMATCH_CODE]: 'observe',
    EMPTY_EMISSION_DENOMINATOR: 'observe',
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
   */
  readonly comparedEmissionEdgeCount: number;
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
 * The boot-resolvable welds in an annotation table: `(eventType, ref)` for every registration whose
 * tier policy says `resolvedAt: 'boot'`.
 *
 * The ref comes from task 009's {@link weldReferenceOf}, whose `switch` has no `default` beyond the
 * `never` binding — so "what is this registration welded to" has ONE runtime authority and a sixth
 * tier cannot slip past it. Sorted by event type.
 */
export function bootResolvedWelds(
  annotations: Readonly<Record<string, EventRegistration>> = EVENT_ANNOTATIONS,
  policy: Readonly<Record<EventTier, WeldResolutionPolicy>> = WELD_RESOLUTION_POLICY,
): readonly { readonly eventType: string; readonly ref: string }[] {
  const welds: { eventType: string; ref: string }[] = [];
  for (const [eventType, registration] of Object.entries(annotations)) {
    if (policy[registration.tier].resolvedAt !== 'boot') continue;
    welds.push({ eventType, ref: weldReferenceOf(registration).ref });
  }
  return Object.freeze(welds.sort((a, b) => byString(a.eventType, b.eventType)));
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
  // Observations are a TRAILING block rather than an inline tag, so that with no observations the
  // rendered report is character-for-character the one this gate produced before severity existed.
  const observedBlock =
    observed.length === 0
      ? ''
      : `\nobserve-only — ${observed.length} finding(s) reported without blocking boot:\n` +
        observed.map(line).join('\n');

  // Every count is rendered beside the population it was measured over, so no number in this
  // report can be read without the denominator that gives it a meaning.
  const overPopulations =
    `${welds.length} boot-resolved weld(s), ${resolvable.length} live provider(s) ` +
    `and ${compared.length} compared emission edge(s)`;

  const report = ok
    ? `event registration welds OK — ${welds.length} boot-resolved weld(s) against ` +
      `${resolvable.length} live effect provider(s) and ${compared.length} compared emission edge(s)`
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
    diagnostics: sorted,
    blockingCount: blocking.length,
    observeCount: observed.length,
    report,
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
): WeldResolutionVerdict {
  const verdict = validateRegistrationWelds(
    annotations,
    providers,
    rules,
    policy,
    severityPolicy,
    emissions,
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
