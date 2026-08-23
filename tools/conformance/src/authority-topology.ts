// ─── The authority topology as data (DR-6, gate G5) ──────────────────────────
//
// G5, stated once: **every declared boundary names exactly one authority; every
// other representation names what binds it.** An unbound representation, or more
// than one authority, fails closure. More than one AUTHORITATIVE representation
// is a finding *regardless of whether the copies currently agree* — "they happen
// to match today" is not a binding, it is a coincidence with a maintenance bill.
//
// ## What this module is, and is not
//
// It is the **model**: the boundary rows, their authorities, their bound and
// unbound representations, and the wave from which each boundary's
// single-authority rule is mechanically enforced. It also carries the rows'
// own **totality check** — the well-formedness invariant on the data itself.
//
// It is NOT the closure census. Evaluating closure over these rows (and failing
// it) is task 025; proving that failure fires live on the CLI-surface and
// event-catalog rows is task 026. The split matters: a data model that also
// judged itself would be a single authority pretending to be two, which is the
// Class B defect DR-30 exists to forbid.
//
// ## Why this shape and not a new instrument
//
// The program's rule is *no new enforcement instrument* — extend the shipped
// idiom. So this module is deliberately the composition of three shipped ones:
//
//   • `contract/reachability/graph.ts` (P05-05) resolves each public action
//     along seven hops and fails on `missing` (0 resolvers) or `ambiguous`
//     (>1). G5 is the SAME rule lifted from per-action hops to per-boundary
//     authorities: `none` is the missing arm, `contested` is the ambiguous arm.
//     `HOP_AUTHORITIES` also supplies the precedent for the totality shape used
//     below — a `Readonly<Record<Domain, …>>` over a union, so a domain member
//     without an entry is a COMPILE error rather than a silent gap.
//   • `contract/declaration.ts` (DR-1, task 005) already defines
//     {@link AuthorityId} as "the *Authoritative* column of the spec's
//     authority-topology table" and {@link RepresentationId} as a representation
//     mechanically bound to it. This module is that table; it imports the
//     vocabulary rather than minting a parallel one.
//   • `architecture/effect-port-seam.ts` / `adapter-ownership-seam.ts` supply
//     the **two-way ratchet**: a declaration that over-claims is as much a
//     finding as one that under-claims. Here that is `STALE_DERIVED_PROVENANCE`
//     (a row claiming it was derived when no derivation produces it) and
//     `UNJUSTIFIED_DECLARED_ROW` (a hand-maintained row that never says why it
//     could not be derived). Without both teeth the provenance field would rot
//     into a rubber stamp within one wave.
//
// ## The derivation rule, and why it is the load-bearing part
//
// An earlier revision of this table was MISSING the SDK-generation boundary
// entirely, and on the strength of that omission asserted a compile-time
// guarantee over a boundary it had never modelled. That is the failure mode this
// module is shaped against, and it generalises:
//
//   **A boundary absent from the topology is the one place an unbound
//   representation can hide from the census designed to find it.**
//
// A census can only range over rows that exist. So wherever a boundary's
// existence is implied by a domain some OTHER module already owns, this module
// must not restate it — it must be forced to carry it. That is
// {@link BOUNDARY_DERIVATIONS}: each bridge names an upstream domain and the
// boundaries that domain REQUIRES. Both teeth are live:
//
//   • compile-time — a bridge is a `Readonly<Record<UpstreamUnion, …>>` whose
//     values are typed {@link ContractBoundaryId}. Grow the upstream union and
//     this module stops compiling until the boundary is named; delete a boundary
//     id from {@link CONTRACT_BOUNDARIES} and the bridge stops compiling.
//   • run-time — `checkTopologyTotality` fails when a bridge requires a boundary
//     no row covers, so a row deleted from the table (rather than from the id
//     union) is caught too.
//
// Four of the eight rows are derived this way. **Four are not, and that is stated
// per row rather than smoothed over** — see `whyNotDerivable` on each `declared`
// row, and the "What is NOT derivable today" note above
// {@link AUTHORITY_TOPOLOGY}. Claiming derivation this module does not have would
// reproduce the exact defect described above, one level up.
//
// ## No `as const`, deliberately
//
// The repo's census counts type assertions and `as const` is counted, so every
// tuple here carries an explicit `readonly [...]` annotation instead — the
// cast-free idiom `contract/declaration.ts` established for `DECLARATION_KINDS`.
// The annotation form yields the same literal element types.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AuthorityId,
  DeclarationKind,
  RepresentationId,
} from '../../../src/contract/declaration.js';
import type { SdkGeneration } from '../../../src/architecture/sdk-generation-seam.js';

// ─── The boundary domain ─────────────────────────────────────────────────────

/**
 * Every contract boundary G5 governs. Sorted alphabetically so the tuple is a
 * stable, diff-friendly enumeration; iteration order is not semantic.
 *
 * This tuple is the census DENOMINATOR. It is not free to shrink: four of these
 * ids are referenced by a {@link BoundaryDerivation}, so deleting one fails the
 * compile at the bridge rather than quietly narrowing what the census ranges
 * over.
 */
export const CONTRACT_BOUNDARIES: readonly [
  'action-contract',
  'capability-posture',
  'cli-surface',
  'effect-event',
  'event-catalog',
  'phase-sequencing',
  'response-shape',
  'sdk-generation',
] = [
  'action-contract',
  'capability-posture',
  'cli-surface',
  'effect-event',
  'event-catalog',
  'phase-sequencing',
  'response-shape',
  'sdk-generation',
];

/** One of the eight boundaries in {@link CONTRACT_BOUNDARIES}. */
export type ContractBoundaryId = (typeof CONTRACT_BOUNDARIES)[number];

// ─── Enforcement point ───────────────────────────────────────────────────────

/** The overhaul waves that mechanically enforce a boundary's single authority. */
export const ENFORCEMENT_WAVES: readonly ['wave-1', 'wave-2', 'wave-3', 'wave-4', 'wave-5'] = [
  'wave-1',
  'wave-2',
  'wave-3',
  'wave-4',
  'wave-5',
];

/** One of the waves in {@link ENFORCEMENT_WAVES}. */
export type EnforcementWave = (typeof ENFORCEMENT_WAVES)[number];

