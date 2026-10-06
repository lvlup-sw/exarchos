/**
 * Boot-time checks of the event registration welds. `initializeContext` calls
 * {@link assertRegistrationWeldsAtStartup} first, so a `capability` registration that names an
 * unresolvable `EffectProviderId` stops the boot of the CLI and of `exarchos mcp`.
 *
 * Providers resolve against the ledger-backed subset of `EFFECT_PROVIDERS`. Other checks compare
 * each declaring tool with the declared provider, look for active welds that no edge names, and
 * count primary owners. Each check reports an empty or narrowed population, so a check over
 * nothing does not read as clean. {@link WELD_RESOLUTION_POLICY},
 * {@link STALE_COVER_LIFECYCLE_POLICY} and {@link DIAGNOSTIC_SEVERITY_POLICY} set scope and severity.
 *
 * The `consumedBy` field of a capability is not resolved here, so a deleted consumer still boots.
 * The `_RegistrationValidate_*` type aliases at the end are compile-time proofs.
 */

import {
  EFFECT_PROVIDERS,
  ruleBacksProvider,
  validateEffectProviders,
  type EffectProvider,
} from '../contract/reachability/providers.js';
import { EFFECT_OWNERSHIP, type EffectOwnershipRule } from '../architecture/effect-ledger.js';
import { TOOL_REGISTRY, contractEmissionsOf, type CompositeTool } from '../registry.js';

/** Same union as `registry/gate-metadata.ts` — local to avoid a forbidden events→registry import. */
type AutoEmissionRole = 'primary' | 'recovery';
import { EVENT_ANNOTATIONS } from './event-annotations.js';
import { MODULE_EMISSIONS, type ModuleEmission } from './module-emissions.js';
import {
  weldReferenceOf,
  type CapabilityRegistration,
  type EffectProviderId,
  type EventLifecycle,
  type EventRegistration,
  type EventTier,
  type EventTierVariant,
} from './event-registration.js';

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
 * The diagnostic code for an active capability registration that no declared emission edge names.
 * The weld claims cover that nothing in the tool registry backs.
 */
export const STALE_CAPABILITY_COVER_CODE = 'STALE_CAPABILITY_COVER';
/** No event type in the declared-emission population names a primary declaring tool. */
export const ZERO_PRIMARY_OWNER_CODE = 'ZERO_PRIMARY_OWNER';
/** Two or more distinct primary owners claim the same event type. */
export const MULTI_PRIMARY_OWNER_CODE = 'MULTI_PRIMARY_OWNER';

/**
 * The measured size of the primary-owner population: distinct event types with at least one
 * declared emission edge. It is a floor with the same ratchet rule as
 * {@link EMISSION_DENOMINATOR_FLOOR}. Each new event type with a declared edge adds one.
 */
export const PRIMARY_OWNER_POPULATION_FLOOR = 77;

/**
 * The measured size of the set that the provider comparison ranges over: declared emission edges
 * whose event has a boot-resolvable weld. It is a floor, and the check is `compared < floor`.
 * A wider set passes. A narrower set means that the comparison silently stopped covering ground,
 * while every non-empty check still passes. A lower floor must be a deliberate, reviewed edit.
 * It is a constant, not a parameter, so no caller can relax it to zero.
 */
export const EMISSION_DENOMINATOR_FLOOR = 46;

