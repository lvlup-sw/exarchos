// The authority census evaluates closure over the boundary rows of `authority-topology.ts`.
// Each declared boundary names exactly one authority, and each other representation names what
// binds it. An unbound representation, or more than one authority, fails closure, even when the
// copies agree today.
//
// The census is a pure evaluation over data, with no scanner, parser or filesystem access. Its
// finding kinds are the `ClosureDiagnostic['kind']` of `contract/reachability/graph.ts`, so it adds
// no error code. A `bound` claim must name an authority of its own boundary. An empty denominator fails.
//
// Each finding is reported, and it blocks only from the `enforceFrom` wave of its row.
// `already-enforced` blocks at every wave, because it is a claim about today. The `authority` and
// `binding` hops resolve against the committed row, so {@link BOUNDARY_HOP_EVIDENCE} records the
// evidence class of each hop of each row. Tuples carry explicit `readonly [...]` types, not
// `as const`, because the cast census counts `as const`.

import type { ClosureDiagnostic, HopStatus } from '../../../src/contract/reachability/graph.js';
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

/**
 * The ordered hops that resolve a boundary.
 * `authority`: the boundary names exactly one authority. `none` resolves 0 (missing), and `contested` resolves 2 or more (ambiguous).
 * `binding`: each non-authoritative representation names what binds it. The hop resolves once for each representation.
 * `enforcement`: for an `already-enforced` row only, the named instrument exists and its direction covers the population.
 */
export const CENSUS_HOPS: readonly ['authority', 'binding', 'enforcement'] = [
  'authority',
  'binding',
  'enforcement',
];

/** One of the hops in {@link CENSUS_HOPS}. */
export type CensusHop = (typeof CENSUS_HOPS)[number];