/**
 * When a boundary's single-authority rule starts being MECHANICALLY enforced.
 *
 * Required on every row — a row without one fails
 * {@link checkTopologyTotality}. **There is no blanket allowlist**, and the
 * `already-enforced` arm is not one: it is a positive, falsifiable claim that
 * must NAME the shipped instrument doing the enforcing, and a row making it is
 * held to the stricter standard (task 025 requires exactly one authoritative
 * representation and zero unbound ones). An exemption would be a row that says
 * nothing; this arm says something a reviewer can go and check.
 */
export type EnforcementPoint =
  | {
      readonly kind: 'wave';
      readonly wave: EnforcementWave;
      /** The DR that lands the enforcement, so the wave claim is checkable. */
      readonly driver: string;
    }
  | {
      readonly kind: 'already-enforced';
      /** The shipped instrument that enforces it TODAY. Named, not asserted. */
      readonly by: string;
    };

// ─── Authority ───────────────────────────────────────────────────────────────

/**
 * A boundary's authority, in exactly one of three states.
 *
 * The `single` arm carries ONE {@link AuthorityId}, never an array, mirroring
 * `contract/declaration.ts`'s `_DeclarationPluralAuthority_FailsCompile`: the
 * G5 "two authorities" defect is not expressible as a well-formed `single` row.
 * It can only be recorded as `contested`, which is precisely the point — the
 * defect has to be *declared* to be carried, so it cannot ride along unnamed.
 */
export type BoundaryAuthority =
  | { readonly kind: 'single'; readonly authority: AuthorityId }
  | {
      readonly kind: 'contested';
      /** The competing authorities. Two or more, by definition. */
      readonly candidates: readonly AuthorityId[];
    }
  | { readonly kind: 'none'; readonly why: string };

// ─── Representations ─────────────────────────────────────────────────────────

/**
 * How a representation relates to its boundary's authority.
 *
 * `bound` MEANS mechanically derived — regenerate the authority and the
 * representation follows, so it cannot drift. A representation that merely
 * *agrees* with the authority today, or that is only spot-VALIDATED against it,
 * is `unbound`: validation catches a wrong entry but never a missing one, and G5
 * is a claim about the whole population, not about the entries that happen to be
 * present. Several rows below turn on exactly that distinction.
 */
export type RepresentationBinding =
  /** This representation IS the authority. Two of these on one row is the G5 finding. */
  | { readonly kind: 'authoritative' }
  /** Mechanically derived from `boundTo`; `how` names the derivation. */
  | { readonly kind: 'bound'; readonly boundTo: AuthorityId; readonly how: string }
  /** Nothing derives it. The finding G5 exists to surface; `why` states the gap. */
  | { readonly kind: 'unbound'; readonly why: string };

/** One representation of a boundary, and what (if anything) binds it. */
export interface BoundaryRepresentation {
  readonly id: RepresentationId;
  readonly binding: RepresentationBinding;
}

// ─── Provenance ──────────────────────────────────────────────────────────────

/** The derivation bridges that force boundaries to exist. */
export const DERIVATION_IDS: readonly ['declaration-kinds', 'sdk-generations'] = [
  'declaration-kinds',
  'sdk-generations',
];

/** One of the bridges in {@link DERIVATION_IDS}. */
export type DerivationId = (typeof DERIVATION_IDS)[number];

/**
 * Where a row came from — the anti-rubber-stamp field.
 *
 * Both arms are policed by {@link checkTopologyTotality}: a `derived` row whose
 * bridge does not actually require it is `STALE_DERIVED_PROVENANCE`, and a
 * `declared` row with no rationale is `UNJUSTIFIED_DECLARED_ROW`. So neither
 * "claim derivation you do not have" nor "hand-maintain without saying why"
 * survives review by default.
 */
export type RowProvenance =
  | { readonly kind: 'derived'; readonly from: DerivationId }
  | {
      readonly kind: 'declared';
      /** Why this boundary cannot be derived from a live domain TODAY. Required. */
      readonly whyNotDerivable: string;
    };

// ─── The row ─────────────────────────────────────────────────────────────────

/**
 * One boundary's authority topology. The unit task 025's census ranges over.
 *
 * Shaped so 025 consumes it without reshaping: closure is a pure function of
 * `authority` + `representations`, and `enforceFrom` says whether a break is
 * enforced now or scheduled. No field requires reading the filesystem.
 */
export interface AuthorityTopologyRow {
  readonly boundary: ContractBoundaryId;
  readonly authority: BoundaryAuthority;
  /** Every representation of the boundary. Non-empty. */
  readonly representations: readonly BoundaryRepresentation[];
  readonly enforceFrom: EnforcementPoint;
  readonly provenance: RowProvenance;
  /** The measured live state this row records, for the failure message. */
  readonly measured: string;
}

// ─── Derivation bridges ──────────────────────────────────────────────────────

/**
 * A boundary domain owned by ANOTHER module, and the boundaries it forces this
 * table to carry. The mechanism that stops a boundary going missing.
 */
export interface BoundaryDerivation {
  readonly id: DerivationId;
  /** The module that owns the domain. */
  readonly sourceModule: string;
  /** The union/tuple that IS the domain. */
  readonly domain: string;
  /** The domain's members, read from the upstream module — never restated. */
  readonly members: readonly string[];
  /** Boundaries this domain requires the topology to carry. */
  readonly requires: readonly ContractBoundaryId[];
  readonly note: string;
}

/**
 * DR-1 declaration kind → the boundary that kind's declarations cross.
 *
 * Total by construction: `Readonly<Record<DeclarationKind, ContractBoundaryId>>`
 * means a fourth {@link DeclarationKind} landing upstream (task 009's
 * `EventRegistration` work, DR-10, DR-19) is a COMPILE error here until its
 * boundary is named. That is the whole derivation: the three declaration
 * boundaries cannot go missing from this table the way the SDK one did, because
 * their existence is not this module's opinion.
 */
export const DECLARATION_KIND_BOUNDARIES: Readonly<Record<DeclarationKind, ContractBoundaryId>> =
  Object.freeze({
    action: 'action-contract',
    'cli-verb': 'cli-surface',
    event: 'event-catalog',
  });

