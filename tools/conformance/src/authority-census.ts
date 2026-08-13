// ─── The authority census (DR-6, gate G5) ────────────────────────────────────
//
// G5's policy, stated once: **every declared boundary names exactly one
// authority; every other representation names what binds it. An unbound
// representation, or more than one authority, fails closure.** More than one
// AUTHORITATIVE representation is a finding *regardless of whether the copies
// currently agree*.
//
// `architecture/authority-topology.ts` (task 024) is the MODEL — the eight
// boundary rows plus the table's own well-formedness check. It deliberately
// stopped short of the verdict, because a data model that also judged itself
// would be one authority pretending to be two. This module is that verdict.
//
// ## Not a new instrument — the same census, one level up
//
// The program's rule is *no new enforcement instrument*. This module introduces
// no scanner, no parser and no filesystem access; it is a pure evaluation over
// data, assembled from three shipped idioms:
//
//   • `contract/reachability/graph.ts` (P05-05) is the shape. Its
//     `evaluateClosure` resolves each subject along ordered HOPS, counts the
//     resolvers at each, and fails on `missing` (0) or `ambiguous` (>1); a
//     governed exemption that does not actually hold is `stale-exception`. G5 is
//     that rule lifted from per-action hops to per-boundary authorities, so this
//     module reuses the hop vocabulary rather than minting one — and its finding
//     kinds are literally {@link ClosureDiagnostic}['kind'], an IMPORTED type, so
//     "no novel error codes" is a compile-time fact and not a test's promise.
//   • `architecture/adapter-ownership-seam.ts` / `effect-port-seam.ts` supply the
//     TWO-WAY RATCHET: a declaration that over-claims is as much a finding as one
//     that under-claims (`STALE_ADAPTER_OWNER`, `STALE_EFFECT_PORT`). Here that is
//     a `bound` representation whose `boundTo` does not name its boundary's
//     authority — a binding claim pointing somewhere else is cover, not
//     derivation, and without this tooth `bound` degrades into a label anyone can
//     apply.
//   • `architecture/layer-boundaries-seam.ts` supplies the empty-denominator
//     posture (`EMPTY_SEAM_DENOMINATOR`): a census whose population is empty
//     reports no findings and passes, which is the instrument silently dying
//     green. Both denominators are checked here, not just the row count.
//
// ## Per-row enforcement, never wholesale
//
// Every row carries an `enforceFrom`, and a row's findings BLOCK only from the
// wave that remediates it. G5's own kill fixtures are rows whose authority is not
// remediated until Waves 2–5 (the CLI-surface row reaches one authority only at
// DR-19, the event catalog at DR-20, effect↔event at DR-7, capability at DR-14),
// so flipping everything at Wave 1 exit would red-line CI for four waves against
// subjects that do not exist yet. Findings are therefore always REPORTED and
// separately marked `blocking`; `atWave` decides which ones count.
//
// The one arm that blocks at every wave is `already-enforced`, because it is a
// claim about TODAY: "this boundary's single-authority rule is mechanically
// enforced right now, by the named instrument." A claim about today cannot be
// deferred to a later wave — it is either true now or it is stale now.
//
// ## What this census can and cannot see (stated, not smoothed over)
//
// The `authority` and `binding` hops resolve against the ROW's declaration. A row
// is a committed human measurement of the tree, not a live read, so those two hops
// are only as good as that measurement — which is precisely why task 026 exists
// (live proof on the CLI-surface and event-catalog rows) and why
// {@link BOUNDARY_HOP_EVIDENCE} records the evidence class of each hop as DATA
// rather than leaving the limitation in prose. The `enforcement` hop is the one
// resolved against an independent shipped module, and it is the hop that carries
// the sharpest finding on the live table.
//
// That evidence field is keyed by (hop, ROW), not by hop — see its own doc
// comment for why the hop-level shape task 025 shipped could not record what task
// 026 proved, and how the per-row shape makes an inherited evidence class
// unrepresentable rather than merely discouraged.
//
// A worked example of why "a check exists" is not a binding, and why this census
// must never accept one as such: `PHASE_EXPECTED_EVENTS`
// (`verbs/gates/check-event-emissions.ts`) is 2-of-6 derived and 4-of-6
// hand-written literals, and its module-load loop validates that every event it
// LISTS exists and is `model`-sourced. That loop can never see an event that
// should be listed and is not. Validation of the entries present is not a binding
// over the population — the same defect one level up is exactly what the
// `enforcement` hop's direction check below is for.
//
// ## No `as const`, deliberately
//
// The repo's census counts type assertions and `as const` is counted, so every
// tuple here carries an explicit `readonly [...]` annotation instead — the
// cast-free idiom `authority-topology.ts` and `contract/declaration.ts` use.
// ─────────────────────────────────────────────────────────────────────────────

import type { ClosureDiagnostic, HopStatus } from '../../../servers/exarchos-mcp/src/contract/reachability/graph.js';
import { BOUNDARY_DERIVATIONS } from './bindings/index.js';
import {
  CONTRACT_BOUNDARIES,
  ENFORCEMENT_WAVES,
  checkTopologyTotality,
  isAuthorityTopologyRow,
  topologyRows,
  type AuthorityTopologyRow,
  type BoundaryDerivation,
  type BoundaryRepresentation,
  type ContractBoundaryId,
  type EnforcementWave,
  type TotalityReport,
} from './authority-topology.js';

// ─── Hops ────────────────────────────────────────────────────────────────────

/**
 * The ordered hops a boundary is resolved along. G5 has exactly two clauses and
 * one claim-about-today, and each is a hop:
 *
 *   • `authority`   — "every declared boundary names exactly one authority".
 *                     `none` resolves 0 (missing); `contested` resolves ≥2
 *                     (ambiguous). The two arms of G5's second half.
 *   • `binding`     — "every other representation names what binds it". Resolved
 *                     once PER non-authoritative representation, so the finding
 *                     names the representation and not just the boundary.
 *   • `enforcement` — applicable only to a row claiming `already-enforced`: does
 *                     the named instrument exist, and does what it checks
 *                     actually discharge G5?
 */
export const CENSUS_HOPS: readonly ['authority', 'binding', 'enforcement'] = [
  'authority',
  'binding',
  'enforcement',
];

/** One of the hops in {@link CENSUS_HOPS}. */
export type CensusHop = (typeof CENSUS_HOPS)[number];

/** The evidence classes a (hop, row) may carry. */
export const EVIDENCE_CLASSES: readonly [
  'declared-row',
  'registered-instrument',
  'live-measurement',
  'not-applicable',
] = ['declared-row', 'registered-instrument', 'live-measurement', 'not-applicable'];

/**
 * The CLASS of evidence one hop of one row is resolved against.
 *
 *   • `declared-row`          — the row's own committed declaration.
 *   • `registered-instrument` — a shipped module in {@link ENFORCEMENT_INSTRUMENTS}.
 *   • `live-measurement`      — a shipped oracle that reads the tree NOW.
 *   • `not-applicable`        — the hop resolves nothing for this row, so it has
 *                               no evidence and must not borrow any. Checked
 *                               against the row rather than trusted.
 */
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** Is `value` one of {@link EVIDENCE_CLASSES}? */
export function isEvidenceClass(value: unknown): value is EvidenceClass {
  return typeof value === 'string' && EVIDENCE_CLASSES.some((c) => c === value);
}