/** The evidence classes that a (hop, row) entry can carry. */
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
 * The witness that a `live-measurement` claim must carry.
 * The live-proof test resolves `module`, asserts that `entrypoint` is an exported function of it,
 * and compares `subjects` with the source list of the oracle. A row cannot claim a live measurement by describing one.
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
 * One (hop, row) evidence entry, with its key as type parameters.
 * The entry states its boundary `B` and hop `H` as literal types. The compiler then rejects an entry in a slot that it does not name.
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
      /** An `id` of {@link ENFORCEMENT_INSTRUMENTS}. An unregistered id is a finding. */
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
 * An entry read back with its key widened, for the read side only.
 * Writes go through {@link BoundaryHopEvidence}, where each slot pins its own key.
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
 * The evidence class that resolves each hop of each boundary.
 * A row with a live oracle carries `live-measurement` on `authority` and `binding`. The other rows carry `declared-row` there.
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
      instrument: 'action-contract-closure',
      why: 'the only row claiming `already-enforced`; its claim resolves against the ActionId-scoped closure instrument, whose DIRECTION this module checks.',
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
        module: 'tools/audit/core/authority-live-proof.ts',
        entrypoint: 'measureCliSurfaceLive',
        subjects: Object.freeze(['src/adapters/cli/cli.ts']),
      }),
      why: 'task 026 parses the governed composition root and classifies every `.command(…)` site, so the SECOND authoritative representation is counted from the tree rather than transcribed.',
    }),
    binding: Object.freeze({
      boundary: 'cli-surface',
      hop: 'binding',
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'tools/audit/core/authority-live-proof.ts',
        entrypoint: 'measureCliSurfaceLive',
        subjects: Object.freeze(['src/adapters/cli/cli.ts']),
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
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'tools/audit/core/authority-live-proof.ts',
        entrypoint: 'measureEffectEvent',
        subjects: Object.freeze([
          'src/dispatch/core/effect-carrier.ts',
          'src/vcs/mutation-owner.ts',
          'src/install/atomic-promotion.ts',
        ]),
      }),
      why: 'the oracle refuses to report at all unless the carrier still throws its unrecorded-emission error, so the single authority rests on the gate being in the tree rather than on the row asserting it.',
    }),
    binding: Object.freeze({
      boundary: 'effect-event',
      hop: 'binding',
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'tools/audit/core/authority-live-proof.ts',
        entrypoint: 'measureEffectEvent',
        subjects: Object.freeze([
          'src/dispatch/core/effect-carrier.ts',
          'src/vcs/mutation-owner.ts',
          'src/install/atomic-promotion.ts',
        ]),
      }),
      why: 'each declaring owner’s sink is classified from its own source by whether it names what it records off the emission it was handed — which is the fact that separates the ledger owner from the promoter, and exactly the fact a transcribed row rounds off.',
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
        module: 'tools/audit/core/authority-live-proof.ts',
        entrypoint: 'measureEventCatalog',
        subjects: Object.freeze([
          'src/events/schemas.ts',
          /** `EVENT_EMISSION_REGISTRY` derives from the tier, so the oracle reads the tier facts where they are declared. */
          'src/events/event-annotations.ts',
          'src/registry/actions',
          'src/workflow/topology/phase-events.ts',
          'content',
        ]),
      }),
      why: 'task 026 parses `EVENT_EMISSION_REGISTRY` from its own declaration, so the single authority is read off the tree rather than asserted.',
    }),
    binding: Object.freeze({
      boundary: 'event-catalog',
      hop: 'binding',
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'tools/audit/core/authority-live-proof.ts',
        entrypoint: 'measureEventCatalog',
        subjects: Object.freeze([
          'src/events/schemas.ts',
          /** `EVENT_EMISSION_REGISTRY` derives from the tier, so the oracle reads the tier facts where they are declared. */
          'src/events/event-annotations.ts',
          'src/registry/actions',
          'src/workflow/topology/phase-events.ts',
          'content',
        ]),
      }),
      why: 'each of the three non-authoritative representations is classified from its own source — including every declared row of `PHASE_EVENT_CONTRACTS`, whose event names are baked by design and validated at load, which is exactly the distinction a transcribed row rounds off.',
    }),
    enforcement: Object.freeze({
      boundary: 'event-catalog',
      hop: 'enforcement',
      evidence: 'not-applicable',
      why: 'the row enforces from wave-5 (DR-20), so it makes no `already-enforced` claim and the hop resolves nothing.',
    }),
  }),

  'phase-events': Object.freeze({
    authority: Object.freeze({
      boundary: 'phase-events',
      hop: 'authority',
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'tools/audit/core/authority-live-proof.ts',
        entrypoint: 'measurePhaseEvents',
        subjects: Object.freeze([
          'src/workflow/topology/phase-events.ts',
          'src/verbs/gates/check-event-emissions.ts',
          'src/workflow/playbooks.ts',
          'content/synthesis/skills/synthesize/SKILL.md',
          'content/delivery/skills/delegate/SKILL.md',
        ]),
      }),
      why: 'the contract is read from its own declaration — every row carrying a `type` and a `when` — so the single authority is measured off the tree, not asserted.',
    }),
    binding: Object.freeze({
      boundary: 'phase-events',
      hop: 'binding',
      evidence: 'live-measurement',
      oracle: Object.freeze({
        module: 'tools/audit/core/authority-live-proof.ts',
        entrypoint: 'measurePhaseEvents',
        subjects: Object.freeze([
          'src/workflow/topology/phase-events.ts',
          'src/verbs/gates/check-event-emissions.ts',
          'src/workflow/playbooks.ts',
          'content/synthesis/skills/synthesize/SKILL.md',
          'content/delivery/skills/delegate/SKILL.md',
        ]),
      }),
      why: 'the gate tables are classified by their exported initializers and every playbook `events` / `autoEmittedEvents` row by its initializer — computed from the contract or baked; the prose is counted, since Markdown carries no expressions.',
    }),
    enforcement: Object.freeze({
      boundary: 'phase-events',
      hop: 'enforcement',
      evidence: 'not-applicable',
      why: 'the row enforces from wave-5 as a `wave` claim — its prose representation is authored and only compared, so it makes no `already-enforced` claim — and the hop resolves nothing.',
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
 * Returns the evidence of each hop for one boundary.
 * The table is a mapped type over the boundary union, so this lookup cannot miss.
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
 * The class of a census finding. It is imported from the reachability census, so this module cannot add an error code.
 * `missing` is the `none` arm and the unbound arm. `ambiguous` is the `contested` arm.
 * `stale-exception` is a governed claim that does not hold.
 */
export type CensusFindingKind = ClosureDiagnostic['kind'];

/** The resolution of one hop for one subject, like `HopResolution` in the reachability census. */
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
  /** True when the census wave reaches the `enforceFrom` of this row. */
  readonly blocking: boolean;
  readonly message: string;
}

/**
 * The direction that an enforcement instrument checks.
 * The closure rule is a claim about a population: each other representation names what binds it.
 * `authority-to-representation` walks from the authority outward, so it cannot see an orphan representation.
 * `representation-to-authority` can see one, so only it or `both` discharges the closure rule.
 */
export type EnforcementDirection =
  | 'authority-to-representation'
  | 'representation-to-authority'
  | 'both';

/**
 * A shipped instrument that a row can name in its `already-enforced` claim.
 * The `by` text of the row must contain the `marker`. A claim that names no registered instrument
 * resolves to zero and fails at the `enforcement` hop.
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
 * The instruments that a row can name. They are not interchangeable.
 * The reachability census walks from each action in `inputs.actions` to its representations.
 * It never sees a representation that belongs to no action, so its direction is `authority-to-representation`.
 * The action-contract row names the ActionId-scoped closure instrument instead. That instrument walks
 * the projections, advertised copy and executed copy of each subject back to the declared contract.
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
  Object.freeze({
    id: 'action-contract-closure',
    module: 'src/contract/action-contract-closure.ts',
    marker: 'action-contract-closure.ts',
    direction: 'representation-to-authority',
    why:
      '`evaluateActionContractClosure` walks each ActionId subject\'s projections, advertised copy, ' +
      'and executed copy back to the declared contract and reports omitted dimensions, orphan ' +
      'projections, and advertise/execute disagreement. A representation with no declared contract ' +
      'is visible, which is the population walk G5 requires. The wiring census stays a separate ' +
      'instrument and does not close these gaps.',
  }),
]);

/** Tells if this direction discharges the population claim of the closure rule. */
export function coversPopulation(direction: EnforcementDirection): boolean {
  return direction === 'representation-to-authority' || direction === 'both';
}

/** One boundary's closure verdict. */
export interface BoundaryClosure {
  readonly boundary: ContractBoundaryId;
  /** Exactly one authority, nothing unbound, no stale claim. */
  readonly closed: boolean;
  /** True when the census wave reaches the `enforceFrom` of this row. */
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
  /** The well-formedness of the table, checked first. On a malformed table, the census reports on the table, not the tree. */
  readonly totality: TotalityReport;
}

export interface AuthorityCensusOptions {
  /** The overhaul wave to evaluate at. Defaults to the first wave (observe-only). */
  readonly atWave?: EnforcementWave;
  readonly derivations?: readonly BoundaryDerivation[];
  readonly instruments?: readonly EnforcementInstrument[];
}

/** Position of a wave in {@link ENFORCEMENT_WAVES}, or -1 for an unknown wave. */
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
 * Finds a representation that more than one boundary carries with different binding claims.
 * A relabel on one row only removes a finding from part of the table and keeps each per-row count.
 * Two incompatible answers for one representation are the `ambiguous` arm.
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
 * Evaluates closure over the boundary rows. It is pure and total, and fails closed on an empty subject.
 * `ok` needs non-empty row, representation and `binding` populations, and each input row well-formed.
 * It also needs a well-formed table (`checkTopologyTotality`) and zero blocking findings at `atWave`.
 * The census still reports a finding before the `enforceFrom` of its row.
 *
 * @param rows - `unknown[]`, so a row that the type forbids can come from a store, a fixture or a JSON round trip.
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
 * A finding about the evidence table, not about the tree.
 * It stays out of the finding list of `runAuthorityCensus`, so that count answers one question only.
 * `boundary` and `hop` are `string`, because a corrupt table can name a boundary or hop that does not exist.
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
  /** Boundaries with no `live-measurement` hop. */
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

/**
 * Returns the findings for one evidence cell.
 * An entry must name the boundary and hop of its own slot, so no row inherits the evidence of another.
 */
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
 * Audits an evidence table against the boundary rows. It is pure and total, and fails closed on an empty subject.
 * `ok` needs non-empty boundary, entry and row populations, and zero findings.
 * The applicability check is two-way. A hop that resolves nothing must claim `not-applicable`,
 * and a hop that claims it must resolve nothing.
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
 * The census finding kinds equal the reachability diagnostic kinds, in both directions.
 * The compiler, not a test, holds the `Census_ErrorVocabulary_MatchesExistingSeams` requirement.
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
 * The hop statuses are those of the reachability census, not a parallel union.
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
 * Every hop of every row is stated, so a new hop is a compile error until each boundary gives its evidence class.
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
 * The `cli-surface` `authority` entry has a live measurement. Filed under a row without one, it does not compile.
 * The `boundary` of an entry is part of its type, and the slot type pins that literal.
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
 * The positive control for the proof above. An entry filed under its own row compiles.
 * Without this control, a mistyped `RowHopEvidence` that nothing satisfies also passes the proof above.
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
 * A `live-measurement` claim without its witness does not typecheck.
 * The class costs a module, an entrypoint and the paths that the measurement reads.
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
 * A finding must state its blocking status. An optional field lets a finding default to non-blocking,
 * and per-row enforcement then becomes no enforcement.
 * @proof
 */
export type _FindingWithoutBlocking_FailsCompile = Expect<
  NotAssignable<
    { boundary: ContractBoundaryId; hop: CensusHop; kind: CensusFindingKind; subject: string; message: string },
    CensusFinding
  >
>;