/**
 * MCP SDK generation → the representation that generation contributes.
 *
 * Total over {@link SdkGeneration}, the union `architecture/sdk-generation-seam.ts`
 * uses to classify every SDK import. Two consequences, both intended:
 *
 *   • a third generation upstream is a compile error here;
 *   • the sdk-generation row's authority is COMPUTED from this map's size, not
 *     written down. More than one generation IS the contest. So when the DR-26
 *     migration finishes and the seam collapses to one generation, the row stops
 *     reporting `contested` on its own — nobody has to remember to edit it.
 */
export const SDK_GENERATION_REPRESENTATIONS: Readonly<Record<SdkGeneration, RepresentationId>> =
  Object.freeze({
    v1: '@modelcontextprotocol/sdk (v1 package root, incl. every `…/sdk/*` subpath)',
    v2: '@modelcontextprotocol/{core,server,client} (v2 package roots)',
  });

/** The boundaries the declaration-kind bridge requires, read off the bridge map. */
const DECLARATION_KIND_REQUIRED: readonly ContractBoundaryId[] = Object.freeze(
  Object.values(DECLARATION_KIND_BOUNDARIES),
);

/** The boundary the SDK-generation bridge requires. */
const SDK_GENERATION_REQUIRED: readonly ContractBoundaryId[] = Object.freeze(['sdk-generation']);

/**
 * Every declared derivation bridge.
 *
 * The declaration kinds arrive as a parameter rather than as an import: this
 * module is conformance code and must not reach into the tree it inspects, so
 * the composition root supplies the real `DECLARATION_KINDS`. Reading the local
 * {@link DECLARATION_KIND_BOUNDARIES} keys instead would make the bridge
 * self-referential — the census would be asserting the table covers itself.
 */
export function boundaryDerivations(
  declarationKinds: readonly DeclarationKind[],
): readonly BoundaryDerivation[] {
  return Object.freeze([
  Object.freeze({
    id: 'declaration-kinds',
    sourceModule: 'contract/declaration.ts',
    domain: 'DECLARATION_KINDS / DeclarationKind',
    members: declarationKinds,
    requires: DECLARATION_KIND_REQUIRED,
    note:
      'Every declaration kind DR-1 unifies crosses a contract boundary, so the kind union ' +
      'is the boundary domain. Adding a kind upstream fails this module at compile time ' +
      'until the new boundary is modelled.',
  }),
  Object.freeze({
    id: 'sdk-generations',
    sourceModule: 'architecture/sdk-generation-seam.ts',
    domain: 'SdkGeneration',
    members: Object.freeze(Object.keys(SDK_GENERATION_REPRESENTATIONS)),
    requires: SDK_GENERATION_REQUIRED,
    note:
      'The seam distinguishes more than one SDK generation, which is what makes the ' +
      'protocol authority contested. The row it requires is the one an earlier revision ' +
      'of this table omitted outright.',
  }),
  ]);
}

// ─── Helpers for the row table ───────────────────────────────────────────────

const authoritative = (id: RepresentationId): BoundaryRepresentation =>
  Object.freeze({ id, binding: Object.freeze({ kind: 'authoritative' }) });

const bound = (id: RepresentationId, boundTo: AuthorityId, how: string): BoundaryRepresentation =>
  Object.freeze({ id, binding: Object.freeze({ kind: 'bound', boundTo, how }) });

const unbound = (id: RepresentationId, why: string): BoundaryRepresentation =>
  Object.freeze({ id, binding: Object.freeze({ kind: 'unbound', why }) });

/**
 * The sdk-generation row's representations, read from the derivation bridge.
 *
 * Every generation is `authoritative`: each package root declares its own
 * `Transport`/protocol values and NEITHER is derived from the other. That is not
 * a stylistic call — the seam measured that TypeScript accepts every mixing
 * direction between them, so there is no compile-level binding to appeal to.
 */
const sdkRepresentations: readonly BoundaryRepresentation[] = Object.freeze(
  Object.values(SDK_GENERATION_REPRESENTATIONS).map(authoritative),
);

/**
 * The sdk-generation row's authority, computed rather than written: more than
 * one generation is a contest, exactly one is a resolved authority.
 */
function sdkAuthority(): BoundaryAuthority {
  const generations: readonly RepresentationId[] = Object.values(SDK_GENERATION_REPRESENTATIONS);
  const only = generations[0];
  if (generations.length === 1 && only !== undefined) {
    return Object.freeze({ kind: 'single', authority: only });
  }
  return Object.freeze({ kind: 'contested', candidates: Object.freeze([...generations]) });
}

// ─── The rows ────────────────────────────────────────────────────────────────
//
// The spec's authority-topology table, transcribed as data. Measured counts are
// the ones re-measured against the live tree on 2026-08-07; where a measurement
// disagreed with the spec's table, the row records what the tree actually says
// and the `measured` field names the difference.
//
// ## What is NOT derivable today, and why (the honest half)
//
// Four rows are `declared`, not `derived`. Each carries its own
// `whyNotDerivable`, but the shared reason is structural: a derivation bridge
// needs an upstream module that owns an ENUMERABLE domain whose members map onto
// boundaries or representations. Three of the four boundaries have no such
// domain — their representations are a handful of heterogeneous artifacts (a Zod
// schema field, a TypeScript wrapper type, a YAML file, an invariants-catalog
// paragraph, skill prose) with nothing enumerating them. The fourth,
// phase-sequencing, has a phase set but it is `ReadonlySet<string>` /
// `Record<string, …>` — keyed by bare `string`, so there is no union to be total
// over and no compile-time tooth to hang a bridge on.
//
// There is also a hard structural limit on how far this module may go: the DR-1
// declaration-seam census in `layer-boundaries-seam.ts` FAILS any module that
// imports the declaration contract and a declaration STORAGE module together.
// This module imports the contract, so it may never import `registry.ts` — the
// store that would let it enumerate action descriptors, CLI verbs or event rows
// directly. Enumerating those live is correctly task 025's job (a source scan,
// not an import), and this table names the representation CLASS instead of
// re-listing members it cannot legally read.

