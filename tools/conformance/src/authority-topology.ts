// The authority topology as data, for gate G5. Every declared boundary names exactly one
// authority, and every other representation names what binds it. More than one authoritative
// representation is a finding, even when the copies agree today.
//
// This module holds the boundary rows and the totality check of the rows. It does not judge
// closure: `authority-census.ts` does that. A model that also judged itself is one authority
// that acts as two.
//
// A boundary that is absent from the topology can hide an unbound representation from the
// census. So {@link boundaryDerivations} forces a row for each boundary that an upstream domain
// requires. Tuples carry an explicit `readonly [...]` type, because the cast census counts `as const`.

import type {
  AuthorityId,
  DeclarationKind,
  RepresentationId,
} from '../../../src/contract/declaration.js';
import type { SdkGeneration } from '../../../src/architecture/sdk-generation-seam.js';

/**
 * Every contract boundary that G5 governs, in alphabetical order for a stable diff. The order has
 * no meaning. This tuple is the census denominator. The derivation bridges name four of these
 * ids, so the deletion of one of them breaks the compile at the bridge.
 */
export const CONTRACT_BOUNDARIES: readonly [
  'action-contract',
  'capability-posture',
  'cli-surface',
  'effect-event',
  'event-catalog',
  'phase-events',
  'phase-sequencing',
  'response-shape',
  'sdk-generation',
] = [
  'action-contract',
  'capability-posture',
  'cli-surface',
  'effect-event',
  'event-catalog',
  'phase-events',
  'phase-sequencing',
  'response-shape',
  'sdk-generation',
];

/** One boundary in {@link CONTRACT_BOUNDARIES}. */
export type ContractBoundaryId = (typeof CONTRACT_BOUNDARIES)[number];

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
 * The point from which the mechanical enforcement of the single-authority rule of a boundary starts.
 * Every row must have one, or {@link checkTopologyTotality} fails. There is no blanket allowlist.
 * The `already-enforced` arm is not an exemption. It names the shipped instrument, so a reviewer
 * can check the claim.
 */
export type EnforcementPoint =
  | {
      readonly kind: 'wave';
      readonly wave: EnforcementWave;
      /** The change that lands the enforcement, so a reviewer can check the wave claim. */
      readonly driver: string;
    }
  | {
      readonly kind: 'already-enforced';
      /** The shipped instrument that enforces it TODAY. Named, not asserted. */
      readonly by: string;
    };

/**
 * The authority of a boundary, in one of three states. The `single` arm carries one
 * {@link AuthorityId}, never an array. So a row with two authorities must declare `contested`,
 * and the defect cannot stay unnamed.
 */
export type BoundaryAuthority =
  | { readonly kind: 'single'; readonly authority: AuthorityId }
  | {
      readonly kind: 'contested';
      /** The competing authorities. Two or more, by definition. */
      readonly candidates: readonly AuthorityId[];
    }
  | { readonly kind: 'none'; readonly why: string };

/**
 * How a representation relates to the authority of its boundary. `authoritative` is the
 * authority, and two on one row is the G5 finding. `bound` is mechanically derived from
 * `boundTo`, and `how` names the derivation. `unbound` has no derivation, and `why` states the gap.
 * A representation that only agrees with the authority, or only gets validation against it, is
 * `unbound`. Validation catches a wrong entry, but not a missing entry.
 */
export type RepresentationBinding =
  | { readonly kind: 'authoritative' }
  | { readonly kind: 'bound'; readonly boundTo: AuthorityId; readonly how: string }
  | { readonly kind: 'unbound'; readonly why: string };

/** One representation of a boundary, and what (if anything) binds it. */
export interface BoundaryRepresentation {
  readonly id: RepresentationId;
  readonly binding: RepresentationBinding;
}

/** The derivation bridges that force boundaries to exist. */
export const DERIVATION_IDS: readonly ['declaration-kinds', 'sdk-generations'] = [
  'declaration-kinds',
  'sdk-generations',
];