/**
 * The witness a `live-measurement` claim must carry.
 *
 * Named parts rather than a free-text sentence, because each part is checkable:
 * the co-located live-proof test resolves `module`, asserts `entrypoint` is an
 * exported function of it, and compares `subjects` against the oracle's OWN
 * source list — so a row cannot claim a live measurement by describing one.
 */
export interface LiveOracle {
  /** The shipped module that performs the measurement, repo-relative. */
  readonly module: string;
  /** The exported entrypoint a reviewer runs to reproduce it. */
  readonly entrypoint: string;
  /** The tree paths it reads. Non-empty — a measurement over nothing is not one. */
  readonly subjects: readonly string[];
}

/**
 * One (hop, row) evidence entry, parameterised by the key it is filed under.
 *
 * `B` and `H` are the load-bearing parameters: an entry states its own boundary
 * and hop as LITERAL types, so the compiler rejects any entry sitting in a slot
 * it does not name. That is what makes an inherited evidence class
 * unrepresentable rather than merely discouraged.
 */
export type RowHopEvidence<B extends ContractBoundaryId, H extends CensusHop> =
  | {
      readonly boundary: B;
      readonly hop: H;
      readonly evidence: 'declared-row';
      /** What the row declares, and why that is all this hop has. */
      readonly why: string;
    }
  | {
      readonly boundary: B;
      readonly hop: H;
      readonly evidence: 'registered-instrument';
      /** An `id` of {@link ENFORCEMENT_INSTRUMENTS}; an unregistered one is a finding. */
      readonly instrument: string;
      readonly why: string;
    }
  | {
      readonly boundary: B;
      readonly hop: H;
      readonly evidence: 'live-measurement';
      readonly oracle: LiveOracle;
      readonly why: string;
    }
  | {
      readonly boundary: B;
      readonly hop: H;
      readonly evidence: 'not-applicable';
      /** Why the hop resolves nothing here — checked against the row. */
      readonly why: string;
    };

/**
 * An entry read back with its key widened. The READ side only: writes go through
 * {@link BoundaryHopEvidence}, where every slot still pins its own key, so this
 * alias cannot be used to file one row's evidence under another.
 */
export type AnyRowHopEvidence = RowHopEvidence<ContractBoundaryId, CensusHop>;

/** Every hop of one row. */
export type RowEvidence = Readonly<Record<CensusHop, AnyRowHopEvidence>>;

/**
 * The evidence table: total over `ContractBoundaryId × CensusHop`, with every
 * slot's type pinned to its own two keys.
 */
export type BoundaryHopEvidence = {
  readonly [B in ContractBoundaryId]: {
    readonly [H in CensusHop]: RowHopEvidence<B, H>;
  };
};

/**
 * Which evidence class resolves each hop of each boundary.
 *
 * Two rows carry `live-measurement` on `authority` and `binding` — the upgrade
 * task 026 earned and could not record. The other six carry `declared-row` there
 * and are not touched: they have no oracle, and this table has no way to lend
 * them one.
 */