/** Every boundary row, keyed by boundary. Total over {@link ContractBoundaryId}. */
export const AUTHORITY_TOPOLOGY: Readonly<Record<ContractBoundaryId, AuthorityTopologyRow>> =
  Object.freeze({
    'action-contract': Object.freeze({
      boundary: 'action-contract',
      authority: Object.freeze({ kind: 'single', authority: 'registry' }),
      representations: Object.freeze([
        authoritative('registry action descriptor (TOOL_REGISTRY)'),
        bound(
          'the 10 registry-derived consumers (tool list, dispatch table, CLI tree, schema export, docs, …)',
          'registry',
          'each consumer is a projection of the registry descriptor, regenerated from it rather than restated beside it',
        ),
      ]),
      enforceFrom: Object.freeze({
        kind: 'already-enforced',
        by:
          'the ActionId-scoped closure instrument (`src/contract/action-contract-closure.ts`), which ' +
          'reports omitted dimensions, orphan projections, and advertise/execute disagreement against ' +
          'the declared contract',
      }),
      provenance: Object.freeze({ kind: 'derived', from: 'declaration-kinds' }),
      measured:
        'registry descriptor + 10 derived consumers; single authority HOLDS — the one row on this ' +
        'table that is already closed.',
    }),

    'cli-surface': Object.freeze({
      boundary: 'cli-surface',
      authority: Object.freeze({
        kind: 'contested',
        candidates: Object.freeze([
          'registry',
          'adapters/cli/cli.ts hand-written `.command()` literals',
        ]),
      }),
      representations: Object.freeze([
        authoritative('registry action descriptor (TOOL_REGISTRY)'),
        bound(
          'the registry-derived command tree',
          'registry',
          'commands are projected from the registry descriptors + CLI hints, so a registry change moves them',
        ),
        authoritative(
          "the 10 hand-written `.command('…')` literals in `adapters/cli/cli.ts`",
        ),
      ]),
      enforceFrom: Object.freeze({
        kind: 'wave',
        wave: 'wave-4',
        driver: 'DR-19 retires the last hand-written `.command()` literal',
      }),
      provenance: Object.freeze({ kind: 'derived', from: 'declaration-kinds' }),
      measured:
        'Re-measured 2026-08-08 (task 076): exactly 10 `.command(\'…\')` literals in ' +
        '`adapters/cli/cli.ts` — doctor, version, feedback, schema, topology, emissions, mcp, onboard, ' +
        'init, install-skills. Was ELEVEN until task 076 deleted the hand-written ' +
        '`merge-orchestrate` promotion and moved it onto the registry\'s `cli.topLevel` hint, ' +
        'where it is now a BOUND representation rather than a second authoritative one. The row ' +
        'stays CONTESTED: ten literals remain, each tracked debt with an owner and an enforced ' +
        'expiry under G1\'s allowlist. They are a SECOND authoritative representation: nothing ' +
        'derives them from the registry, and the registry does not derive them. DR-19 retires the ' +
        'last of them, at which point this row goes single-authority.',
    }),

    'response-shape': Object.freeze({
      boundary: 'response-shape',
      authority: Object.freeze({ kind: 'single', authority: 'outputSchema' }),
      representations: Object.freeze([
        authoritative('the action `outputSchema` declaration'),
        unbound(
          'Envelope<T>',
          'the wrapper type handlers return is written independently of `outputSchema`; neither is generated from the other',
        ),
        unbound(
          'the runtime response payload',
          'with 112 of 122 declared `outputSchema`s vacuous (they accept every value), the nominal ' +
            'authority constrains the payload for only 10 actions — for the other 112 the wire shape is ' +
            'bound by nothing at all',
        ),
      ]),
      enforceFrom: Object.freeze({
        kind: 'wave',
        wave: 'wave-1',
        driver: 'G2 is live immediately; DR-4 `architecture/output-schema-census.ts` is the instrument',
      }),
      provenance: Object.freeze({
        kind: 'declared',
        whyNotDerivable:
          'The three representations are a Zod schema field, a hand-written TypeScript wrapper type ' +
          'and the runtime payload. No module owns an enumerable domain over them, so there is no ' +
          'union to be total against. The COUNT is derivable (and was re-measured live via ' +
          '`censusOutputSchemas(TOOL_REGISTRY)`), but the row list is not.',
      }),
      measured:
        'Re-measured 2026-08-07 against the live registry: total=122, vacuous=112, substantive=10. ' +
        'Exactly matches the spec table.',
    }),

    'event-catalog': Object.freeze({
      boundary: 'event-catalog',
      authority: Object.freeze({ kind: 'single', authority: 'EVENT_EMISSION_REGISTRY' }),
      representations: Object.freeze([
        authoritative('EVENT_EMISSION_REGISTRY (`events/schemas.ts`)'),
        unbound(
          'the registry emission rows',
          'declared alongside the emission registry rather than projected from it — an action whose ' +
            'emission row drifts from what it actually emits is invisible to any shipped check',
        ),
        unbound(
          'PHASE_EXPECTED_EVENTS (`verbs/gates/check-event-emissions.ts`)',
          'only PARTIALLY bound, and the partial part is the trap: 2 of its 6 phase entries ' +
            '(`delegate`, `overhaul-delegate`) really are derived via ' +
            '`modelEmittedOnly(getRegisteredEventTypes(phase))`, but the other 4 (`review`, ' +
            '`overhaul-review`, `synthesize`, `overhaul-update-docs`) are hand-written literal arrays. ' +
            'The module-load loop only VALIDATES that each listed event exists and is `model`-sourced ' +
            '— it can never see an event that should be listed and is not. Validation of the entries ' +
            'present is not a binding over the population',
        ),
        unbound(
          'skill prose naming events to emit',
          'Markdown; nothing regenerates it from the registry and nothing fails when it drifts',
        ),
      ]),
      enforceFrom: Object.freeze({
        kind: 'wave',
        wave: 'wave-5',
        driver: 'DR-20 completes the event-catalog disposition',
      }),
      provenance: Object.freeze({ kind: 'derived', from: 'declaration-kinds' }),
      measured:
        'Nominally single-authority; NOT bound. Verified 2026-08-07 by reading ' +
        '`check-event-emissions.ts`: the compile-time loop at module load rejects a non-`model` event ' +
        'but has no completeness tooth.',
    }),

    'effect-event': Object.freeze({
      boundary: 'effect-event',
      // The plan’s declared emission set is the authority because the carrier
      // makes it one: a plan that declares an emission is refused the effect
      // outright without a sink, and reaches a committed value only on one
      // minted receipt per declared emission. The field is not a description of
      // what the owner intends to record — it is the precondition of the effect
      // happening at all, which is what an authority is.
      //
      // The TYPE on `EffectEmission.event` is deliberately NOT the reason. It
      // guarantees a plan cannot name an unregistered event, and that guarantee
      // belongs to the catalog and cannot fail here; resting the authority on it
      // would close the row on something no change to this boundary can falsify.
      authority: Object.freeze({ kind: 'single', authority: 'EffectPlan.emits' }),
      representations: Object.freeze([
        authoritative('EffectPlan `emits` (`dispatch/core/effect-carrier.ts`)'),
        bound(
          'the VCS ledger append site (`vcs/mutation-owner.ts`)',
          'EffectPlan.emits',
          'the sink is handed the plan’s emission and appends `emission.event`, so the name it records is computed from the plan and moves with it',
        ),
        unbound(
          'the promotion record sink (`install/atomic-promotion.ts`)',
          'the promoter owns the PAYLOAD and the caller owns the DESTINATION, so the sink discards ' +
            'the emission it is handed and passes a typed record to a caller-supplied callback. The ' +
            'commit gate still holds — a live promotion without a sink is refused — but a gate proves ' +
            'that some record was taken, never that it is the one the plan named',
        ),
      ]),
      enforceFrom: Object.freeze({
        kind: 'wave',
        wave: 'wave-2',
        driver:
          'DR-7 landed the EffectPlan ↔ event coupling and closed it for the ledger owner; the row ' +
          'closes when the promotion sink also names its record from the emission it is handed',
      }),
      provenance: Object.freeze({
        kind: 'declared',
        whyNotDerivable:
          'The representations are the carrier plus one sink per declaring owner, and no enumerable ' +
          'domain generates that set. `EffectClass` (`dispatch/core/effect-carrier.ts`) is a union, but it ' +
          'enumerates effect KINDS, not representations of this boundary. `emits` is REQUIRED on a plan ' +
          'now, which narrows the gap without closing it: every plan must say what records it, but a ' +
          'plan may still say `records-nothing`, and nothing enumerates the owners that build plans — ' +
          'so no type obliges an owner to appear here. Deriving the row from either would still be ' +
          'a fabricated bridge that reports a totality it does not have.',
      }),
      measured:
        'Single authority, PARTIALLY bound. Of the two owners that declare emissions on a plan, the ' +
        'ledger owner appends `emission.event` and follows the plan; the promoter hands its record ' +
        'to a caller-supplied destination and does not. Measured live rather than transcribed — see ' +
        'the oracle named on this row’s evidence.',
    }),

    'capability-posture': Object.freeze({
      boundary: 'capability-posture',
      authority: Object.freeze({ kind: 'single', authority: 'MCP handshake' }),
      representations: Object.freeze([
        authoritative('the MCP capability handshake (being deleted under DR-14)'),
        bound(
          'capabilities/posture-mapping.ts (POSTURE_CAPABILITY_MAP)',
          'MCP handshake',
          'the shipped posture→capability map the handshake advertises; total over `AgentPosture`, so it moves with the handshake',
        ),
        unbound(
          'agent-spec YAML',
          'hand-authored per agent; nothing regenerates it from the handshake or fails when it disagrees',
        ),
        unbound(
          'the INV-11 invariants-catalog text',
          'prose in `.exarchos/invariants.md`; no mechanical relationship to the handshake',
        ),
        unbound(
          'delegate skill prose',
          'Markdown under `content/`; restates posture rules a fourth time with no binding',
        ),
      ]),
      enforceFrom: Object.freeze({
        kind: 'wave',
        wave: 'wave-3',
        driver: 'DR-14 (the handshake, today’s authority, is itself being deleted)',
      }),
      provenance: Object.freeze({
        kind: 'declared',
        whyNotDerivable:
          'The five representations span a YAML file, a TypeScript map, a runtime protocol exchange ' +
          'and two prose documents. `AgentPosture` (`capabilities/posture-mapping.ts`) is enumerable, ' +
          'but its members are POSTURES, not representations of this boundary — a bridge over it would ' +
          'be totality theatre.',
      }),
      measured:
        'Partially bound: 1 of 4 non-authoritative representations is mechanically bound; the other ' +
        '3 are hand-authored. Matches the spec table’s "Partially".',
    }),

    'phase-sequencing': Object.freeze({
      boundary: 'phase-sequencing',
      authority: Object.freeze({ kind: 'single', authority: 'HSM guard (INV-9)' }),
      representations: Object.freeze([
        authoritative('the HSM phase topology / transition guard (INV-9)'),
        unbound(
          'PHASE_EXPECTED_EVENTS (`verbs/gates/check-event-emissions.ts`)',
          'typed `Readonly<Record<string, readonly EventType[]>>` — keyed by BARE STRING, with no ' +
            'relationship to the HSM phase set. A phase renamed or retired in the HSM leaves a dead key ' +
            'here that nothing reports. See the `measured` field: this contradicts the spec table',
        ),
        unbound(
          'the phase playbooks',
          'Markdown restating the phase order; no mechanical binding to the HSM topology',
        ),
      ]),
      enforceFrom: Object.freeze({
        kind: 'wave',
        wave: 'wave-1',
        driver: 'DR-6 lands the topology; the HSM guard is the authority it names',
      }),
      provenance: Object.freeze({
        kind: 'declared',
        whyNotDerivable:
          'There IS a phase set (`ALL_PHASES` in `registry.ts`), but it is `ReadonlySet<string>` and ' +
          '`PHASE_EXPECTED_EVENTS` is keyed by bare `string` — no union exists to be total over, so no ' +
          'compile-time bridge can be hung on it. Reading `registry.ts` is additionally forbidden here ' +
          'by the DR-1 declaration-seam census (see the note above this table).',
      }),
      measured:
        'DISAGREES WITH THE SPEC TABLE. The spec records phase-sequencing as "already single-authority ' +
        'on the landing branch". The HSM guard is indeed the single AUTHORITY, but the row is NOT ' +
        'closed: `PHASE_EXPECTED_EVENTS` is keyed by bare `string` and the playbooks are prose, so two ' +
        'representations are unbound. Recorded as measured rather than as the spec asserts.',
    }),

    'sdk-generation': Object.freeze({
      boundary: 'sdk-generation',
      authority: sdkAuthority(),
      representations: sdkRepresentations,
      enforceFrom: Object.freeze({
        kind: 'wave',
        wave: 'wave-4',
        driver: 'DR-26 introduces the single SDK seam',
      }),
      provenance: Object.freeze({ kind: 'derived', from: 'sdk-generations' }),
      measured:
        'Re-measured 2026-08-07 with the seam’s own classifier over tracked sources: 27 files / ' +
        '13 directories / 62 import specifiers. The 13 DIRECTORIES match the spec table; the spec’s ' +
        '"38 import sites" matches neither the file count (27) nor the specifier count (62). Sharper ' +
        'correction: the spec says both generations are "imported directly", but v2 has ZERO ' +
        'production import sites — every v2 specifier in the tree is fixture TEXT inside ' +
        '`sdk-generation-seam.test.ts`. Both generations are nonetheless INSTALLED and resolvable ' +
        '(`package.json` pins sdk@1.29.0 + core@2.0.0 + server@2.0.0), which is ' +
        'what keeps the protocol authority contested. Note `@modelcontextprotocol/client` is in the ' +
        'seam’s v2 package list but is NOT installed.',
    }),
  });