/**
 * How the weld reference of one tier is resolved. For `boot`, `authority` names the live registry
 * that holds the ref. The other two arms carry only a note, because nothing exists to look up at boot.
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
 * Which tiers this gate resolves, and against what. The `Record` type makes the table total over
 * the tier axis. A new tier is a `tsc` error here until someone decides how to resolve its weld.
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
        '`SupportedGateClass` is the shipped closed union, pinned to `JUDGMENT_GATE_CLASSES`. ' +
        'One more gate class reddens `event-registration.ts` before it can reach a registration.',
    },
    'workflow-local': {
      resolvedAt: 'never',
      note:
        '`WorkflowDefinitionId` keys `ExarchosConfig.workflows`, which is user-authored per project ' +
        'and not loaded when this gate runs. There is no registry to resolve against at boot, and a ' +
        'check that looks at nothing is not a check.',
    },
    harness: {
      resolvedAt: 'never',
      note:
        '`HarnessModuleId` is a repo-relative path to a developer entry point OUTSIDE `src/`. There ' +
        'is no registry of harnesses to resolve against, and reading the filesystem on every process ' +
        'start to check one path would be a real cost for a developer-tooling concern. Resolved is ' +
        'not the same as UNCHECKED: `auditHarnessWelds` in this module checks both halves — the ' +
        'path is outside the governed root, and the module appends the event it claims — against ' +
        'the tree, and `harness-welds.test.ts` runs it. A `never` here records where the check is ' +
        'NOT, and the note is what says where it is.',
    },
  });

/**
 * Whether the registrations of one lifecycle state belong in the stale-cover population. The
 * excluded arm must carry a reason. Then a reader can tell a state with no possible edge from a
 * check that someone switched off.
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
 * Which lifecycle states the stale-cover check ranges over. The table is total over the lifecycle
 * axis, so a new state is a `tsc` error here until someone decides about it.
 *
 * No emission edge can name a `planned` or a `retired` event, so the check excludes them. The
 * exclusion reads the lifecycle field, not a list of event names. A list goes stale as events are
 * planned, but the field cannot.
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

/**
 * Whether a diagnostic stops the process. A `blocking` one throws out of
 * {@link assertRegistrationWeldsAtStartup}. An `observe` one goes to the boot channel, and startup
 * continues. With `observe`, a new check runs against the live tree before it can refuse startup.
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
      /** The lifecycle that admitted this registration, so the finding shows the exclusion axis. */
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
    }
  | {
      readonly code: 'EMPTY_PRIMARY_OWNER_DENOMINATOR';
      readonly eventType: null;
      readonly provider: null;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: 'NARROWED_PRIMARY_OWNER_DENOMINATOR';
      readonly eventType: null;
      readonly provider: null;
      readonly compared: number;
      readonly floor: number;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: typeof ZERO_PRIMARY_OWNER_CODE;
      readonly eventType: string;
      readonly provider: null;
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    }
  | {
      readonly code: typeof MULTI_PRIMARY_OWNER_CODE;
      readonly eventType: string;
      readonly provider: null;
      /** The distinct primary owners that collided — carried so the fault is readable in one line. */
      readonly owners: readonly string[];
      readonly message: string;
      readonly severity: WeldDiagnosticSeverity;
    };

/**
 * Every code that this gate can emit, read from the diagnostic union. A second list can drift
 * from the union, and then the severity table silently stops covering a code.
 */
export type WeldDiagnosticCode = WeldResolutionDiagnostic['code'];

/**
 * Which diagnostics stop the process. The table is total over the diagnostic codes, so a new code
 * is a `tsc` error here until someone decides whether it blocks boot.
 *
 * The rule: a catalog fault blocks, and a fault in the reach of this gate only reports. A tree
 * whose census stopped resolving must still boot, so that someone can run the tools that diagnose
 * it. A blocking floor also turns a valid re-tiering into a tree that cannot boot.
 */