export const BOUNDARY_HOP_EVIDENCE: BoundaryHopEvidence = Object.freeze({
  'action-contract': Object.freeze({
    authority: Object.freeze({
      boundary: 'action-contract',
      hop: 'authority',
      evidence: 'declared-row',
      why: 'the single `registry` authority is read off task 024\'s committed row; nothing in the tree rebuilds this row.',
    }),
    binding: Object.freeze({
      boundary: 'action-contract',
      hop: 'binding',
      evidence: 'declared-row',
      why: 'the "10 registry-derived consumers" representation is a committed count, not an enumeration this census can re-run.',
    }),
    enforcement: Object.freeze({
      boundary: 'action-contract',
      hop: 'enforcement',
      evidence: 'registered-instrument',
      instrument: 'p05-05-reachability-census',
      why: 'the only row claiming `already-enforced`; its claim resolves against the shipped P05-05 census, whose DIRECTION this module checks.',
    }),
  }),

  'capability-posture': Object.freeze({
    authority: Object.freeze({
      boundary: 'capability-posture',
      hop: 'authority',
      evidence: 'declared-row',
      why: 'the MCP handshake is named by the committed row; DR-14 is deleting it, and nothing measures it live today.',
    }),
    binding: Object.freeze({
      boundary: 'capability-posture',
      hop: 'binding',
      evidence: 'declared-row',
      why: 'the 1-of-4 bound count spans a YAML file, a TypeScript map and two prose documents — a committed reading, not an oracle.',
    }),
    enforcement: Object.freeze({
      boundary: 'capability-posture',
      hop: 'enforcement',
      evidence: 'not-applicable',
      why: 'the row enforces from wave-3 (DR-14), so it makes no `already-enforced` claim and the hop resolves nothing.',
    }),
  }),

  'cli-surface': Object.freeze({
    authority: Object.freeze({
      boundary: 'cli-surface',
      hop: 'authority',
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'servers/exarchos-mcp/scripts/authority-live-proof.ts',
        entrypoint: 'measureCliSurfaceLive',
        subjects: Object.freeze(['servers/exarchos-mcp/src/adapters/cli/cli.ts']),
      }),
      why: 'task 026 parses the governed composition root and classifies every `.command(…)` site, so the SECOND authoritative representation is counted from the tree rather than transcribed.',
    }),
    binding: Object.freeze({
      boundary: 'cli-surface',
      hop: 'binding',
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'servers/exarchos-mcp/scripts/authority-live-proof.ts',
        entrypoint: 'measureCliSurfaceLive',
        subjects: Object.freeze(['servers/exarchos-mcp/src/adapters/cli/cli.ts']),
      }),
      why: 'the same scan decides each representation\'s binding from its own site classification (all-derived is bound, anything else is not) — the binding claim is measured, not declared.',
    }),
    enforcement: Object.freeze({
      boundary: 'cli-surface',
      hop: 'enforcement',
      evidence: 'not-applicable',
      why: 'the row enforces from wave-4 (DR-19), so it makes no `already-enforced` claim and the hop resolves nothing.',
    }),
  }),

  'effect-event': Object.freeze({
    authority: Object.freeze({
      boundary: 'effect-event',
      hop: 'authority',
      evidence: 'declared-row',
      why: 'the `none` authority is a committed judgement that neither representation derives the other; no shipped module measures it.',
    }),
    binding: Object.freeze({
      boundary: 'effect-event',
      hop: 'binding',
      evidence: 'declared-row',
      why: 'both representations are declared unbound by the row; DR-7 is what will make the coupling mechanical and measurable.',
    }),
    enforcement: Object.freeze({
      boundary: 'effect-event',
      hop: 'enforcement',
      evidence: 'not-applicable',
      why: 'the row enforces from wave-2 (DR-7), so it makes no `already-enforced` claim and the hop resolves nothing.',
    }),
  }),

  'event-catalog': Object.freeze({
    authority: Object.freeze({
      boundary: 'event-catalog',
      hop: 'authority',
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'servers/exarchos-mcp/scripts/authority-live-proof.ts',
        entrypoint: 'measureEventCatalog',
        subjects: Object.freeze([
          'servers/exarchos-mcp/src/events/schemas.ts',
          // Added when task 011 landed. It derived `EVENT_EMISSION_REGISTRY` from the DR-2 tier
          // instead of hand-writing 170 values, so parsing `schemas.ts` for string-valued entries
          // measures a literal that no longer exists. The oracle now reads the tier/lifecycle facts
          // where they are DECLARED, and this subject list follows it — which is the whole point of
          // deriving the list from the oracle's own sources rather than restating it.
          'servers/exarchos-mcp/src/events/event-annotations.ts',
          'servers/exarchos-mcp/src/registry.ts',
          'servers/exarchos-mcp/src/verbs/gates/check-event-emissions.ts',
          'skills-src',
        ]),
      }),
      why: 'task 026 parses `EVENT_EMISSION_REGISTRY` from its own declaration, so the single authority is read off the tree rather than asserted.',
    }),
    binding: Object.freeze({
      boundary: 'event-catalog',
      hop: 'binding',
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'servers/exarchos-mcp/scripts/authority-live-proof.ts',
        entrypoint: 'measureEventCatalog',
        subjects: Object.freeze([
          'servers/exarchos-mcp/src/events/schemas.ts',
          // Added when task 011 landed. It derived `EVENT_EMISSION_REGISTRY` from the DR-2 tier
          // instead of hand-writing 170 values, so parsing `schemas.ts` for string-valued entries
          // measures a literal that no longer exists. The oracle now reads the tier/lifecycle facts
          // where they are DECLARED, and this subject list follows it — which is the whole point of
          // deriving the list from the oracle's own sources rather than restating it.
          'servers/exarchos-mcp/src/events/event-annotations.ts',
          'servers/exarchos-mcp/src/registry.ts',
          'servers/exarchos-mcp/src/verbs/gates/check-event-emissions.ts',
          'skills-src',
        ]),
      }),
      why: 'each of the three non-authoritative representations is classified from its own source — including the PARTIAL binding of `PHASE_EXPECTED_EVENTS` (2 of 6 entries derived), which is exactly the fact a transcribed row rounds off.',
    }),
    enforcement: Object.freeze({
      boundary: 'event-catalog',
      hop: 'enforcement',
      evidence: 'not-applicable',
      why: 'the row enforces from wave-5 (DR-20), so it makes no `already-enforced` claim and the hop resolves nothing.',
    }),
  }),

  'phase-sequencing': Object.freeze({
    authority: Object.freeze({
      boundary: 'phase-sequencing',
      hop: 'authority',
      evidence: 'declared-row',
      why: 'the HSM guard is named by the committed row; the DR-1 declaration seam forbids this module reading `registry.ts`, so no live read is available here.',
    }),
    binding: Object.freeze({
      boundary: 'phase-sequencing',
      hop: 'binding',
      evidence: 'declared-row',
      why: 'the two unbound representations are a committed reading — and this row is where the committed table already DISAGREES with the spec, which is what makes an eventual live proof worth having.',
    }),
    enforcement: Object.freeze({
      boundary: 'phase-sequencing',
      hop: 'enforcement',
      evidence: 'not-applicable',
      why: 'the row enforces from wave-1 (DR-6) as a `wave` claim, not an `already-enforced` one, so the hop resolves nothing.',
    }),
  }),

  'response-shape': Object.freeze({
    authority: Object.freeze({
      boundary: 'response-shape',
      hop: 'authority',
      evidence: 'declared-row',
      why: 'the `outputSchema` authority is committed. The row\'s vacuity COUNTS were re-measured live by DR-4\'s census, but no shipped oracle rebuilds this ROW, so the authority hop has a transcription and not a measurement.',
    }),
    binding: Object.freeze({
      boundary: 'response-shape',
      hop: 'binding',
      evidence: 'declared-row',
      why: '`Envelope<T>` and the runtime payload are declared unbound by the row; nothing re-derives that classification from source today.',
    }),
    enforcement: Object.freeze({
      boundary: 'response-shape',
      hop: 'enforcement',
      evidence: 'not-applicable',
      why: 'the row enforces from wave-1 (DR-4) as a `wave` claim, not an `already-enforced` one, so the hop resolves nothing.',
    }),
  }),

  'sdk-generation': Object.freeze({
    authority: Object.freeze({
      boundary: 'sdk-generation',
      hop: 'authority',
      evidence: 'declared-row',
      why: 'the contested authority is COMPUTED from the sdk-generation seam\'s domain, but by this table\'s own rule that is a derivation inside the row, not an oracle that reads the tree — so it stays `declared-row`.',
    }),
    binding: Object.freeze({
      boundary: 'sdk-generation',
      hop: 'binding',
      evidence: 'not-applicable',
      why: 'every representation on this row is authoritative, so the `binding` hop has an EMPTY population here and resolves nothing. Its silence is not evidence.',
    }),
    enforcement: Object.freeze({
      boundary: 'sdk-generation',
      hop: 'enforcement',
      evidence: 'not-applicable',
      why: 'the row enforces from wave-4 (DR-26), so it makes no `already-enforced` claim and the hop resolves nothing.',
    }),
  }),
});

/**
 * Every hop's evidence for one boundary. TOTAL: the parameter is the boundary
 * union and the table is a mapped type over it, so this lookup cannot miss and
 * has no default to fall back to.
 */
export function rowEvidence(boundary: ContractBoundaryId): RowEvidence {
  return BOUNDARY_HOP_EVIDENCE[boundary];
}

/** Boundaries carrying at least one `live-measurement` hop. */
export function liveMeasuredBoundaries(): readonly ContractBoundaryId[] {
  return Object.freeze(
    CONTRACT_BOUNDARIES.filter((b) =>
      CENSUS_HOPS.some((h) => BOUNDARY_HOP_EVIDENCE[b][h].evidence === 'live-measurement'),
    ),
  );
}
/**
 * A census finding's class.
 *
 * IMPORTED from the P05-05 census rather than declared, so this module cannot
 * introduce a novel error code even by accident: adding one would require
 * changing the reachability census's own vocabulary, which its co-located tests
 * pin. `missing` is G5's `none` arm and its unbound arm, `ambiguous` is the
 * `contested` arm, `stale-exception` is a governed claim that does not hold.
 */
export type CensusFindingKind = ClosureDiagnostic['kind'];

/** One hop's resolution for one subject, mirroring P05-05's `HopResolution`. */
export interface CensusHopResolution {
  readonly hop: CensusHop;
  /** The boundary (row-level hops) or the representation id (`binding`). */
  readonly subject: string;
  readonly applicable: boolean;
  readonly resolverCount: number;
  readonly status: HopStatus;
}

/** A closure failure that names the boundary, the hop and the subject. */
export interface CensusFinding {
  readonly boundary: ContractBoundaryId;
  readonly hop: CensusHop;
  readonly kind: CensusFindingKind;
  readonly subject: string;
  /** True when this row's `enforceFrom` has been reached at the census's wave. */
  readonly blocking: boolean;
  readonly message: string;
}

// ─── Enforcement instruments (the `already-enforced` corroboration) ──────────

/**
 * What DIRECTION an enforcement instrument actually checks.
 *
 * This is the load-bearing distinction, and it is the reason the arm is
 * falsifiable rather than decorative. G5 is a claim about a POPULATION — *every*
 * other representation names what binds it. An instrument that walks from the
 * authority outward proves that each authority entry resolves to exactly one
 * representation per hop; it can never see a representation that exists and is
 * bound to nothing, because such a representation is not in its denominator.
 *
 * That is the same shape as `PHASE_EXPECTED_EVENTS`' module-load loop one level
 * up: validation of the entries present is not a binding over the population.
 * So only `representation-to-authority` (or `both`) discharges G5.
 */