/** Every row, ordered by boundary id. The list form task 025's census ranges over. */
export function topologyRows(): readonly AuthorityTopologyRow[] {
  return Object.freeze(CONTRACT_BOUNDARIES.map((boundary) => AUTHORITY_TOPOLOGY[boundary]));
}

/** The representations of one row that claim to BE the authority. */
export function authoritativeRepresentations(
  row: AuthorityTopologyRow,
): readonly BoundaryRepresentation[] {
  return row.representations.filter((r) => r.binding.kind === 'authoritative');
}

/** The representations of one row that nothing binds — the G5 finding population. */
export function unboundRepresentations(
  row: AuthorityTopologyRow,
): readonly BoundaryRepresentation[] {
  return row.representations.filter((r) => r.binding.kind === 'unbound');
}

// ─── Totality (the data's own well-formedness check) ─────────────────────────
//
// NOT the closure census — that is task 025. This is the narrower claim that the
// TABLE is well-formed: every row is structurally complete, every row carries an
// `enforceFrom`, every derivation bridge's requirement is covered, and no row's
// provenance over-claims. A census over a malformed table would report findings
// about the table rather than about the tree.
//
// It takes `readonly unknown[]` on purpose, mirroring `contract/declaration.ts`'s
// `isDeclaration`: the type already makes a row without `enforceFrom`
// unrepresentable in typed code, and the compile-time proofs at the bottom of
// this file pin that. But a compile-time-only guarantee evaporates the moment the
// data crosses an `unknown` boundary — which is exactly what happens when task
// 025 loads rows from a relocated store or a JSON round-trip. Both halves have to
// hold, so the runtime half is checked here.