/** One of the bridges in {@link DERIVATION_IDS}. */
export type DerivationId = (typeof DERIVATION_IDS)[number];

/**
 * The origin of a row. {@link checkTopologyTotality} checks both arms. A `derived` row that its
 * bridge does not require is `STALE_DERIVED_PROVENANCE`. A `declared` row with no reason is
 * `UNJUSTIFIED_DECLARED_ROW`.
 */
export type RowProvenance =
  | { readonly kind: 'derived'; readonly from: DerivationId }
  | {
      readonly kind: 'declared';
      /** Why this boundary cannot be derived from a live domain TODAY. Required. */
      readonly whyNotDerivable: string;
    };

/**
 * The authority topology of one boundary, and the unit that the census ranges over. Closure is
 * a pure function of `authority` and `representations`. `enforceFrom` tells if the census
 * enforces a break now or later. No field needs a filesystem read.
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

/**
 * A boundary domain that another module owns, and the boundaries that it forces this table to
 * carry. This bridge stops a boundary from going missing.
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
 * Each declaration kind, mapped to the boundary that its declarations cross. The map is total
 * over {@link DeclarationKind}, so a new kind upstream is a compile error here until its boundary
 * has a name.
 */
export const DECLARATION_KIND_BOUNDARIES: Readonly<Record<DeclarationKind, ContractBoundaryId>> =
  Object.freeze({
    action: 'action-contract',
    'cli-verb': 'cli-surface',
    event: 'event-catalog',
  });

/**
 * Each MCP SDK generation, mapped to the representation that it contributes. The map is total
 * over {@link SdkGeneration}, so a third generation upstream is a compile error here.
 * The sdk-generation row computes its authority from the size of this map. When one generation
 * remains, the row stops reporting `contested` with no edit.
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
 * Every declared derivation bridge. The declaration kinds arrive as a parameter, because
 * conformance code must not reach into the tree that it inspects. The composition root supplies the
 * real `DECLARATION_KINDS`. The keys of {@link DECLARATION_KIND_BOUNDARIES} are not a substitute,
 * because then the table checks itself.
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

const authoritative = (id: RepresentationId): BoundaryRepresentation =>
  Object.freeze({ id, binding: Object.freeze({ kind: 'authoritative' }) });

const bound = (id: RepresentationId, boundTo: AuthorityId, how: string): BoundaryRepresentation =>
  Object.freeze({ id, binding: Object.freeze({ kind: 'bound', boundTo, how }) });

const unbound = (id: RepresentationId, why: string): BoundaryRepresentation =>
  Object.freeze({ id, binding: Object.freeze({ kind: 'unbound', why }) });

/**
 * The representations of the sdk-generation row, read from the derivation bridge. Every
 * generation is `authoritative`. Each package root declares its own `Transport` and protocol
 * values, and neither derives from the other. The seam measured that TypeScript accepts every
 * mix of the two, so no compile-level binding exists.
 */
const sdkRepresentations: readonly BoundaryRepresentation[] = Object.freeze(
  Object.values(SDK_GENERATION_REPRESENTATIONS).map(authoritative),
);

/**
 * The authority of the sdk-generation row, computed and not written. More than one generation is
 * a contest. Exactly one generation is a resolved authority.
 */
function sdkAuthority(): BoundaryAuthority {
  const generations: readonly RepresentationId[] = Object.values(SDK_GENERATION_REPRESENTATIONS);
  const only = generations[0];
  if (generations.length === 1 && only !== undefined) {
    return Object.freeze({ kind: 'single', authority: only });
  }
  return Object.freeze({ kind: 'contested', candidates: Object.freeze([...generations]) });
}