export type EnforcementDirection =
  /** Walks authority → representation. Cannot see an orphan representation. */
  | 'authority-to-representation'
  /** Walks representation → authority. Sees an orphan; this is what G5 needs. */
  | 'representation-to-authority'
  | 'both';

/**
 * A shipped instrument a row may name in its `already-enforced` claim.
 *
 * Registration is deliberately narrow: `marker` must appear in the row's `by`
 * text, so a claim naming nothing registered resolves to ZERO and fails at the
 * `enforcement` hop. "There is no blanket allowlist" is enforced by the registry
 * being a table of positive, checkable claims rather than a list of exemptions.
 */
export interface EnforcementInstrument {
  readonly id: string;
  /** The shipped module, so a reviewer can go and read it. */
  readonly module: string;
  /** Substring the row's `enforceFrom.by` must contain to name this instrument. */
  readonly marker: string;
  readonly direction: EnforcementDirection;
  /** Why the direction is what it says — the checkable part of the claim. */
  readonly why: string;
}

/**
 * Every instrument a row may currently name.
 *
 * One entry. The P05-05 reachability census is the only shipped instrument any
 * row claims today, and its direction is `authority-to-representation` as a
 * matter of construction, not opinion: `evaluateClosure` iterates
 * `inputs.actions` — the contract compiler's action list, i.e. the AUTHORITY —
 * and `resolveHops` filters every representation list BY the action it is
 * resolving. A route, handler, artifact or fixture entry belonging to no action
 * in that denominator is never looked at, so it can never be reported.
 *
 * That claim is not asserted here; the co-located test PROVES it by running the
 * shipped `evaluateClosure` over inputs carrying an orphan representation and
 * observing `ok === true`.
 */
export const ENFORCEMENT_INSTRUMENTS: readonly EnforcementInstrument[] = Object.freeze([
  Object.freeze({
    id: 'p05-05-reachability-census',
    module: 'contract/reachability/graph.ts',
    marker: 'contract/reachability/graph.ts',
    direction: 'authority-to-representation',
    why:
      '`evaluateClosure` iterates `inputs.actions` (the registry-derived authority) and resolves ' +
      'each action along seven hops; `resolveHops` filters schemas/routes/handlers/outputs/' +
      'artifacts/fixtures BY that action. A representation belonging to no action in the ' +
      'denominator is never enumerated, so an orphan representation — the exact thing G5 asks ' +
      'about — is invisible to it. It proves that every authority entry resolves, which is a ' +
      'necessary condition for closure and not a sufficient one.',
  }),
]);

/** Does this direction discharge G5's population claim? */
export function coversPopulation(direction: EnforcementDirection): boolean {
  return direction === 'representation-to-authority' || direction === 'both';
}

// ─── Report ──────────────────────────────────────────────────────────────────

/** One boundary's closure verdict. */
export interface BoundaryClosure {
  readonly boundary: ContractBoundaryId;
  /** Exactly one authority, nothing unbound, no stale claim. */
  readonly closed: boolean;
  /** True when this row's `enforceFrom` has been reached at the census's wave. */
  readonly enforced: boolean;
  readonly hops: readonly CensusHopResolution[];
  readonly findings: readonly CensusFinding[];
  /**
   * What class of evidence each hop of THIS row rests on — reported so a
   * reviewer reads the verdict and its assurance together. A total lookup into
   * {@link BOUNDARY_HOP_EVIDENCE}, never derived from the finding set.
   */
  readonly evidence: RowEvidence;
}

export interface AuthorityCensusReport {
  /** Green light: denominators non-empty, table well-formed, zero blocking findings. */
  readonly ok: boolean;
  /** The wave the census was evaluated at — what decides `blocking`. */
  readonly atWave: EnforcementWave;
  /** Rows handed in. The census's first denominator. */
  readonly rowCount: number;
  /** Rows that narrowed to a well-formed row. `< rowCount` means rows were dropped. */
  readonly evaluatedRows: number;
  /** Every representation across every evaluated row. */
  readonly representationCount: number;
  /**
   * Non-authoritative representations — the `binding` hop's actual population.
   * Zero means the hop ranged over nothing and its silence proves nothing.
   */
  readonly bindingSubjectCount: number;
  readonly boundaries: readonly BoundaryClosure[];
  readonly closedBoundaries: readonly ContractBoundaryId[];
  readonly openBoundaries: readonly ContractBoundaryId[];
  /** Every finding, blocking or not — the observe-only record. */
  readonly findings: readonly CensusFinding[];
  /** The subset whose row has reached its `enforceFrom`. */
  readonly blocking: readonly CensusFinding[];
  /** The table's own well-formedness, run first — a census over a malformed table
   *  would report findings about the table rather than about the tree. */
  readonly totality: TotalityReport;
}

export interface AuthorityCensusOptions {
  /** The overhaul wave to evaluate at. Defaults to the first wave (observe-only). */
  readonly atWave?: EnforcementWave;
  readonly derivations?: readonly BoundaryDerivation[];
  readonly instruments?: readonly EnforcementInstrument[];
}

// ─── Wave ordering ───────────────────────────────────────────────────────────

/** Position of a wave in {@link ENFORCEMENT_WAVES}; -1 for an unknown wave. */
export function waveIndex(wave: EnforcementWave): number {
  return ENFORCEMENT_WAVES.indexOf(wave);
}

/**
 * Is this row's `enforceFrom` reached at `atWave`?
 *
 * `already-enforced` is TRUE at every wave — it claims the boundary is enforced
 * today, and a claim about today cannot be scheduled for later.
 */
export function isEnforcedAt(row: AuthorityTopologyRow, atWave: EnforcementWave): boolean {
  if (row.enforceFrom.kind === 'already-enforced') return true;
  return waveIndex(row.enforceFrom.wave) <= waveIndex(atWave);
}

// ─── Hop resolution ──────────────────────────────────────────────────────────

function statusFor(applicable: boolean, count: number): HopStatus {
  if (!applicable) return 'not-applicable';
  if (count === 0) return 'missing';
  if (count > 1) return 'ambiguous';
  return 'ok';
}

/** Every authority id this row recognises — one for `single`, all for `contested`. */
export function declaredAuthorities(row: AuthorityTopologyRow): readonly string[] {
  if (row.authority.kind === 'single') return Object.freeze([row.authority.authority]);
  if (row.authority.kind === 'contested') return row.authority.candidates;
  return Object.freeze([]);
}

/** How many authorities the `authority` hop resolves for this row. */
function authorityResolverCount(row: AuthorityTopologyRow): number {
  return declaredAuthorities(row).length;
}

/** The representations the `binding` hop ranges over — everything not authoritative. */
export function bindingSubjects(row: AuthorityTopologyRow): readonly BoundaryRepresentation[] {
  return row.representations.filter((r) => r.binding.kind !== 'authoritative');
}

/** A `bound` representation resolves iff it names one of its row's authorities. */
function bindingResolverCount(row: AuthorityTopologyRow, rep: BoundaryRepresentation): number {
  if (rep.binding.kind !== 'bound') return 0;
  const boundTo: string = rep.binding.boundTo;
  return declaredAuthorities(row).some((a) => a === boundTo) ? 1 : 0;
}