/** A totality failure class. */
export type TotalityCode =
  /** Zero rows. The instrument dying green is not a clean bill of health. */
  | 'EMPTY_TOPOLOGY'
  /** The value is not a structurally complete row. */
  | 'MALFORMED_ROW'
  /** `boundary` is not one of {@link CONTRACT_BOUNDARIES}. */
  | 'UNKNOWN_BOUNDARY'
  /** Two rows claim the same boundary. */
  | 'DUPLICATE_BOUNDARY'
  /** No (or ill-formed) `enforceFrom`. The rule with no blanket allowlist. */
  | 'MISSING_ENFORCE_FROM'
  /** `authority` absent, or `single` with no id, or `contested` with < 2 candidates. */
  | 'MALFORMED_AUTHORITY'
  /** No representations, or a representation with no id / no binding. */
  | 'MALFORMED_REPRESENTATIONS'
  /** The row's authority arm disagrees with its count of authoritative representations. */
  | 'AUTHORITY_REPRESENTATION_DISAGREEMENT'
  /** A derivation bridge requires a boundary no row covers — the missing-row tooth. */
  | 'MISSING_DERIVED_BOUNDARY'
  /** A row claims `derived` but no bridge requires it — stale cover. */
  | 'STALE_DERIVED_PROVENANCE'
  /** A hand-maintained row that never says why it could not be derived. */
  | 'UNJUSTIFIED_DECLARED_ROW';

export interface TotalityDiagnostic {
  readonly code: TotalityCode;
  /** The boundary at fault, or the row index when the boundary is unreadable. */
  readonly subject: string;
  readonly message: string;
}

export interface TotalityReport {
  readonly ok: boolean;
  readonly rowCount: number;
  readonly diagnostics: readonly TotalityDiagnostic[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isContractBoundaryId(value: unknown): value is ContractBoundaryId {
  return typeof value === 'string' && CONTRACT_BOUNDARIES.some((b) => b === value);
}

function isEnforcementWave(value: unknown): value is EnforcementWave {
  return typeof value === 'string' && ENFORCEMENT_WAVES.some((w) => w === value);
}

/** Structural guard for {@link EnforcementPoint}. */
export function isEnforcementPoint(value: unknown): value is EnforcementPoint {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'wave') {
    return isEnforcementWave(value['wave']) && isNonEmptyString(value['driver']);
  }
  if (value['kind'] === 'already-enforced') return isNonEmptyString(value['by']);
  return false;
}

/** Structural guard for {@link BoundaryAuthority}. */
export function isBoundaryAuthority(value: unknown): value is BoundaryAuthority {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'single') return isNonEmptyString(value['authority']);
  if (value['kind'] === 'contested') {
    const candidates: unknown = value['candidates'];
    if (!Array.isArray(candidates)) return false;
    const list: readonly unknown[] = candidates;
    return list.length >= 2 && list.every(isNonEmptyString);
  }
  if (value['kind'] === 'none') return isNonEmptyString(value['why']);
  return false;
}

function isRepresentationBinding(value: unknown): value is RepresentationBinding {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'authoritative') return true;
  if (value['kind'] === 'bound') {
    return isNonEmptyString(value['boundTo']) && isNonEmptyString(value['how']);
  }
  if (value['kind'] === 'unbound') return isNonEmptyString(value['why']);
  return false;
}

function isRepresentation(value: unknown): value is BoundaryRepresentation {
  return isRecord(value) && isNonEmptyString(value['id']) && isRepresentationBinding(value['binding']);
}