/**
 * Every boundary row, keyed by boundary. Total over {@link ContractBoundaryId}. When a live
 * measurement disagrees with the spec table, the row records the tree, and `measured` names the
 * difference. A `declared` row has no upstream domain whose members map onto its
 * representations, and `whyNotDerivable` says why. This module imports the declaration contract,
 * so the declaration-seam census forbids an import of `registry.ts`. So a row names a
 * representation class, not the members that this module cannot read.
 */
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
          'the PHASE_EVENT_CONTRACTS rows (`workflow/topology/phase-events.ts`)',
          'the contract DECLARES which phase expects which event — a workflow fact the registry ' +
            'does not hold — so every row is validated against the registry at load (registered, ' +
            '`model`-sourced for an expectation, `auto`-sourced for a disclosure) and none is ' +
            'computed from it. Validation of the rows present is not a binding over the population',
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
        'Nominally single-authority; NOT bound. Re-measured 2026-09-07: the gate table that used to ' +
        'be half-derived is now computed from `PHASE_EVENT_CONTRACTS` (the `phase-events` row), and ' +
        'the contract itself is where the phase → event facts are declared — validated against the ' +
        'registry at load, never computed from it.',
    }),

    'phase-events': Object.freeze({
      boundary: 'phase-events',
      authority: Object.freeze({
        kind: 'single',
        authority: 'PHASE_EVENT_CONTRACTS (`workflow/topology/phase-events.ts`)',
      }),
      representations: Object.freeze([
        authoritative('PHASE_EVENT_CONTRACTS (`workflow/topology/phase-events.ts`)'),
        bound(
          'the gate tables `PHASE_EXPECTED_EVENTS` and `EVENT_DESCRIPTIONS` (`verbs/gates/check-event-emissions.ts`)',
          'PHASE_EVENT_CONTRACTS (`workflow/topology/phase-events.ts`)',
          'both tables are computed from the contract at load — `expectedEventsByPhase` and ' +
            '`hintDescriptions` — and the gate module holds no phase or event literal of its own',
        ),
        bound(
          'the playbook `events` and `autoEmittedEvents` rows (`workflow/playbooks.ts`)',
          'PHASE_EVENT_CONTRACTS (`workflow/topology/phase-events.ts`)',
          'every playbook row is `phaseEventInstructions(phase)` or `phaseRuntimeEmissions(phase)` ' +
            'over the contract; the per-phase arrays and the delegate metadata maps are gone',
        ),
        unbound(
          'the skill passages that say what the gate checks',
          'Markdown; the checked-by line and the delegate table are compared to the contract by ' +
            '`tests/architecture/skill-prose-gate-row-agreement.test.ts`, so drift fails, but nothing ' +
            'computes them — the renderer may not import `workflow/`',
        ),
      ]),
      enforceFrom: Object.freeze({
        kind: 'wave',
        wave: 'wave-5',
        driver:
          'the prose representation is authored and only compared (the renderer may not import ' +
          '`workflow/`), so the row cannot claim `already-enforced`; it enforces with the ' +
          'event-catalog disposition. The derived surfaces are live-measured by `measurePhaseEvents` today',
      }),
      provenance: Object.freeze({
        kind: 'declared',
        whyNotDerivable:
          'the representations are two derived tables, per-playbook rows and Markdown; no module ' +
          'enumerates them as a domain to be total over.',
      }),
      measured:
        'Measured 2026-09-07 at the slice that introduced the contract, replacing four copies that ' +
        'disagreed (the review playbook instructed `review.completed`, which nothing emitted; four ' +
        'playbooks instructed runtime-owned events). Gate tables 2/2 initializers computed, every ' +
        'playbook row computed, prose authored and comparator-pinned. Open on prose only.',
    }),

    'effect-event': Object.freeze({
      boundary: 'effect-event',
      /**
       * The declared emission set is the authority, because the carrier makes it one. The carrier
       * refuses the effect to a plan that declares an emission and has no sink. The plan commits
       * only with one minted receipt for each declared emission. The type on
       * `EffectEmission.event` is not the reason: that guarantee belongs to the catalog and
       * cannot fail at this boundary.
       */
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
          'the PHASE_EVENT_CONTRACTS rows (`workflow/topology/phase-events.ts`)',
          'keyed by BARE STRING. A key that names no built-in HSM state now throws when ' +
            '`state-machine.ts` loads, so a renamed or retired phase can no longer leave a dead row — ' +
            'but the keys are authored, not computed from the phase set, and a load-time check is ' +
            'not a binding. See the `measured` field: this contradicts the spec table',
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
          '`PHASE_EVENT_CONTRACTS` is keyed by bare `string` — no union exists to be total over, so no ' +
          'compile-time bridge can be hung on it. Reading `registry.ts` is additionally forbidden here ' +
          'by the DR-1 declaration-seam census (see the note above this table).',
      }),
      measured:
        'DISAGREES WITH THE SPEC TABLE. The spec records phase-sequencing as "already single-authority ' +
        'on the landing branch". The HSM guard is indeed the single AUTHORITY, but the row is NOT ' +
        'closed: `PHASE_EVENT_CONTRACTS` is keyed by bare `string` (a dead key throws at load since ' +
        '2026-09-07, which is a check, not a binding) and the playbooks are prose, so two ' +
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