export const DIAGNOSTIC_SEVERITY_POLICY: Readonly<Record<WeldDiagnosticCode, WeldDiagnosticSeverity>> =
  Object.freeze({
    [UNRESOLVABLE_PROVIDER_CODE]: 'blocking',
    [PROVIDER_REGISTRY_DRIFT_CODE]: 'blocking',
    EMPTY_CAPABILITY_DENOMINATOR: 'blocking',
    EMPTY_PROVIDER_REGISTRY: 'blocking',
    [EMISSION_PROVIDER_MISMATCH_CODE]: 'blocking',
    [STALE_CAPABILITY_COVER_CODE]: 'blocking',
    [ZERO_PRIMARY_OWNER_CODE]: 'blocking',
    [MULTI_PRIMARY_OWNER_CODE]: 'blocking',
    EMPTY_EMISSION_DENOMINATOR: 'observe',
    NARROWED_EMISSION_DENOMINATOR: 'observe',
    EMPTY_STALE_COVER_DENOMINATOR: 'observe',
    EMPTY_PRIMARY_OWNER_DENOMINATOR: 'observe',
    NARROWED_PRIMARY_OWNER_DENOMINATOR: 'observe',
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
   * Emission edges whose event is a boot-resolved weld: the denominator of the provider comparison.
   * {@link EMISSION_DENOMINATOR_FLOOR} holds a floor under it, so a reader sees how wide the
   * comparison was. No findings over a narrow set look the same as no findings over a full set.
   */
  readonly comparedEmissionEdgeCount: number;
  /**
   * Boot-resolved welds whose lifecycle admits them to the stale-cover check. Zero is a fault
   * (`EMPTY_STALE_COVER_DENOMINATOR`), never a pass, because a check over nothing finds nothing.
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

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The sort key of one diagnostic, joined on a separator that no field can contain. The key holds
 * `action`, because the emission comparison can report one fault for each declaring action of the
 * same event and provider. Without it, the order of those rows depends on scan order.
 */
const diagnosticSortKey = (d: WeldResolutionDiagnostic): string =>
  [d.code, d.eventType ?? '', d.provider ?? '', 'action' in d ? d.action : ''].join('\u0000');

/**
 * The provider ids that resolve. An entry is backed when exactly one live `EFFECT_OWNERSHIP` rule
 * backs it, through {@link ruleBacksProvider}. A tool resolves when exactly one backed entry claims
 * it. Two backed entries make a tool ambiguous, and an entry without one rule is stale. Sorted, so a
 * failure message is stable.
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
 * One boot-resolvable weld: the event, the ref that its tier policy resolves, and its lifecycle.
 * `lifecycle` rides on the same record as `ref`, so both questions about a registration read the
 * same row. A second walk of the annotation table can disagree with the first.
 */
export interface BootResolvedWeld {
  readonly eventType: string;
  readonly ref: string;
  readonly lifecycle: EventLifecycle;
}

/**
 * The boot-resolvable welds in an annotation table, sorted by event type. The ref comes from
 * {@link weldReferenceOf}, the one runtime authority for what a registration is welded to.
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
 * The welds that the stale-cover check ranges over: those whose lifecycle
 * {@link STALE_COVER_LIFECYCLE_POLICY} marks eligible. The filter reads the table, not
 * `lifecycle === 'active'`, so the table is the one authority. `lifecyclePolicy` is a parameter,
 * so a test can show that the filter reads it.
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
 * One declared emission edge from the tool registry: an action declares that it emits an event,
 * and the action belongs to a composite tool. {@link declaringTool} uses the same id space as
 * `EffectProviderId`, so the two sides compare directly. No module path is involved, because an
 * `AutoEmission` and a `ToolAction` carry none. A walk of `src/` is no alternative, because the
 * single-file binary has no `src/` and the walk cannot run at boot.
 */
export interface EmissionEdge {
  /** The event type the action declares it emits. */
  readonly event: string;
  /** The action carrying the declaration. */
  readonly action: string;
  /** The composite tool that action is registered under. */
  readonly declaringTool: string;
  /** Which edge this declaration is, when the registry carries it. */
  readonly role?: AutoEmissionRole;
  /** The accountable owner string from the declaration, when present. */
  readonly owner?: string;
}

/**
 * Flattens the tool registry into emission edges, sorted by event, tool and action. Only
 * `contractEmissionsOf` counts as declared. A sibling `autoEmits` field is not read, even when it
 * disagrees. The registry is read as a value, because a copy of which tool owns which action makes
 * the comparison agree with itself.
 */
export function declaredEmissionEdges(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): readonly EmissionEdge[] {
  const edges: EmissionEdge[] = [];
  for (const tool of registry) {
    for (const action of tool.actions) {
      for (const emission of contractEmissionsOf(action)) {
        edges.push({
          event: emission.event,
          action: action.name,
          declaringTool: tool.name,
          role: emission.role,
          owner: emission.owner,
        });
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
 * Reconciles every boot-resolvable weld against the live registries. It is pure and returns a
 * verdict. It never throws. Every population is a parameter with a live default, so a test can
 * seed a fault without a change to the frozen catalog.
 *
 * The provider-registry drift goes first, so the report names the cause before its effects. Each
 * severity comes from `severityPolicy`, never from the call site. Each comparison also reports an
 * empty or narrowed population. Module emissions count as edges for stale cover, and
 * `auditEmitterClosure` checks each such row against its module. `ok` means no diagnostic at all,
 * and `bootable` means no blocking diagnostic.
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
  moduleEmissions: readonly ModuleEmission[] = MODULE_EMISSIONS,
  primaryOwnerEmissions: readonly EmissionEdge[] = declaredEmissionEdges(),
): WeldResolutionVerdict {
  const diagnostics: WeldResolutionDiagnostic[] = [];
  const severityOf = (code: WeldDiagnosticCode): WeldDiagnosticSeverity => severityPolicy[code];

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
      message:
        `action '${edge.action}' on composite tool '${edge.declaringTool}' declares it emits ` +
        `'${edge.event}', but that event is registered tier 'capability' with provider ` +
        `'${declared}'. The declaring tool and the declared provider are the same id space ` +
        '(EffectProvider["tool"]), so one of the two is wrong: either the annotation names the ' +
        'wrong provider, or the emission is declared on the wrong tool.',
    });
  }

  const eligible = staleCoverEligibleWelds(welds, lifecyclePolicy);
  const excludedByLifecycle = welds.length - eligible.length;

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

  const namedByAnEdge = new Set(emissions.map((edge) => edge.event));
  for (const row of moduleEmissions) namedByAnEdge.add(row.event);
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

  const eventsWithEdges = new Set(primaryOwnerEmissions.map((edge) => edge.event));
  const populationSize = eventsWithEdges.size;

  if (populationSize === 0) {
    diagnostics.push({
      code: 'EMPTY_PRIMARY_OWNER_DENOMINATOR',
      eventType: null,
      provider: null,
      severity: severityOf('EMPTY_PRIMARY_OWNER_DENOMINATOR'),
      message:
        'no event type is named by any declared autoEmits edge — the primary-owner comparison ' +
        'ranged over an empty population and cannot have found anything, which must not read as ' +
        'clean.',
    });
  } else if (populationSize < PRIMARY_OWNER_POPULATION_FLOOR) {
    diagnostics.push({
      code: 'NARROWED_PRIMARY_OWNER_DENOMINATOR',
      eventType: null,
      provider: null,
      compared: populationSize,
      floor: PRIMARY_OWNER_POPULATION_FLOOR,
      severity: severityOf('NARROWED_PRIMARY_OWNER_DENOMINATOR'),
      message:
        `the primary-owner comparison ranged over ${populationSize} event type(s), below the ` +
        `measured floor of ${PRIMARY_OWNER_POPULATION_FLOOR}, out of ${primaryOwnerEmissions.length} declared ` +
        'edge(s). The population is not empty, so vacuity guards pass and a narrowing still hides. ' +
        'If the shrink is intended, lower PRIMARY_OWNER_POPULATION_FLOOR in the same change and say why.',
    });
  }

  if (populationSize > 0) {
    const primaryOwnersByEvent = new Map<string, Set<string>>();
    for (const edge of primaryOwnerEmissions) {
      if (edge.role !== 'primary' || edge.owner === undefined) continue;
      let owners = primaryOwnersByEvent.get(edge.event);
      if (owners === undefined) {
        owners = new Set();
        primaryOwnersByEvent.set(edge.event, owners);
      }
      owners.add(edge.owner);
    }

    for (const eventType of [...eventsWithEdges].sort(byString)) {
      const owners = primaryOwnersByEvent.get(eventType) ?? new Set<string>();
      if (owners.size === 0) {
        diagnostics.push({
          code: ZERO_PRIMARY_OWNER_CODE,
          eventType,
          provider: null,
          severity: severityOf(ZERO_PRIMARY_OWNER_CODE),
          message:
            `event '${eventType}' is named by declared autoEmits edge(s) but no edge declares ` +
            'itself primary with an owner — no declaring tool claims primary for this event type.',
        });
        continue;
      }
      if (owners.size > 1) {
        const ownerList = [...owners].sort(byString);
        diagnostics.push({
          code: MULTI_PRIMARY_OWNER_CODE,
          eventType,
          provider: null,
          owners: ownerList,
          severity: severityOf(MULTI_PRIMARY_OWNER_CODE),
          message:
            `event '${eventType}' has ${owners.size} distinct primary owners [${ownerList.join(', ')}] ` +
            '— two or more declaring tools both claim primary for the same event type.',
        });
      }
    }
  }

  const sorted = [...diagnostics].sort((a, b) =>
    byString(diagnosticSortKey(a), diagnosticSortKey(b)),
  );
  const blocking = sorted.filter((d) => d.severity === 'blocking');
  const observed = sorted.filter((d) => d.severity === 'observe');
  const ok = sorted.length === 0;
  const bootable = blocking.length === 0;

  const line = (d: WeldResolutionDiagnostic): string =>
    `  [${d.code}] ${d.eventType ?? d.provider ?? '<catalog>'}: ${d.message}`;
  const observedBlock =
    observed.length === 0
      ? ''
      : `\nobserve-only — ${observed.length} finding(s) reported without blocking boot:\n` +
        observed.map(line).join('\n');

  const overPopulations =
    `${welds.length} boot-resolved weld(s), ${eligible.length} stale-cover eligible, ` +
    `${resolvable.length} live provider(s) and ${compared.length} compared emission edge(s)`;

  const report = ok
    ? `event registration welds OK — ${overPopulations}`
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

/**
 * How a measured disagreement was answered. `genuine-mismatch`: no provider id can express the
 * truth, so no correct annotation exists. `annotation-error`: a correct value exists, and the
 * annotation does not carry it.
 */
export type DisagreementClassification = 'genuine-mismatch' | 'annotation-error';

/**
 * The four sides that identify one measured disagreement: the fields of
 * {@link EMISSION_PROVIDER_MISMATCH_CODE}, with `eventType` and `provider` renamed for clarity.
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
 * One row of the ledger: a measured disagreement, its classification, and why. `rationale` is
 * required, because the reasoning is the value of the row.
 */
export interface DisagreementDisposition extends DisagreementIdentity {
  readonly classification: DisagreementClassification;
  readonly rationale: string;
}



/**
 * The measured break set: each disagreement that the provider comparison reports on the live
 * catalog, with a disposition. {@link auditDisagreementDispositions} derives the reports again on
 * each run and reconciles them with this table in both directions.
 */
export const PROVIDER_DISAGREEMENT_DISPOSITIONS: readonly DisagreementDisposition[] = Object.freeze([
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
 * The ledger key for one disagreement: all four sides as a JSON tuple. JSON is injective, so no
 * two tuples give the same text. A key with fewer sides lets one row answer for edges that nobody
 * examined.
 */
const identityKey = (identity: DisagreementIdentity): string =>
  JSON.stringify([
    identity.event,
    identity.action,
    identity.declaredProvider,
    identity.declaringTool,
  ]);

/**
 * The identity of one reported disagreement. It is the only place that turns a diagnostic into a
 * ledger key. If the mismatch arm loses a field, this function does not compile.
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
 * Reconciles the reported break set with the ledger in both directions. It is pure and returns a
 * verdict. `UNDISPOSITIONED_DISAGREEMENT` is a reported edge that no row answers for.
 * `STALE_DISPOSITION` is a row for an edge that the comparison no longer reports. Both
 * populations are parameters with live defaults, so a test can seed a fault. Diagnostics sort by
 * code, then by identity.
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

/**
 * How an active weld that no emission edge names was answered. `unmodelled-emitter`: machinery
 * that the registry does not model as an action appends the event, so no edge can exist.
 * `undeclared-emission`: the handler of an action appends it, and the action does not declare it.
 */
export type StaleCoverClassification = 'unmodelled-emitter' | 'undeclared-emission';

/**
 * The three sides that identify one reported stale cover: the fields of
 * {@link STALE_CAPABILITY_COVER_CODE}, with `eventType` and `provider` renamed for clarity.
 * The lifecycle is a side, so a widened policy brings new findings, not inherited answers.
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
 * One row of the ledger: a measured stale cover, the site of its append, its classification, and
 * why. `appendSite` is its own field, because it is the evidence that a reader can check against
 * the tree in one step.
 */
export interface StaleCoverDisposition extends StaleCoverIdentity {
  readonly classification: StaleCoverClassification;
  /**
   * The repo-relative module that appends, and the action that reaches it, if one does. The key
   * does not include it, so a moved module makes the row out of date but does not break matching.
   */
  readonly appendSite: string;
  readonly rationale: string;
}





/**
 * The measured stale-cover break set, with a disposition for each finding. Repair closed every
 * row, so the ledger is empty. An empty ledger does not disable the check. The reconciliation
 * fails in both directions, so a new stale cover fails at once. A weld that nothing appends needs
 * a `planned` lifecycle, not a row.
 */
export const STALE_COVER_DISPOSITIONS: readonly StaleCoverDisposition[] = Object.freeze([]);

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
 * The ledger key for one stale cover: all three sides as a JSON tuple. A key on the event alone
 * lets a row about an `active` weld answer for the same event after a lifecycle widening.
 */
const staleCoverKey = (identity: StaleCoverIdentity): string =>
  JSON.stringify([identity.event, identity.declaredProvider, identity.lifecycle]);

/**
 * The identity of one reported stale cover. It is the only place that turns a diagnostic into a
 * ledger key. If the stale-cover arm loses a field, this function does not compile.
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
 * Reconciles the reported stale-cover set with the ledger in both directions. It is pure and
 * returns a verdict. `UNDISPOSITIONED_STALE_COVER` is a finding that no row answers for.
 * `OBSOLETE_STALE_COVER_DISPOSITION` is a row for a finding that is gone. Both populations are
 * parameters with live defaults. Diagnostics sort by code, then by identity.
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

/** The governed source root a `harness` module must sit outside of. */
const GOVERNED_SOURCE_ROOT = 'src/';

/** A `harness` registration whose declared module does not hold up against the tree. */
export type HarnessWeldDiagnostic =
  | {
      readonly code: 'HARNESS_MODULE_INSIDE_GOVERNED_ROOT';
      readonly event: string;
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly code: 'HARNESS_MODULE_MISSING';
      readonly event: string;
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly code: 'HARNESS_MODULE_DOES_NOT_APPEND';
      readonly event: string;
      readonly module: string;
      readonly message: string;
    };

/** The verdict, carrying the population so an empty finding list cannot pass for a clean one. */
export interface HarnessWeldAuditResult {
  readonly ok: boolean;
  /** How many `harness` registrations were assessed — the denominator. */
  readonly assessedCount: number;
  readonly diagnostics: readonly HarnessWeldDiagnostic[];
}

/** Reads one repo-relative module, or `undefined` when it is not there. */
export type HarnessModuleReader = (relativePath: string) => string | undefined;

/**
 * Checks every `harness` registration against the tree, because no registry of harnesses exists.
 * The module must be outside `src/`, because an emitter under `src/` has a real weld. The module
 * must exist and mention the event. The reader is a parameter, so a test can show that the check
 * fails.
 */
export function auditHarnessWelds(
  annotations: Readonly<Record<string, EventRegistration>>,
  readModule: HarnessModuleReader,
): HarnessWeldAuditResult {
  const diagnostics: HarnessWeldDiagnostic[] = [];
  let assessedCount = 0;

  for (const [event, registration] of Object.entries(annotations)) {
    if (registration.tier !== 'harness') continue;
    assessedCount += 1;
    const module = registration.module;

    if (module.startsWith(GOVERNED_SOURCE_ROOT)) {
      diagnostics.push({
        code: 'HARNESS_MODULE_INSIDE_GOVERNED_ROOT',
        event,
        module,
        message:
          `event '${event}' is registered tier 'harness' naming '${module}', which is inside the ` +
          `governed source root '${GOVERNED_SOURCE_ROOT}'. The harness tier names developer ` +
          'tooling that has no registered surface to weld to; an emitter in the governed root ' +
          'has one — a provider, a gate, the store, or a workflow definition — and must name it.',
      });
      continue;
    }

    const source = readModule(module);
    if (source === undefined) {
      diagnostics.push({
        code: 'HARNESS_MODULE_MISSING',
        event,
        module,
        message:
          `event '${event}' is registered tier 'harness' naming '${module}', which does not exist. ` +
          'A weld pointing at a file that is gone is cover, not coupling.',
      });
      continue;
    }

    if (!source.includes(event)) {
      diagnostics.push({
        code: 'HARNESS_MODULE_DOES_NOT_APPEND',
        event,
        module,
        message:
          `event '${event}' is registered tier 'harness' naming '${module}', but that module never ` +
          'mentions the event. The row claims an append the tree does not perform.',
      });
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    assessedCount,
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * The default sink for observe-severity findings. It writes to stderr, because the `exarchos mcp`
 * facade owns stdout for the JSON-RPC stream. The sink is a parameter, so a test can capture it.
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
 * The boot gate. `initializeContext` in `dispatch/core/context.ts` calls it first, so a blocking
 * fault stops the CLI and `exarchos mcp` before an `EventStore` exists. It has the same shape as
 * `assertBindingsAtStartup` in `contract/bindings/verify-bindings.ts`.
 *
 * Only a `blocking` diagnostic throws. An `observe` finding goes to `report`, and startup continues.
 * `emissions` comes after `report`, so callers that pass the earlier arguments by position keep
 * their binding.
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
  moduleEmissions: readonly ModuleEmission[] = MODULE_EMISSIONS,
  primaryOwnerEmissions: readonly EmissionEdge[] = declaredEmissionEdges(),
): WeldResolutionVerdict {
  const verdict = validateRegistrationWelds(
    annotations,
    providers,
    rules,
    policy,
    severityPolicy,
    emissions,
    lifecyclePolicy,
    moduleEmissions,
    primaryOwnerEmissions,
  );
  if (!verdict.bootable) throw new RegistrationWeldError(verdict);
  if (verdict.observeCount > 0) report(verdict.report);
  return verdict;
}

type Expect<T extends true> = T;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The id space that this gate resolves is the id space that the union declares:
 * `EffectProviderId` is `EffectProvider['tool']`. A brand or a closed union breaks this check.
 * @proof
 */
export type _RegistrationValidate_ProviderId_IsTheProviderMapKey = Expect<
  MutuallyAssignable<EffectProviderId, EffectProvider['tool']>
>;

/**
 * The `provider` field of the capability arm is an `EffectProviderId`, so resolving `.provider`
 * resolves what the union promises.
 * @proof
 */
export type _RegistrationValidate_CapabilityProvider_IsAProviderId = Expect<
  MutuallyAssignable<CapabilityRegistration['provider'], EffectProviderId>
>;

/**
 * `provider` appears on exactly one arm of the union, so a policy that marks only `capability` as
 * boot-resolvable covers every provider reference. A new arm with `provider` breaks this check.
 * @proof
 */
export type _RegistrationValidate_ProviderField_IsUniqueToTheCapabilityArm = Expect<
  MutuallyAssignable<Extract<EventTierVariant, { provider: unknown }>['tier'], 'capability'>
>;

/**
 * The policy table is total over the tier axis. The `Record` type already enforces this. The proof
 * also catches a refactor to `Partial` or an index signature, which lets a new tier skip boot.
 * @proof
 */
export type _RegistrationValidate_Policy_IsTotalOverTheTierAxis = Expect<
  MutuallyAssignable<keyof typeof WELD_RESOLUTION_POLICY, EventTier>
>;

/**
 * Every arm of the diagnostic union carries a severity, so no fault reaches the boot decision
 * without one. If an arm drops the field, `WeldResolutionDiagnostic['severity']` stops resolving.
 * @proof
 */
export type _RegistrationValidate_EveryDiagnostic_CarriesASeverity = Expect<
  MutuallyAssignable<WeldResolutionDiagnostic['severity'], WeldDiagnosticSeverity>
>;

/**
 * The severity table is total over the diagnostic codes, for the same reason as the tier proof.
 * The codes come from the union, so the two cannot drift apart.
 * @proof
 */
export type _RegistrationValidate_SeverityPolicy_IsTotalOverTheDiagnosticAxis = Expect<
  MutuallyAssignable<keyof typeof DIAGNOSTIC_SEVERITY_POLICY, WeldDiagnosticCode>
>;

/**
 * The mismatch arm names all four sides in one record: the event, the declared provider, the
 * declaring tool and the action. If the arm loses a field, the key sets differ and the build fails.
 * @proof
 */
export type _RegistrationValidate_MismatchDiagnostic_NamesBothSides = Expect<
  MutuallyAssignable<
    keyof Extract<WeldResolutionDiagnostic, { code: typeof EMISSION_PROVIDER_MISMATCH_CODE }>,
    'code' | 'eventType' | 'provider' | 'action' | 'declaringTool' | 'message' | 'severity'
  >
>;

/**
 * The narrowed arm carries both `compared` and `floor`, so a reader can size the shortfall. If the
 * arm loses either field, the key sets differ and the build fails.
 * @proof
 */
export type _RegistrationValidate_NarrowedDiagnostic_CarriesTheShortfall = Expect<
  MutuallyAssignable<
    keyof Extract<WeldResolutionDiagnostic, { code: 'NARROWED_EMISSION_DENOMINATOR' }>,
    'code' | 'eventType' | 'provider' | 'compared' | 'floor' | 'message' | 'severity'
  >
>;

/**
 * Both compared sides are composite tool ids: `EmissionEdge.declaringTool` is a
 * `CompositeTool['name']`. Both are `string` now. A future brand on either side fails the build
 * here, not as an equality that is always false at runtime.
 * @proof
 */
export type _RegistrationValidate_BothComparedSides_AreCompositeToolIds = Expect<
  MutuallyAssignable<EmissionEdge['declaringTool'], CompositeTool['name']>
>;

/**
 * The stale-cover policy is total over the lifecycle axis, as the other two tables are over theirs.
 * The proof also catches a refactor to `Partial` or an index signature, which lets a state skip
 * the eligibility decision.
 * @proof
 */
export type _RegistrationValidate_StaleCoverPolicy_IsTotalOverTheLifecycleAxis = Expect<
  MutuallyAssignable<keyof typeof STALE_COVER_LIFECYCLE_POLICY, EventLifecycle>
>;

/**
 * `staleCoverEligibleWelds` takes {@link BootResolvedWeld} records and returns the same type, so
 * both checks agree on which registrations are in scope.
 * @proof
 */
export type _RegistrationValidate_StaleCoverPopulation_IsASubsetOfTheResolvedWelds = Expect<
  MutuallyAssignable<
    ReturnType<typeof staleCoverEligibleWelds>[number],
    ReturnType<typeof bootResolvedWelds>[number]
  >
>;

/**
 * The stale-cover finding names the event, the claimed provider and the admitting lifecycle in one
 * record. The lifecycle shows that the exclusion axis works. If the arm loses a field, the build
 * fails.
 * @proof
 */
export type _RegistrationValidate_StaleCoverDiagnostic_NamesTheEventAndItsLifecycle = Expect<
  MutuallyAssignable<
    keyof Extract<WeldResolutionDiagnostic, { code: typeof STALE_CAPABILITY_COVER_CODE }>,
    'code' | 'eventType' | 'provider' | 'lifecycle' | 'message' | 'severity'
  >
>;

/**
 * A disagreement row is the four identity sides plus `classification` and `rationale`, and nothing
 * else. A missing side lets one row answer for edges that nobody examined. An extra field makes a
 * key that the comparison cannot produce, so the row never matches.
 * @proof
 */
export type _RegistrationValidate_Disposition_IsTheFourSidesPlusTheDecision = Expect<
  MutuallyAssignable<
    keyof DisagreementDisposition,
    keyof DisagreementIdentity | 'classification' | 'rationale'
  >
>;

/**
 * A stale-cover row is the three identity sides plus `classification`, `appendSite` and
 * `rationale`, and nothing else. `appendSite` is evidence, not identity, so a moved module does
 * not break matching. A missing side or an extra field breaks the build.
 * @proof
 */
export type _RegistrationValidate_StaleCoverDisposition_IsTheThreeSidesPlusTheDecision = Expect<
  MutuallyAssignable<
    keyof StaleCoverDisposition,
    keyof StaleCoverIdentity | 'classification' | 'appendSite' | 'rationale'
  >
>;

/**
 * The lifecycle side of a row uses the same vocabulary as {@link STALE_COVER_LIFECYCLE_POLICY}.
 * A widened axis brings new undispositioned findings, not rows that never match.
 * @proof
 */
export type _RegistrationValidate_StaleCoverIdentity_KeysOnTheLifecycleAxis = Expect<
  MutuallyAssignable<StaleCoverIdentity['lifecycle'], keyof typeof STALE_COVER_LIFECYCLE_POLICY>
>;