function isProvenance(value: unknown): value is RowProvenance {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'derived') {
    return typeof value['from'] === 'string' && DERIVATION_IDS.some((d) => d === value['from']);
  }
  if (value['kind'] === 'declared') return isNonEmptyString(value['whyNotDerivable']);
  return false;
}

/**
 * Structural guard for a row arriving from untyped input. Checks every field;
 * the payload semantics (does the wave claim hold? is the authority right?) are
 * the census's business, not the envelope's.
 */
export function isAuthorityTopologyRow(value: unknown): value is AuthorityTopologyRow {
  if (!isRecord(value)) return false;
  if (!isContractBoundaryId(value['boundary'])) return false;
  if (!isBoundaryAuthority(value['authority'])) return false;
  const representations: unknown = value['representations'];
  if (!Array.isArray(representations)) return false;
  const reps: readonly unknown[] = representations;
  if (reps.length === 0 || !reps.every(isRepresentation)) return false;
  if (!isEnforcementPoint(value['enforceFrom'])) return false;
  if (!isProvenance(value['provenance'])) return false;
  return isNonEmptyString(value['measured']);
}

/** The authority arm a row's representation counts imply. */
function impliedAuthorityKind(count: number): BoundaryAuthority['kind'] {
  if (count === 0) return 'none';
  if (count === 1) return 'single';
  return 'contested';
}

/**
 * Check the topology's own well-formedness. Pure, total, and FAIL-CLOSED on an
 * empty subject.
 *
 * The `AUTHORITY_REPRESENTATION_DISAGREEMENT` tooth is the one that carries G5's
 * sharpest clause into the data model: a row may not record `single` while
 * listing two authoritative representations. "More than one authoritative
 * representation is a finding regardless of whether the copies currently agree"
 * — so whether the copies agree never enters this computation. Only the count
 * does.
 *
 * Both parameters are required. `derivations` cannot default to the live bridge
 * table any more — that table now needs the upstream declaration kinds, which
 * only the composition root can supply — and defaulting `rows` alone while its
 * neighbour is required is not expressible. Making both explicit is the better
 * shape regardless: a census whose denominator arrives by default is one edit
 * away from silently ranging over nothing.
 *
 * @param rows - the rows to check. `unknown[]` so a row missing `enforceFrom`
 *   (unrepresentable in typed code) can still be fed in from a store or fixture.
 * @param derivations - the bridges whose required boundaries must be covered.
 */
export function checkTopologyTotality(
  rows: readonly unknown[],
  derivations: readonly BoundaryDerivation[],
): TotalityReport {
  const diagnostics: TotalityDiagnostic[] = [];

  if (rows.length === 0) {
    diagnostics.push({
      code: 'EMPTY_TOPOLOGY',
      subject: '<topology>',
      message:
        'the authority topology carries ZERO rows. A census over an empty table reports no findings ' +
        'and passes, which is the instrument silently dying green — not a closed tree. Fail closed.',
    });
  }

  const seen = new Set<string>();

  rows.forEach((value, index) => {
    const subject = isRecord(value) && isContractBoundaryId(value['boundary'])
      ? value['boundary']
      : `row[${index}]`;

    // `enforceFrom` is checked BEFORE the whole-row guard so a row that is
    // otherwise well-formed reports the specific missing field rather than a
    // generic malformation. There is no allowlist that skips this.
    if (!isRecord(value) || !isEnforcementPoint(value['enforceFrom'])) {
      diagnostics.push({
        code: 'MISSING_ENFORCE_FROM',
        subject,
        message:
          `boundary "${subject}" declares no usable \`enforceFrom\`. Every row must name the wave ` +
          'from which its single-authority rule is mechanically enforced, or name the shipped ' +
          'instrument already enforcing it. There is no blanket allowlist.',
      });
    }

    if (!isRecord(value)) {
      diagnostics.push({
        code: 'MALFORMED_ROW',
        subject,
        message: `row[${index}] is not an object and cannot be a boundary row`,
      });
      return;
    }

    if (!isContractBoundaryId(value['boundary'])) {
      diagnostics.push({
        code: 'UNKNOWN_BOUNDARY',
        subject,
        message:
          `row[${index}] names boundary ${JSON.stringify(value['boundary'])}, which is not one of ` +
          `[${CONTRACT_BOUNDARIES.join(', ')}]`,
      });
    } else if (seen.has(value['boundary'])) {
      diagnostics.push({
        code: 'DUPLICATE_BOUNDARY',
        subject,
        message:
          `boundary "${subject}" is claimed by more than one row — two rows for one boundary is two ` +
          'authorities wearing one name',
      });
    } else {
      seen.add(value['boundary']);
    }

    if (!isBoundaryAuthority(value['authority'])) {
      diagnostics.push({
        code: 'MALFORMED_AUTHORITY',
        subject,
        message:
          `boundary "${subject}" does not name exactly one authority, a contest of two or more, or ` +
          'an explicit `none`. Those three are the only well-formed states.',
      });
    }

    const representations: unknown = value['representations'];
    const repList: readonly unknown[] = Array.isArray(representations) ? representations : [];
    if (repList.length === 0 || !repList.every(isRepresentation)) {
      diagnostics.push({
        code: 'MALFORMED_REPRESENTATIONS',
        subject,
        message:
          `boundary "${subject}" carries no well-formed representations. A boundary with nothing to ` +
          'bind is not a boundary; every representation must state whether it is authoritative, ' +
          'bound (naming what binds it), or unbound (naming the gap).',
      });
    } else if (isBoundaryAuthority(value['authority'])) {
      const authoritativeCount = repList.filter(
        (r) => isRepresentation(r) && r.binding.kind === 'authoritative',
      ).length;
      const implied = impliedAuthorityKind(authoritativeCount);
      if (implied !== value['authority'].kind) {
        diagnostics.push({
          code: 'AUTHORITY_REPRESENTATION_DISAGREEMENT',
          subject,
          message:
            `boundary "${subject}" records authority "${value['authority'].kind}" but lists ` +
            `${authoritativeCount} authoritative representation(s), which implies "${implied}". More ` +
            'than one authoritative representation is a finding regardless of whether the copies ' +
            'currently agree — record it as `contested` rather than picking a winner.',
        });
      }
    }

    const provenance: unknown = value['provenance'];
    const boundary: unknown = value['boundary'];
    if (!isProvenance(provenance)) {
      diagnostics.push({
        code: 'UNJUSTIFIED_DECLARED_ROW',
        subject,
        message:
          `boundary "${subject}" declares no usable provenance. A hand-maintained row must state why ` +
          'it could not be derived from a live domain; a derived row must name its bridge.',
      });
    } else if (provenance.kind === 'derived' && isContractBoundaryId(boundary)) {
      const from = provenance.from;
      const bridge = derivations.find((d) => d.id === from);
      if (bridge === undefined || !bridge.requires.some((b) => b === boundary)) {
        diagnostics.push({
          code: 'STALE_DERIVED_PROVENANCE',
          subject,
          message:
            `boundary "${subject}" claims it was derived from "${from}", but that bridge does not ` +
            'require it. A derivation claim nothing produces is stale cover — the row is ' +
            'hand-maintained and must say so.',
        });
      }
    }
  });

  for (const derivation of derivations) {
    for (const required of derivation.requires) {
      if (!seen.has(required)) {
        diagnostics.push({
          code: 'MISSING_DERIVED_BOUNDARY',
          subject: required,
          message:
            `derivation "${derivation.id}" (${derivation.domain} in ${derivation.sourceModule}) requires ` +
            `a row for boundary "${required}", and the topology has none. A boundary absent from the ` +
            'topology is the one place an unbound representation can hide from the census designed to ' +
            'find it.',
        });
      }
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    rowCount: rows.length,
    diagnostics: Object.freeze(diagnostics),
  });
}