/** Every row, in the order of {@link CONTRACT_BOUNDARIES}. The census ranges over this list. */
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

/**
 * A totality failure class. Most names state the fault. `EMPTY_TOPOLOGY` fails closed on zero rows.
 *
 * `AUTHORITY_REPRESENTATION_DISAGREEMENT`: the authority arm does not match the count of
 * authoritative representations. `MISSING_DERIVED_BOUNDARY`: a bridge requires a boundary that no
 * row covers. `STALE_DERIVED_PROVENANCE`: a row claims `derived`, but its bridge does not require
 * it. `UNJUSTIFIED_DECLARED_ROW`: the row has no usable provenance.
 */
export type TotalityCode =
  | 'EMPTY_TOPOLOGY'
  | 'MALFORMED_ROW'
  | 'UNKNOWN_BOUNDARY'
  | 'DUPLICATE_BOUNDARY'
  | 'MISSING_ENFORCE_FROM'
  | 'MALFORMED_AUTHORITY'
  | 'MALFORMED_REPRESENTATIONS'
  | 'AUTHORITY_REPRESENTATION_DISAGREEMENT'
  | 'MISSING_DERIVED_BOUNDARY'
  | 'STALE_DERIVED_PROVENANCE'
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
 * Structural guard for a row from untyped input. It checks every field. The census, not this
 * guard, judges if the wave claim holds or the authority is right.
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
 * Checks that the topology table is well-formed. Pure, total, and fail-closed on an empty subject.
 * The authority arm of a row must match its count of authoritative representations, whether or
 * not the copies agree. The check reads `enforceFrom` before the whole-row guard, so the
 * diagnostic names the missing field.
 *
 * @param rows - the rows to check. `unknown[]`, so a store or a fixture can supply a row with no
 *   `enforceFrom`, which typed code cannot represent.
 * @param derivations - the bridges whose required boundaries must have a row. It has no default,
 *   so the census denominator never arrives by default.
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

/**
 * The compile-time proofs below. `tsc --noEmit` is the real gate, and the tsconfig excludes test
 * files, so the proofs live in this source file. `[A] extends [B]` wraps both sides in a tuple to
 * stop distribution over a union, which can report `true` for the wrong reason.
 */
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
 * A row without `enforceFrom` is not a row. If the field becomes optional, this proof fails `tsc`.
 * `MISSING_ENFORCE_FROM` is the runtime half, and both halves are necessary.
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
 * The `single` arm holds one authority. An array of authorities does not typecheck, so a row with
 * two authorities must declare `contested`.
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
 * Every {@link DeclarationKind} maps to a {@link ContractBoundaryId}. So a declaration-kind
 * boundary cannot leave {@link CONTRACT_BOUNDARIES} without a compile error. The runtime half is
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