/** Instruments whose marker appears in the row's `already-enforced` claim. */
export function matchingInstruments(
  claim: string,
  instruments: readonly EnforcementInstrument[],
): readonly EnforcementInstrument[] {
  return instruments.filter((i) => claim.includes(i.marker));
}

// ─── The census ──────────────────────────────────────────────────────────────

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function authorityFinding(row: AuthorityTopologyRow): CensusFinding | undefined {
  const count = authorityResolverCount(row);
  if (count === 1) return undefined;
  if (count === 0) {
    return {
      boundary: row.boundary,
      hop: 'authority',
      kind: 'missing',
      subject: row.boundary,
      blocking: false,
      message:
        `boundary "${row.boundary}" names NO authority — the ${row.representations.length} ` +
        'representations are governed by nothing, so there is no reference any of them could be ' +
        'bound to. G5 requires exactly one.',
    };
  }
  return {
    boundary: row.boundary,
    hop: 'authority',
    kind: 'ambiguous',
    subject: row.boundary,
    blocking: false,
    message:
      `boundary "${row.boundary}" names ${count} authorities ` +
      `[${declaredAuthorities(row).join(' | ')}] — more than one authority fails closure ` +
      'REGARDLESS of whether the copies currently agree. "They happen to match today" is not a ' +
      'binding; it is a coincidence with a maintenance bill.',
  };
}

function bindingFinding(
  row: AuthorityTopologyRow,
  rep: BoundaryRepresentation,
): CensusFinding | undefined {
  if (rep.binding.kind === 'unbound') {
    return {
      boundary: row.boundary,
      hop: 'binding',
      kind: 'missing',
      subject: rep.id,
      blocking: false,
      message:
        `representation "${rep.id}" of boundary "${row.boundary}" is bound by NOTHING: ` +
        `${rep.binding.why}. G5 requires every non-authoritative representation to name what ` +
        'derives it; a representation that merely agrees with the authority today, or that is ' +
        'only spot-VALIDATED against it, is unbound — validation catches a wrong entry but never ' +
        'a missing one.',
    };
  }
  if (rep.binding.kind === 'bound' && bindingResolverCount(row, rep) === 0) {
    return {
      boundary: row.boundary,
      hop: 'binding',
      kind: 'stale-exception',
      subject: rep.id,
      blocking: false,
      message:
        `representation "${rep.id}" of boundary "${row.boundary}" claims it is bound to ` +
        `"${rep.binding.boundTo}", which is not an authority this boundary declares ` +
        `[${declaredAuthorities(row).join(' | ') || '<none>'}]. A binding claim pointing ` +
        'somewhere other than the boundary\'s own authority is stale cover, not derivation — ' +
        'the same two-way ratchet as STALE_ADAPTER_OWNER / STALE_EFFECT_PORT.',
    };
  }
  return undefined;
}

function enforcementFinding(
  row: AuthorityTopologyRow,
  instruments: readonly EnforcementInstrument[],
): CensusFinding | undefined {
  if (row.enforceFrom.kind !== 'already-enforced') return undefined;
  const claim = row.enforceFrom.by;
  const matches = matchingInstruments(claim, instruments);

  if (matches.length === 0) {
    return {
      boundary: row.boundary,
      hop: 'enforcement',
      kind: 'missing',
      subject: claim,
      blocking: false,
      message:
        `boundary "${row.boundary}" claims it is ALREADY ENFORCED, but names no instrument ` +
        'registered in ENFORCEMENT_INSTRUMENTS. `already-enforced` is a positive, falsifiable ' +
        'claim that must name a shipped instrument a reviewer can go and check — an unregistered ' +
        'claim is the blanket exemption G5 forbids, wearing a name.',
    };
  }
  if (matches.length > 1) {
    return {
      boundary: row.boundary,
      hop: 'enforcement',
      kind: 'ambiguous',
      subject: claim,
      blocking: false,
      message:
        `boundary "${row.boundary}" names ${matches.length} registered instruments ` +
        `[${matches.map((m) => m.id).join(' | ')}] — which one enforces it? Two instruments for ` +
        'one enforcement claim is the same ambiguity a second authority is.',
    };
  }

  const only = matches[0];
  if (only === undefined || coversPopulation(only.direction)) return undefined;
  return {
    boundary: row.boundary,
    hop: 'enforcement',
    kind: 'stale-exception',
    subject: claim,
    blocking: false,
    message:
      `boundary "${row.boundary}" claims it is ALREADY ENFORCED by "${only.id}" ` +
      `(${only.module}), but that instrument checks "${only.direction}" only. ${only.why} ` +
      'G5 is a claim about the whole population of representations, so an instrument that ' +
      'cannot see an unbound representation does not discharge it. The exemption is STALE: the ' +
      'row must move to the wave that lands a representation-to-authority check.',
  };
}

/**
 * The cross-row tooth: one representation, two boundaries, two different binding
 * claims.
 *
 * `PHASE_EXPECTED_EVENTS` is carried by BOTH the event-catalog and the
 * phase-sequencing rows, so relabelling it on one row and not the other would
 * quietly launder a finding out of half the table while leaving every per-row
 * count intact. A representation that is `unbound` here and `bound` there
 * resolves to two incompatible answers — which is the `ambiguous` arm, at the
 * representation level instead of the boundary level.
 */
function crossRowFindings(rows: readonly AuthorityTopologyRow[]): readonly CensusFinding[] {
  const claimsById = new Map<string, Map<string, ContractBoundaryId[]>>();
  for (const row of rows) {
    for (const rep of row.representations) {
      const claim =
        rep.binding.kind === 'bound' ? `bound:${rep.binding.boundTo}` : rep.binding.kind;
      const byClaim = claimsById.get(rep.id) ?? new Map<string, ContractBoundaryId[]>();
      const carriers = byClaim.get(claim) ?? [];
      carriers.push(row.boundary);
      byClaim.set(claim, carriers);
      claimsById.set(rep.id, byClaim);
    }
  }

  const findings: CensusFinding[] = [];
  for (const [repId, byClaim] of claimsById) {
    if (byClaim.size < 2) continue;
    const claims = [...byClaim.keys()].sort(byString);
    for (const [claim, carriers] of byClaim) {
      for (const boundary of carriers) {
        findings.push({
          boundary,
          hop: 'binding',
          kind: 'ambiguous',
          subject: repId,
          blocking: false,
          message:
            `representation "${repId}" is carried by more than one boundary and makes ` +
            `${byClaim.size} DIFFERENT binding claims [${claims.join(' | ')}]; boundary ` +
            `"${boundary}" claims "${claim}". One representation cannot be derived and not ` +
            'derived at the same time — relabelling it on one row and not the other launders ' +
            'the finding out of half the table while every per-row count stays put.',
        });
      }
    }
  }
  return findings;
}

function withBlocking(finding: CensusFinding, blocking: boolean): CensusFinding {
  return { ...finding, blocking };
}

function sortFindings(findings: readonly CensusFinding[]): readonly CensusFinding[] {
  return [...findings].sort((a, b) =>
    byString(
      `${a.boundary} ${a.hop} ${a.subject} ${a.kind}`,
      `${b.boundary} ${b.hop} ${b.subject} ${b.kind}`,
    ),
  );
}