// ─── Compile-time proofs (the real gate is `tsc --noEmit`) ───────────────────
//
// Exported type aliases in a NON-TEST source file, per the `_Pola*` idiom in
// `capabilities/resolver.ts` and the proofs at the bottom of
// `contract/declaration.ts`: `tsconfig.json` excludes `**/*.test.ts`, so an
// assertion written in the test file would never be checked by the build.
//
// `[A] extends [B]` is tuple-wrapped throughout to suppress distribution over
// union members — without it a union `A` is checked member-by-member and a proof
// can report `true` for the wrong reason.

type Expect<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;
type NotAssignable<A, B> = [A] extends [B] ? false : true;

/** A well-formed row. The positive control for the proofs below. */
type WellFormedRow = {
  boundary: 'action-contract';
  authority: { kind: 'single'; authority: string };
  representations: readonly BoundaryRepresentation[];
  enforceFrom: { kind: 'wave'; wave: 'wave-1'; driver: string };
  provenance: { kind: 'declared'; whyNotDerivable: string };
  measured: string;
};

/**
 * Control: the well-formed row IS a row.
 * @proof
 */
export type _RowWellFormed_Compiles = Expect<Assignable<WellFormedRow, AuthorityTopologyRow>>;

/**
 * **The load-bearing proof.** A row without `enforceFrom` is NOT a row. Making
 * the field optional flips this to `false` and fails `tsc`, so "every boundary
 * names a wave" is a compiler guarantee, not a reviewer's promise. The runtime
 * half is `MISSING_ENFORCE_FROM` above; both are required.
 * @proof
 */
export type _RowMissingEnforceFrom_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedRow, 'enforceFrom'>, AuthorityTopologyRow>
>;

/**
 * A row without provenance is not a row — every row states derived or declared.
 * @proof
 */
export type _RowMissingProvenance_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedRow, 'provenance'>, AuthorityTopologyRow>
>;

/**
 * A row without representations is not a row — a boundary binds something.
 * @proof
 */
export type _RowMissingRepresentations_FailsCompile = Expect<
  NotAssignable<Omit<WellFormedRow, 'representations'>, AuthorityTopologyRow>
>;

/**
 * Authority is SINGULAR in the `single` arm. A row naming an ARRAY of
 * authorities does not typecheck, so the G5 "two authorities on one boundary"
 * defect cannot be smuggled into a resolved row — it must be declared
 * `contested`. Mirrors `_DeclarationPluralAuthority_FailsCompile`.
 * @proof
 */
export type _AuthorityPluralInSingleArm_FailsCompile = Expect<
  NotAssignable<{ kind: 'single'; authority: readonly string[] }, BoundaryAuthority>
>;

/**
 * A `declared` provenance without a rationale does not typecheck.
 * @proof
 */
export type _DeclaredProvenanceWithoutReason_FailsCompile = Expect<
  NotAssignable<{ kind: 'declared' }, RowProvenance>
>;

/**
 * A `bound` representation that does not name what binds it does not typecheck.
 * @proof
 */
export type _BoundRepresentationWithoutTarget_FailsCompile = Expect<
  NotAssignable<{ kind: 'bound'; how: string }, RepresentationBinding>
>;

/**
 * **The missing-boundary proof.** Every {@link DeclarationKind} maps to a
 * {@link ContractBoundaryId}, so the declaration-kind boundaries cannot be
 * dropped from {@link CONTRACT_BOUNDARIES} without breaking the compile. This is
 * the type-level half of the guarantee whose runtime half is
 * `MISSING_DERIVED_BOUNDARY`.
 * @proof
 */
export type _DeclarationKindBoundariesAreBoundaryIds = Expect<
  Assignable<(typeof DECLARATION_KIND_BOUNDARIES)[DeclarationKind], ContractBoundaryId>
>;

/**
 * Every SDK generation contributes a representation id — total over the seam's union.
 * @proof
 */
export type _SdkGenerationsAreTotal = Expect<
  Assignable<SdkGeneration, keyof typeof SDK_GENERATION_REPRESENTATIONS>
>;

/**
 * …and nothing outside the seam's union sits in the map.
 * @proof
 */
export type _SdkMapAddsNoGenerations = Expect<
  Assignable<keyof typeof SDK_GENERATION_REPRESENTATIONS, SdkGeneration>
>;

/**
 * The row table is TOTAL over the boundary domain — a boundary with no row fails `tsc`.
 * @proof
 */
export type _TopologyCoversEveryBoundary = Expect<
  Assignable<ContractBoundaryId, keyof typeof AUTHORITY_TOPOLOGY>
>;

/**
 * …and carries no row for a boundary outside the domain.
 * @proof
 */
export type _TopologyAddsNoBoundaries = Expect<
  Assignable<keyof typeof AUTHORITY_TOPOLOGY, ContractBoundaryId>
>;