function hopsFor(
  row: AuthorityTopologyRow,
  instruments: readonly EnforcementInstrument[],
): readonly CensusHopResolution[] {
  const authorityCount = authorityResolverCount(row);
  const hops: CensusHopResolution[] = [
    {
      hop: 'authority',
      subject: row.boundary,
      applicable: true,
      resolverCount: authorityCount,
      status: statusFor(true, authorityCount),
    },
  ];

  for (const rep of bindingSubjects(row)) {
    const count = bindingResolverCount(row, rep);
    hops.push({
      hop: 'binding',
      subject: rep.id,
      applicable: true,
      resolverCount: count,
      status: statusFor(true, count),
    });
  }

  const applicable = row.enforceFrom.kind === 'already-enforced';
  const matchCount = applicable ? matchingInstruments(row.enforceFrom.by, instruments).length : 0;
  hops.push({
    hop: 'enforcement',
    subject: applicable ? row.enforceFrom.by : row.boundary,
    applicable,
    resolverCount: matchCount,
    status: statusFor(applicable, matchCount),
  });

  return hops;
}

/**
 * Evaluate G5 closure over the boundary rows. Pure, total and FAIL-CLOSED on an
 * empty subject.
 *
 * `ok` requires ALL of:
 *   • a non-empty row denominator — zero rows is the instrument dying green;
 *   • a non-empty representation denominator, AND a non-empty `binding`-hop
 *     population, because a hop that ranges over nothing proves nothing by
 *     staying silent;
 *   • every input row narrowing to a well-formed row, so a malformed row cannot
 *     be silently dropped from the denominator;
 *   • a well-formed table (`checkTopologyTotality`); and
 *   • zero BLOCKING findings at `atWave`.
 *
 * Findings before their row's `enforceFrom` are still reported — observe-only is
 * a recorded state, not silence.
 *
 * @param rows - `unknown[]` so a row the TYPE forbids (no `enforceFrom`, no
 *   representations) can be fed in from a store, a fixture or a JSON round trip.
 *   Mirrors `checkTopologyTotality`.
 */
export function runAuthorityCensus(
  rows: readonly unknown[] = topologyRows(),
  options: AuthorityCensusOptions = {},
): AuthorityCensusReport {
  const atWave: EnforcementWave = options.atWave ?? 'wave-1';
  const derivations = options.derivations ?? BOUNDARY_DERIVATIONS;
  const instruments = options.instruments ?? ENFORCEMENT_INSTRUMENTS;

  const totality = checkTopologyTotality(rows, derivations);
  const evaluated: AuthorityTopologyRow[] = [];
  for (const value of rows) {
    if (isAuthorityTopologyRow(value)) evaluated.push(value);
  }

  const crossRow = crossRowFindings(evaluated);
  const boundaries: BoundaryClosure[] = [];
  const findings: CensusFinding[] = [];
  let representationCount = 0;
  let bindingSubjectCount = 0;

  for (const row of evaluated) {
    const enforced = isEnforcedAt(row, atWave);
    const rowFindings: CensusFinding[] = [];

    const authority = authorityFinding(row);
    if (authority !== undefined) rowFindings.push(withBlocking(authority, enforced));

    for (const rep of bindingSubjects(row)) {
      const finding = bindingFinding(row, rep);
      if (finding !== undefined) rowFindings.push(withBlocking(finding, enforced));
    }

    const enforcement = enforcementFinding(row, instruments);
    if (enforcement !== undefined) rowFindings.push(withBlocking(enforcement, enforced));

    for (const finding of crossRow) {
      if (finding.boundary === row.boundary) rowFindings.push(withBlocking(finding, enforced));
    }

    representationCount += row.representations.length;
    bindingSubjectCount += bindingSubjects(row).length;

    const sorted = sortFindings(rowFindings);
    boundaries.push({
      boundary: row.boundary,
      closed: sorted.length === 0,
      enforced,
      hops: hopsFor(row, instruments),
      findings: sorted,
      evidence: rowEvidence(row.boundary),
    });
    findings.push(...sorted);
  }

  const allFindings = sortFindings(findings);
  const blocking = allFindings.filter((f) => f.blocking);
  const denominatorOk =
    rows.length > 0 &&
    evaluated.length === rows.length &&
    representationCount > 0 &&
    bindingSubjectCount > 0;

  return Object.freeze({
    ok: denominatorOk && totality.ok && blocking.length === 0,
    atWave,
    rowCount: rows.length,
    evaluatedRows: evaluated.length,
    representationCount,
    bindingSubjectCount,
    boundaries: Object.freeze(boundaries),
    closedBoundaries: Object.freeze(boundaries.filter((b) => b.closed).map((b) => b.boundary)),
    openBoundaries: Object.freeze(boundaries.filter((b) => !b.closed).map((b) => b.boundary)),
    findings: Object.freeze(allFindings),
    blocking: Object.freeze(blocking),
    totality,
  });
}

/**
 * A finding about the EVIDENCE TABLE rather than about the tree.
 *
 * Separate from {@link CensusFinding}, and deliberately not folded into
 * `runAuthorityCensus`'s finding list: those findings are the G5 verdict on the
 * boundaries, and mixing "this boundary is unbound" with "this table's evidence
 * is filed under the wrong key" would make the census's own count answer two
 * questions at once. `boundary`/`hop` are `string` because a corrupt table may
 * name a boundary or a hop that does not exist.
 */
export interface EvidenceFinding {
  readonly boundary: string;
  readonly hop: string;
  readonly kind: CensusFindingKind;
  readonly message: string;
}

export interface RowEvidenceReport {
  /** Non-empty denominators, and zero findings. */
  readonly ok: boolean;
  /** Boundaries the table covers. ZERO is the instrument dying green. */
  readonly rowCount: number;
  /** (hop, row) entries the table covers. ZERO is the instrument dying green. */
  readonly entryCount: number;
  /** Rows the cross-check ranged over. ZERO means the row half proved nothing. */
  readonly checkedRows: number;
  /** How many entries carry each class — the upgraded/not-upgraded split, counted. */
  readonly byClass: Readonly<Record<EvidenceClass, number>>;
  /** Boundaries with at least one `live-measurement` hop. */
  readonly liveMeasured: readonly string[];
  /** Boundaries with none — the six that must stay visibly weaker. */
  readonly declaredOnly: readonly string[];
  readonly findings: readonly EvidenceFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Is every element of `value` a non-empty string, with at least one element? */
function isNonEmptyStringList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/**
 * Which hops actually resolve something for this row — the fact the
 * `not-applicable` arm is checked against, read from the ROW rather than
 * restated. Mirrors {@link hopsFor}'s own applicability rules exactly.
 */
function applicableHops(row: AuthorityTopologyRow): Readonly<Record<CensusHop, boolean>> {
  return {
    authority: true,
    binding: bindingSubjects(row).length > 0,
    enforcement: row.enforceFrom.kind === 'already-enforced',
  };
}

function evidenceCellFindings(
  boundary: string,
  hop: string,
  cell: unknown,
  instruments: readonly EnforcementInstrument[],
): readonly EvidenceFinding[] {
  const findings: EvidenceFinding[] = [];
  if (!isRecord(cell)) {
    return [
      {
        boundary,
        hop,
        kind: 'missing',
        message:
          `evidence for (${boundary}, ${hop}) is absent. A hop with no stated evidence class is a ` +
          'hop whose assurance a reader must guess at — which is how a row-derived verdict comes ' +
          'to be read as a live one.',
      },
    ];
  }

  // The inheritance tooth, at runtime: an entry must NAME the slot it sits in.
  if (cell['boundary'] !== boundary) {
    findings.push({
      boundary,
      hop,
      kind: 'stale-exception',
      message:
        `evidence filed under boundary "${boundary}" names boundary ${JSON.stringify(cell['boundary'])}. ` +
        'An evidence entry belongs to exactly one row and cannot be inherited from another — a row ' +
        'with no measurement of its own does not acquire one by carrying a copy of a row that has.',
    });
  }
  if (cell['hop'] !== hop) {
    findings.push({
      boundary,
      hop,
      kind: 'stale-exception',
      message:
        `evidence filed under hop "${hop}" of boundary "${boundary}" names hop ` +
        `${JSON.stringify(cell['hop'])}. Evidence for one hop is not evidence for another.`,
    });
  }
  if (!isNonEmptyString(cell['why'])) {
    findings.push({
      boundary,
      hop,
      kind: 'missing',
      message:
        `evidence for (${boundary}, ${hop}) states no reason. The class alone is a label; the ` +
        'reason is what a reviewer checks it against.',
    });
  }

  const klass = cell['evidence'];
  if (!isEvidenceClass(klass)) {
    findings.push({
      boundary,
      hop,
      kind: 'missing',
      message:
        `evidence for (${boundary}, ${hop}) carries ${JSON.stringify(klass)}, which is not one of ` +
        `[${EVIDENCE_CLASSES.join(' | ')}].`,
    });
    return findings;
  }

  if (klass === 'registered-instrument') {
    const id = cell['instrument'];
    if (!instruments.some((i) => i.id === id)) {
      findings.push({
        boundary,
        hop,
        kind: 'missing',
        message:
          `(${boundary}, ${hop}) claims evidence from instrument ${JSON.stringify(id)}, which is ` +
          'not registered in ENFORCEMENT_INSTRUMENTS. An unregistered instrument is a name, not a ' +
          'module a reviewer can go and read.',
      });
    }
  }

  if (klass === 'live-measurement') {
    const oracle = cell['oracle'];
    const ok =
      isRecord(oracle) &&
      isNonEmptyString(oracle['module']) &&
      isNonEmptyString(oracle['entrypoint']) &&
      isNonEmptyStringList(oracle['subjects']);
    if (!ok) {
      findings.push({
        boundary,
        hop,
        kind: 'missing',
        message:
          `(${boundary}, ${hop}) claims a LIVE MEASUREMENT without a complete witness: it must name ` +
          'a module, an exported entrypoint, and at least one tree path the measurement reads. A ' +
          'live claim with an empty subject list is a measurement over nothing.',
      });
    }
  }

  return findings;
}

/**
 * Audit an evidence table against the boundary rows. Pure, total and FAIL-CLOSED
 * on an empty subject.
 *
 * `ok` requires ALL of: a non-empty boundary denominator; a non-empty (hop, row)
 * entry denominator; a non-empty ROW denominator for the applicability
 * cross-check; and zero findings.
 *
 * @param table - `unknown` so a table the TYPE forbids can be fed in from a
 *   fixture or a JSON round trip, exactly as `checkTopologyTotality` takes rows.
 */
export function auditRowEvidence(
  table: unknown = BOUNDARY_HOP_EVIDENCE,
  rows: readonly unknown[] = topologyRows(),
  instruments: readonly EnforcementInstrument[] = ENFORCEMENT_INSTRUMENTS,
): RowEvidenceReport {
  const findings: EvidenceFinding[] = [];
  const byClass: Record<EvidenceClass, number> = {
    'declared-row': 0,
    'registered-instrument': 0,
    'live-measurement': 0,
    'not-applicable': 0,
  };
  const liveMeasured: string[] = [];
  const declaredOnly: string[] = [];
  let rowCount = 0;
  let entryCount = 0;

  if (!isRecord(table)) {
    const notATable: EvidenceFinding = {
      boundary: '(table)',
      hop: '(table)',
      kind: 'missing',
      message:
        'the evidence table is not an object. A census that cannot read its own evidence map ' +
        'reports no findings and passes — the instrument dying green.',
    };
    return Object.freeze({
      ok: false,
      rowCount: 0,
      entryCount: 0,
      checkedRows: 0,
      byClass: Object.freeze(byClass),
      liveMeasured: Object.freeze([]),
      declaredOnly: Object.freeze([]),
      findings: Object.freeze([notATable]),
    });
  }

  for (const key of Object.keys(table)) {
    if (!CONTRACT_BOUNDARIES.some((b) => b === key)) {
      findings.push({
        boundary: key,
        hop: '(row)',
        kind: 'stale-exception',
        message:
          `the evidence table carries a row for "${key}", which is not a boundary the census ranges ` +
          'over. Evidence for a boundary that does not exist is evidence for nothing.',
      });
    }
  }

  for (const boundary of CONTRACT_BOUNDARIES) {
    const entry = table[boundary];
    if (!isRecord(entry)) {
      findings.push({
        boundary,
        hop: '(row)',
        kind: 'missing',
        message:
          `boundary "${boundary}" has no evidence entry. The table is total over the boundaries by ` +
          'construction; a gap here means it was assembled somewhere the compiler could not see.',
      });
      continue;
    }
    rowCount += 1;

    for (const key of Object.keys(entry)) {
      if (!CENSUS_HOPS.some((h) => h === key)) {
        findings.push({
          boundary,
          hop: key,
          kind: 'stale-exception',
          message:
            `boundary "${boundary}" declares evidence for hop "${key}", which the census does not ` +
            'run. Evidence for an unrun hop overstates what the census covers.',
        });
      }
    }

    let live = false;
    for (const hop of CENSUS_HOPS) {
      const cell = entry[hop];
      findings.push(...evidenceCellFindings(boundary, hop, cell, instruments));
      if (!isRecord(cell)) continue;
      entryCount += 1;
      const klass = cell['evidence'];
      if (isEvidenceClass(klass)) {
        byClass[klass] += 1;
        if (klass === 'live-measurement') live = true;
      }
    }
    (live ? liveMeasured : declaredOnly).push(boundary);
  }

  // ── The applicability cross-check: `not-applicable` is checked, not trusted ──
  // Two-way, like STALE_ADAPTER_OWNER: a hop that resolves nothing must say so,
  // and a hop that says so must actually resolve nothing.
  let checkedRows = 0;
  for (const value of rows) {
    if (!isAuthorityTopologyRow(value)) continue;
    checkedRows += 1;
    const entry = table[value.boundary];
    if (!isRecord(entry)) continue;
    const applicable = applicableHops(value);
    for (const hop of CENSUS_HOPS) {
      const cell = entry[hop];
      if (!isRecord(cell)) continue;
      const claimsNotApplicable = cell['evidence'] === 'not-applicable';
      if (applicable[hop] && claimsNotApplicable) {
        findings.push({
          boundary: value.boundary,
          hop,
          kind: 'stale-exception',
          message:
            `(${value.boundary}, ${hop}) claims the hop is NOT APPLICABLE, but the row makes it ` +
            'applicable — so the census resolves that hop and the table says it has no evidence to ' +
            'resolve it against. Stale, in the STALE_ADAPTER_OWNER sense.',
        });
      }
      if (!applicable[hop] && !claimsNotApplicable) {
        findings.push({
          boundary: value.boundary,
          hop,
          kind: 'stale-exception',
          message:
            `(${value.boundary}, ${hop}) claims evidence of class ${JSON.stringify(cell['evidence'])}, ` +
            'but the row makes that hop resolve NOTHING — an empty population, or an enforcement ' +
            'claim the row does not make. Evidence for a hop that never runs is an over-claim.',
        });
      }
    }
  }

  if (checkedRows === 0) {
    findings.push({
      boundary: '(rows)',
      hop: '(rows)',
      kind: 'missing',
      message:
        'the applicability cross-check ranged over ZERO rows, so every `not-applicable` claim in ' +
        'the table went unchecked. A hop that ranges over nothing proves nothing by staying silent.',
    });
  }
  if (entryCount === 0) {
    findings.push({
      boundary: '(table)',
      hop: '(table)',
      kind: 'missing',
      message:
        'the evidence table covers ZERO (hop, row) entries. An empty evidence map reports no ' +
        'findings and would otherwise pass clean.',
    });
  }

  return Object.freeze({
    ok: findings.length === 0 && rowCount > 0 && entryCount > 0 && checkedRows > 0,
    rowCount,
    entryCount,
    checkedRows,
    byClass: Object.freeze(byClass),
    liveMeasured: Object.freeze(liveMeasured),
    declaredOnly: Object.freeze(declaredOnly),
    findings: Object.freeze(findings),
  });
}
type Expect<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;
type NotAssignable<A, B> = [A] extends [B] ? false : true;

/**
 * **The no-novel-error-codes proof.** This census's finding kinds are exactly the
 * P05-05 census's diagnostic kinds, in both directions — so it cannot widen the
 * vocabulary, and cannot silently stop using part of it either. The spec's
 * `Census_ErrorVocabulary_MatchesExistingSeams` requirement, discharged by the
 * compiler rather than by a test that a future edit could delete.
 * @proof
 */
export type _CensusKindsAreReachabilityKinds = Expect<
  Assignable<CensusFindingKind, ClosureDiagnostic['kind']>
>;

/**
 * …and nothing in the reachability vocabulary is missing here.
 * @proof
 */
export type _ReachabilityKindsAreCensusKinds = Expect<
  Assignable<ClosureDiagnostic['kind'], CensusFindingKind>
>;

/**
 * Hop statuses are P05-05's, not a parallel union.
 * @proof
 */
export type _CensusHopStatusIsReachabilityHopStatus = Expect<
  Assignable<CensusHopResolution['status'], HopStatus>
>;

/**
 * **The evidence-totality proof.** {@link BOUNDARY_HOP_EVIDENCE} is total over
 * `ContractBoundaryId × CensusHop`, so a ninth boundary or a fourth hop is a
 * COMPILE error until its evidence is stated for every pair. P05-05's
 * `HOP_AUTHORITIES` totality, lifted from per-hop to per-(hop, row): neither a
 * hop nor a boundary can join the census without declaring what resolves it.
 @proof
 * */
export type _EveryBoundaryDeclaresItsEvidence = Expect<
  Assignable<ContractBoundaryId, keyof typeof BOUNDARY_HOP_EVIDENCE>
>;

/** …and no evidence row exists for a boundary the census does not range over. @proof
 * */
export type _EvidenceAddsNoBoundaries = Expect<
  Assignable<keyof typeof BOUNDARY_HOP_EVIDENCE, ContractBoundaryId>
>;
/**
 * **The evidence-class proof**, on the second axis. Every hop of every row is
 * stated, so a fourth hop is a COMPILE error until its evidence class is given
 * for each boundary. The analogue of P05-05's `HOP_AUTHORITIES` totality — a hop
 * cannot join the census without declaring what resolves it — lifted by task 066
 * from per-hop to per-(hop, row).
 * @proof
 */
export type _EveryHopDeclaresItsEvidence = Expect<
  Assignable<CensusHop, keyof (typeof BOUNDARY_HOP_EVIDENCE)['cli-surface']>
>;

/**
 * …and no evidence entry exists for a hop the census does not run.
 * @proof
 */
export type _EvidenceAddsNoHops = Expect<
  Assignable<keyof (typeof BOUNDARY_HOP_EVIDENCE)['cli-surface'], CensusHop>
>;

/**
 * **The inheritance proof — the kill fixture, discharged by the compiler.**
 *
 * The exact move task 066 exists to prevent: take the entry that DOES have a live
 * measurement (`cli-surface`/`authority`, upgraded by task 026) and file it under
 * a row that has none. It is rejected, because the entry's `boundary` is part of
 * its type and the slot's type pins that literal. No spread, no copy-paste and no
 * shared hop-level constant can move an evidence class from one row to another.
 @proof
 * */
export type _InheritedEvidence_FailsCompile = Expect<
  NotAssignable<
    {
      boundary: 'cli-surface';
      hop: 'authority';
      evidence: 'live-measurement';
      oracle: LiveOracle;
      why: string;
    },
    RowHopEvidence<'response-shape', 'authority'>
  >
>;

/**
 * The POSITIVE CONTROL for the proof above. Without it,
 * `_InheritedEvidence_FailsCompile` would also hold if `RowHopEvidence` were
 * mistyped such that NOTHING satisfies it — a rejection that proves nothing. The
 * same entry, filed under its own row, compiles.
 @proof
 * */
export type _OwnRowEvidence_Compiles = Expect<
  Assignable<
    {
      boundary: 'response-shape';
      hop: 'authority';
      evidence: 'declared-row';
      why: string;
    },
    RowHopEvidence<'response-shape', 'authority'>
  >
>;

/** The hop key is pinned the same way: one hop's evidence is not another's. @proof
 * */
export type _InheritedHopEvidence_FailsCompile = Expect<
  NotAssignable<
    {
      boundary: 'response-shape';
      hop: 'binding';
      evidence: 'declared-row';
      why: string;
    },
    RowHopEvidence<'response-shape', 'authority'>
  >
>;

/**
 * A `live-measurement` claim without its witness does not typecheck. The class is
 * not a label a row may simply assert — it costs a module, an entrypoint and the
 * paths the measurement reads.
 @proof
 * */
export type _LiveMeasurementWithoutOracle_FailsCompile = Expect<
  NotAssignable<
    { boundary: 'cli-surface'; hop: 'authority'; evidence: 'live-measurement'; why: string },
    RowHopEvidence<'cli-surface', 'authority'>
  >
>;
/**
 * An enforcement instrument must state its direction. A registration without one
 * does not typecheck, so "registered" can never come to mean "unexamined".
 * @proof
 */
export type _InstrumentWithoutDirection_FailsCompile = Expect<
  NotAssignable<
    { id: string; module: string; marker: string; why: string },
    EnforcementInstrument
  >
>;

/**
 * A finding must state its blocking status. Making the field optional would let
 * a finding default to non-blocking, which is exactly how per-row enforcement
 * degrades into no enforcement.
 * @proof
 */
export type _FindingWithoutBlocking_FailsCompile = Expect<
  NotAssignable<
    { boundary: ContractBoundaryId; hop: CensusHop; kind: CensusFindingKind; subject: string; message: string },
    CensusFinding
  >
>;
