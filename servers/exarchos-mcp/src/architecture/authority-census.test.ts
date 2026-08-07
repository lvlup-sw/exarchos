// ─── The authority census (DR-6, G5) — co-located tests ──────────────────────
//
// Scope note: these tests pin the CLOSURE VERDICT — the mechanism by which an
// unbound representation or a second authority fails, per row, from the wave that
// remediates it. Proving the failure fires live against the real CLI-surface and
// event-catalog subjects is task 026.
//
// @oracle-sources: ./authority-topology.ts, ../contract/reachability/graph.ts
//
// The two authorities are genuinely independent, in both the static and the
// semantic sense. `authority-topology.ts`'s entire transitive import closure is
// {contract/declaration.ts, architecture/sdk-generation-seam.ts,
// review/check-catalog.ts, sdk/brand.ts} and `contract/reachability/graph.ts`'s
// is {contract/authority-digest.ts, contract/request-context.ts, …}; neither is
// reachable from the other, so the module graph agrees they are two. Semantically
// they are a committed human judgement about the tree (the rows) and a shipped
// executable census (P05-05) — and the central finding below is precisely a
// DISAGREEMENT between them: the `action-contract` row claims P05-05 enforces it,
// and running P05-05 shows it cannot.
import { describe, it, expect } from 'vitest';
import {
  evaluateClosure,
  type ReachabilityInputs,
} from '../contract/reachability/graph.js';
import {
  ENFORCEMENT_WAVES,
  topologyRows,
  type AuthorityTopologyRow,
  type BoundaryRepresentation,
  type EnforcementWave,
} from './authority-topology.js';
import {
  CENSUS_HOPS,
  ENFORCEMENT_INSTRUMENTS,
  HOP_EVIDENCE,
  bindingSubjects,
  coversPopulation,
  declaredAuthorities,
  isEnforcedAt,
  matchingInstruments,
  runAuthorityCensus,
  waveIndex,
  type AuthorityCensusReport,
  type CensusFinding,
  type EnforcementInstrument,
} from './authority-census.js';

// ════════════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════════════

/** A representation that IS the authority. */
const authoritative = (id: string): BoundaryRepresentation => ({
  id,
  binding: { kind: 'authoritative' },
});

/** A representation mechanically derived from `boundTo`. */
const bound = (id: string, boundTo: string): BoundaryRepresentation => ({
  id,
  binding: { kind: 'bound', boundTo, how: 'regenerated from the authority on every build' },
});

/** A representation nothing derives — the G5 finding population. */
const unbound = (id: string): BoundaryRepresentation => ({
  id,
  binding: { kind: 'unbound', why: 'nothing derives it and nothing fails when it drifts' },
});

/**
 * A structurally well-formed row, so every failure below is attributable to the
 * property under test rather than to a junk fixture. `boundary` reuses real
 * boundary ids because {@link runAuthorityCensus} narrows through
 * `isAuthorityTopologyRow`, which rejects an unknown boundary.
 */
function row(overrides: Partial<AuthorityTopologyRow> = {}): AuthorityTopologyRow {
  return {
    boundary: 'response-shape',
    authority: { kind: 'single', authority: 'the-authority' },
    representations: [authoritative('the authority itself'), bound('a derived view', 'the-authority')],
    enforceFrom: { kind: 'wave', wave: 'wave-1', driver: 'DR-6 fixture driver' },
    provenance: { kind: 'declared', whyNotDerivable: 'a fixture, not a live boundary' },
    measured: 'fixture row',
    ...overrides,
  };
}

/** Fixtures never exercise the derivation bridges — those are 024's tooth. */
function census(
  rows: readonly unknown[],
  atWave: EnforcementWave = 'wave-1',
  instruments: readonly EnforcementInstrument[] = ENFORCEMENT_INSTRUMENTS,
): AuthorityCensusReport {
  return runAuthorityCensus(rows, { atWave, derivations: [], instruments });
}

/** A finding as a comparable tuple — boundary, hop, kind, subject. */
const tupleOf = (f: CensusFinding): string => `${f.boundary} | ${f.hop} | ${f.kind} | ${f.subject}`;
const tuplesOf = (report: AuthorityCensusReport): readonly string[] =>
  report.findings.map(tupleOf);

// ════════════════════════════════════════════════════════════════════════════
// The four required properties
// ════════════════════════════════════════════════════════════════════════════

describe('authority census — closure', () => {
  it('AuthorityCensus_UnboundRepresentation_FailsClosure', () => {
    // G5's second clause: every non-authoritative representation names what
    // binds it. One that names nothing fails closure — the count of unbound
    // representations, not whether they currently agree with the authority.
    const report = census([
      row({
        representations: [
          authoritative('the authority itself'),
          bound('a derived view', 'the-authority'),
          unbound('a hand-authored copy'),
        ],
      }),
    ]);

    expect(report.ok).toBe(false);
    expect(report.openBoundaries).toEqual(['response-shape']);
    expect(report.closedBoundaries).toEqual([]);
    expect(tuplesOf(report)).toEqual([
      'response-shape | binding | missing | a hand-authored copy',
    ]);
    // The row's `enforceFrom` is wave-1 and the census runs at wave-1, so the
    // finding counts rather than merely being recorded.
    expect(report.blocking.map(tupleOf)).toEqual([
      'response-shape | binding | missing | a hand-authored copy',
    ]);

    // Control: the SAME row with that representation bound to the authority
    // passes clean, so the failure is attributable to the missing binding and
    // not to the fixture. This is also the kill seam — flip `unbound` to
    // `bound` and the verdict moves.
    const control = census([
      row({
        representations: [
          authoritative('the authority itself'),
          bound('a derived view', 'the-authority'),
          bound('a hand-authored copy', 'the-authority'),
        ],
      }),
    ]);
    expect(control.ok).toBe(true);
    expect(control.findings).toEqual([]);
    expect(control.closedBoundaries).toEqual(['response-shape']);
  });

  it('AuthorityCensus_TwoAuthoritativeRepresentations_FailsClosure', () => {
    // G5's sharpest clause. Note what the census does NOT consult: whether the
    // two representations agree. Only the count of authorities does, which is
    // what makes "they happen to match today" unable to buy a pass.
    const declaredContest = census([
      row({
        authority: { kind: 'contested', candidates: ['the-authority', 'the-second-authority'] },
        representations: [
          authoritative('the authority itself'),
          authoritative('a second, independently maintained copy'),
          bound('a derived view', 'the-authority'),
        ],
      }),
    ]);

    expect(declaredContest.ok).toBe(false);
    expect(tuplesOf(declaredContest)).toEqual([
      'response-shape | authority | ambiguous | response-shape',
    ]);
    // The message states the clause, so a reader of CI output learns WHY two
    // agreeing copies are still a finding.
    expect(declaredContest.findings[0]?.message).toContain('REGARDLESS');

    // The other half: a row that lists the same two authoritative
    // representations while RECORDING a single authority does not escape.
    // 024's table-level tooth catches the lie, and the census fails with it —
    // so neither "declare the contest" nor "hide the contest" passes.
    const hiddenContest = census([
      row({
        authority: { kind: 'single', authority: 'the-authority' },
        representations: [
          authoritative('the authority itself'),
          authoritative('a second, independently maintained copy'),
          bound('a derived view', 'the-authority'),
        ],
      }),
    ]);
    expect(hiddenContest.ok).toBe(false);
    expect(hiddenContest.totality.ok).toBe(false);
    expect(hiddenContest.totality.diagnostics.map((d) => d.code)).toContain(
      'AUTHORITY_REPRESENTATION_DISAGREEMENT',
    );

    // Control: exactly one authority over the same shape passes.
    expect(census([row()]).ok).toBe(true);
  });

  it('AuthorityCensus_ZeroRowsEnumerated_FailsClosed', () => {
    // A census over an empty population reports no findings and passes — the
    // instrument silently dying green. Three separate ways the denominator can
    // be empty, all of which must fail rather than read as a clean bill.
    const noRows = census([]);
    expect(noRows.ok).toBe(false);
    expect(noRows.rowCount).toBe(0);
    expect(noRows.findings).toEqual([]); // it is the SILENCE that is the defect
    expect(noRows.totality.diagnostics.map((d) => d.code)).toContain('EMPTY_TOPOLOGY');

    // A row carrying no representations at all. Unrepresentable in typed code,
    // which is why the census accepts `unknown[]`.
    const noRepresentations = census([{ ...row(), representations: [] }]);
    expect(noRepresentations.ok).toBe(false);
    expect(noRepresentations.representationCount).toBe(0);
    expect(noRepresentations.totality.diagnostics.map((d) => d.code)).toContain(
      'MALFORMED_REPRESENTATIONS',
    );

    // And the subtler one: rows and representations exist, but EVERY
    // representation is the authority itself, so the `binding` hop ranged over
    // nothing. A hop that examined zero subjects has not cleared them.
    const noBindingSubjects = census([
      row({ representations: [authoritative('the authority itself')] }),
    ]);
    expect(noBindingSubjects.ok).toBe(false);
    expect(noBindingSubjects.representationCount).toBe(1);
    expect(noBindingSubjects.bindingSubjectCount).toBe(0);
    expect(noBindingSubjects.findings).toEqual([]);

    // Control: one binding subject is enough to make the hop's silence mean
    // something, and the same row then passes.
    expect(census([row()]).bindingSubjectCount).toBe(1);
    expect(census([row()]).ok).toBe(true);
  });

  it('AuthorityCensus_RowBeforeItsEnforceFromWave_DoesNotBlock', () => {
    // Per-row enforcement, not wholesale. G5's own kill fixtures are rows whose
    // authority is not remediated until Waves 2–5; flipping everything at Wave 1
    // exit would red-line CI for four waves against subjects that do not exist
    // yet. So a finding is always REPORTED and separately marked.
    const wave4Row = row({
      boundary: 'cli-surface',
      enforceFrom: { kind: 'wave', wave: 'wave-4', driver: 'DR-19 retires the last literal' },
      representations: [authoritative('the authority itself'), unbound('a hand-authored copy')],
    });

    const early = census([wave4Row], 'wave-1');
    expect(early.findings.map(tupleOf)).toEqual([
      'cli-surface | binding | missing | a hand-authored copy',
    ]);
    expect(early.blocking).toEqual([]);
    expect(early.boundaries[0]?.enforced).toBe(false);
    // The finding is on the record; it just does not count yet.
    expect(early.ok).toBe(true);
    expect(early.openBoundaries).toEqual(['cli-surface']);

    // Observe-only is a recorded, EXPIRING state. At the remediating wave the
    // identical finding counts, and every later wave keeps counting it.
    for (const wave of ['wave-4', 'wave-5'] satisfies readonly EnforcementWave[]) {
      const late = census([wave4Row], wave);
      expect(late.blocking.map(tupleOf)).toEqual([
        'cli-surface | binding | missing | a hand-authored copy',
      ]);
      expect(late.boundaries[0]?.enforced).toBe(true);
      expect(late.ok).toBe(false);
    }

    // …and the boundary between the two is exactly `enforceFrom`, not one wave
    // either side of it.
    expect(census([wave4Row], 'wave-3').ok).toBe(true);
    expect(census([wave4Row], 'wave-4').ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The `already-enforced` arm — a positive claim, corroborated against the
// instrument it names
// ════════════════════════════════════════════════════════════════════════════

describe('authority census — the enforcement hop', () => {
  it('ReachabilityCensus_OrphanRepresentation_ResolvesCleanAndProvesTheDirection', () => {
    // The corroboration, run rather than asserted. `ENFORCEMENT_INSTRUMENTS`
    // classifies the P05-05 census as `authority-to-representation`; a
    // classification nobody checks is precisely the "measure the wrong property"
    // pattern this program exists to remove. So: build a fully closed input,
    // then add a whole action's worth of representations (route, handler,
    // artifact, fixture) belonging to an action that is NOT in the denominator.
    const closed: ReachabilityInputs = {
      surfaceVersion: 'authority-census-probe',
      actions: [{ actionId: 'tool.act', tool: 'tool', action: 'act', mutates: false }],
      schemas: [{ actionId: 'tool.act' }],
      routes: [{ actionId: 'tool.act', tool: 'tool' }],
      handlers: [{ tool: 'tool' }],
      owners: [],
      outputs: [{ actionId: 'tool.act', outputKinds: ['data'], errorCodes: ['E_X'] }],
      artifacts: [{ actionId: 'tool.act' }],
      fixtures: [{ actionId: 'tool.act' }],
    };
    expect(evaluateClosure(closed).ok).toBe(true);

    const withOrphans: ReachabilityInputs = {
      ...closed,
      routes: [...closed.routes, { actionId: 'ghost.act', tool: 'ghost' }],
      handlers: [...closed.handlers, { tool: 'ghost' }],
      artifacts: [...closed.artifacts, { actionId: 'ghost.act' }],
      fixtures: [...closed.fixtures, { actionId: 'ghost.act' }],
    };
    const orphaned = evaluateClosure(withOrphans);

    // Four representations bound to nothing, and the census reports a clean,
    // 100% closed tree. It walks authority → representation only; a
    // representation outside the denominator is never enumerated. That is a
    // necessary condition for G5, not a sufficient one.
    expect(orphaned.ok).toBe(true);
    expect(orphaned.diagnostics).toEqual([]);
    expect(orphaned.totalActions).toBe(1);
    expect(orphaned.closedActions).toBe(1);

    // Sensitivity control, so the clean result above is not just an inert
    // instrument: break the SAME census in the direction it does cover.
    const broken = evaluateClosure({ ...closed, routes: [] });
    expect(broken.ok).toBe(false);
    expect(broken.diagnostics.map((d) => d.kind)).toEqual(['missing']);

    // Which is what the registered direction records.
    const p0505 = ENFORCEMENT_INSTRUMENTS.find((i) => i.id === 'p05-05-reachability-census');
    expect(p0505?.direction).toBe('authority-to-representation');
    expect(coversPopulation('authority-to-representation')).toBe(false);
    expect(coversPopulation('representation-to-authority')).toBe(true);
    expect(coversPopulation('both')).toBe(true);
  });

  it('AuthorityCensus_AlreadyEnforcedByAForwardOnlyInstrument_IsAStaleException', () => {
    // `already-enforced` is not an exemption — it is a claim about TODAY, so it
    // counts at every wave and is held to the population standard. An instrument
    // that cannot see an unbound representation does not discharge G5.
    const forwardOnly = row({
      enforceFrom: { kind: 'already-enforced', by: 'the census in fixture/instrument.ts' },
    });
    const forwardInstrument: EnforcementInstrument = {
      id: 'fixture-forward-only',
      module: 'fixture/instrument.ts',
      marker: 'fixture/instrument.ts',
      direction: 'authority-to-representation',
      why: 'walks the authority outward only',
    };

    const report = census([forwardOnly], 'wave-1', [forwardInstrument]);
    expect(report.ok).toBe(false);
    expect(tuplesOf(report)).toEqual([
      'response-shape | enforcement | stale-exception | the census in fixture/instrument.ts',
    ]);
    expect(report.blocking).toHaveLength(1);

    // Control 1: the same claim, same row, backed by an instrument that walks
    // representation → authority. The exemption then holds.
    const reciprocal = census([forwardOnly], 'wave-1', [
      { ...forwardInstrument, direction: 'representation-to-authority' },
    ]);
    expect(reciprocal.ok).toBe(true);
    expect(reciprocal.findings).toEqual([]);

    // Control 2: a claim naming nothing registered resolves to ZERO, which is
    // the `missing` arm. "There is no blanket allowlist" — an unregistered
    // claim is worse off than a wave, not better.
    const unregistered = census([forwardOnly], 'wave-1', []);
    expect(unregistered.findings.map((f) => f.kind)).toEqual(['missing']);
    expect(unregistered.ok).toBe(false);

    // Control 3: two instruments matching one claim is the same ambiguity a
    // second authority is.
    const twoMatch = census([forwardOnly], 'wave-1', [
      { ...forwardInstrument, direction: 'both' },
      { ...forwardInstrument, id: 'fixture-duplicate', direction: 'both' },
    ]);
    expect(twoMatch.findings.map((f) => f.kind)).toEqual(['ambiguous']);
    expect(twoMatch.ok).toBe(false);
  });

  it('AuthorityCensus_AlreadyEnforcedClaim_CountsAtEveryWave', () => {
    // A wave row is deferred; an `already-enforced` row cannot be, because it
    // asserts the boundary is closed NOW. Deferring it would let the strongest
    // claim on the table be the one nothing ever checks.
    const claim = row({
      enforceFrom: { kind: 'already-enforced', by: 'the census in fixture/instrument.ts' },
      representations: [authoritative('the authority itself'), unbound('a hand-authored copy')],
    });
    for (const wave of ENFORCEMENT_WAVES) {
      expect(isEnforcedAt(claim, wave)).toBe(true);
      expect(census([claim], wave).blocking.length).toBeGreaterThan(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Anti-laundering: re-classifying a representation may not quietly remove a
// finding
// ════════════════════════════════════════════════════════════════════════════

describe('authority census — the two-way ratchet on `bound`', () => {
  it('AuthorityCensus_BoundRepresentationNamingANonAuthority_IsAStaleException', () => {
    // The cheapest way to launder a finding out of the table is to relabel
    // `unbound(x, why)` as `bound(x, …)`. A `bound` claim is checkable — it must
    // name one of the boundary's OWN authorities — so the cheap relabel fails
    // rather than passing, the same two-way ratchet as STALE_ADAPTER_OWNER.
    const misPointed = census([
      row({
        representations: [
          authoritative('the authority itself'),
          bound('a hand-authored copy', 'some-other-module'),
        ],
      }),
    ]);
    expect(misPointed.ok).toBe(false);
    expect(tuplesOf(misPointed)).toEqual([
      'response-shape | binding | stale-exception | a hand-authored copy',
    ]);

    // On a contested row, naming ANY of the candidates resolves; naming
    // something outside them does not.
    const contested = row({
      authority: { kind: 'contested', candidates: ['first', 'second'] },
      representations: [
        authoritative('the first authority'),
        authoritative('the second authority'),
        bound('a derived view', 'second'),
      ],
    });
    expect(census([contested]).findings.map((f) => f.hop)).toEqual(['authority']);

    // On a row with NO authority there is nothing to be bound to, so every
    // binding claim on it is stale by construction.
    const noAuthority = census([
      row({
        boundary: 'effect-event',
        authority: { kind: 'none', why: 'neither representation derives the other' },
        representations: [bound('a claimed derivation', 'nothing at all'), unbound('the other side')],
      }),
    ]);
    expect(tuplesOf(noAuthority)).toEqual([
      'effect-event | authority | missing | effect-event',
      'effect-event | binding | stale-exception | a claimed derivation',
      'effect-event | binding | missing | the other side',
    ]);
  });

  it('AuthorityCensus_RepresentationRelabelledOnOneRowOnly_IsAmbiguous', () => {
    // `PHASE_EXPECTED_EVENTS` is carried by BOTH the event-catalog and the
    // phase-sequencing rows. Relabelling it on one row and not the other would
    // launder the finding out of half the table while every per-row count stays
    // put — which is exactly the shape task 024 self-caught. One representation
    // cannot be derived and not derived at the same time.
    const shared = 'PHASE_EXPECTED_EVENTS';
    const consistent = census([
      row({
        boundary: 'event-catalog',
        representations: [authoritative('the registry'), unbound(shared)],
      }),
      row({
        boundary: 'phase-sequencing',
        representations: [authoritative('the HSM guard'), unbound(shared)],
      }),
    ]);
    expect(consistent.findings.map((f) => f.kind)).toEqual(['missing', 'missing']);

    const relabelled = census([
      row({
        boundary: 'event-catalog',
        representations: [authoritative('the registry'), bound(shared, 'the-authority')],
      }),
      row({
        boundary: 'phase-sequencing',
        representations: [authoritative('the HSM guard'), unbound(shared)],
      }),
    ]);

    // Note the relabel here is the EXPENSIVE one: it names the event-catalog
    // row's real authority, so the per-row `bound` ratchet is satisfied and the
    // row's own `missing` finding does disappear. It still does not launder,
    // because the disagreement belongs to each boundary that carries the
    // representation — the count goes UP (2 → 3), not down.
    expect(tuplesOf(relabelled)).toEqual([
      'event-catalog | binding | ambiguous | PHASE_EXPECTED_EVENTS',
      'phase-sequencing | binding | ambiguous | PHASE_EXPECTED_EVENTS',
      'phase-sequencing | binding | missing | PHASE_EXPECTED_EVENTS',
    ]);
    expect(relabelled.findings.length).toBeGreaterThan(consistent.findings.length);
    expect(relabelled.ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Vocabulary — no novel error codes, read from the shipped census itself
// ════════════════════════════════════════════════════════════════════════════

describe('authority census — vocabulary', () => {
  it('AuthorityCensus_FindingKinds_AreTheReachabilityCensusKinds', () => {
    // The spec requires "no novel error codes introduced". The type-level half
    // is `_CensusKindsAreReachabilityKinds` in the module (checked by `tsc`,
    // which excludes this file). The runtime half is this: derive the shipped
    // vocabulary by RUNNING the P05-05 census into each of its three arms,
    // rather than restating a literal that could drift.
    const base: ReachabilityInputs = {
      surfaceVersion: 'vocabulary-probe',
      actions: [{ actionId: 'tool.act', tool: 'tool', action: 'act', mutates: false }],
      schemas: [{ actionId: 'tool.act' }],
      routes: [{ actionId: 'tool.act', tool: 'tool' }],
      handlers: [{ tool: 'tool' }],
      owners: [],
      outputs: [{ actionId: 'tool.act', outputKinds: ['data'], errorCodes: ['E_X'] }],
      artifacts: [{ actionId: 'tool.act' }],
      fixtures: [{ actionId: 'tool.act' }],
    };
    const shipped = new Set<string>([
      ...evaluateClosure({ ...base, routes: [] }).diagnostics.map((d) => d.kind),
      ...evaluateClosure({
        ...base,
        handlers: [{ tool: 'tool' }, { tool: 'tool' }],
      }).diagnostics.map((d) => d.kind),
      ...evaluateClosure({
        ...base,
        exceptions: [{ actionId: 'tool.act', hop: 'route', reason: 'not actually broken' }],
      }).diagnostics.map((d) => d.kind),
    ]);
    expect([...shipped].sort()).toEqual(['ambiguous', 'missing', 'stale-exception']);

    // Every kind this census emits on the live table is one of those.
    const emitted = new Set(runAuthorityCensus().findings.map((f) => f.kind));
    for (const kind of emitted) expect(shipped.has(kind)).toBe(true);

    // …and the census is not merely narrow: across the fixtures above it uses
    // ALL three, so the equality is a real one and not a subset that happens to
    // fit.
    const exercised = new Set<string>([
      ...census([row({ representations: [authoritative('a'), unbound('b')] })]).findings.map(
        (f) => f.kind,
      ),
      ...census([
        row({
          authority: { kind: 'contested', candidates: ['x', 'y'] },
          representations: [authoritative('a'), authoritative('b'), bound('c', 'x')],
        }),
      ]).findings.map((f) => f.kind),
      ...census([
        row({ representations: [authoritative('a'), bound('b', 'somewhere-else')] }),
      ]).findings.map((f) => f.kind),
    ]);
    expect([...exercised].sort()).toEqual([...shipped].sort());
  });

  it('AuthorityCensus_EveryHop_DeclaresItsEvidenceClass', () => {
    // The analogue of P05-05's `HOP_AUTHORITIES`: a hop may not join the census
    // without stating what resolves it. Two of the three hops resolve against
    // the row's own declaration, which is a committed measurement and NOT
    // independent evidence about the tree — recorded as data so a reviewer
    // cannot mistake a row-derived verdict for a live one.
    expect(Object.keys(HOP_EVIDENCE).sort()).toEqual([...CENSUS_HOPS].sort());
    expect(HOP_EVIDENCE.authority).toBe('declared-row');
    expect(HOP_EVIDENCE.binding).toBe('declared-row');
    expect(HOP_EVIDENCE.enforcement).toBe('registered-instrument');

    // Every registered instrument names a module and a marker a reviewer can
    // resolve, and states a direction — no unexamined registration.
    expect(ENFORCEMENT_INSTRUMENTS.length).toBeGreaterThan(0);
    for (const instrument of ENFORCEMENT_INSTRUMENTS) {
      expect(instrument.module.length).toBeGreaterThan(0);
      expect(instrument.marker.length).toBeGreaterThan(0);
      expect(instrument.why.length).toBeGreaterThan(40);
    }
  });

  it('WaveOrdering_EveryWave_IsOrderedByItsPositionInEnforcementWaves', () => {
    const indices = ENFORCEMENT_WAVES.map(waveIndex);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
    const waveRow = row({
      enforceFrom: { kind: 'wave', wave: 'wave-3', driver: 'DR-14' },
    });
    expect(ENFORCEMENT_WAVES.map((w) => isEnforcedAt(waveRow, w))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The live table — the measured verdict
// ════════════════════════════════════════════════════════════════════════════

describe('authority census — the live topology', () => {
  it('AuthorityCensus_LiveTopology_ReportsTheMeasuredFindingPopulation', () => {
    // The finding, pinned as data rather than prose. This is NOT a claim that
    // the tree is closed — it is emphatically not — it is the census's actual
    // output on the landing branch, which is what tasks 026 and 027 build on.
    //
    // It is also the anti-laundering pin. Task 024 self-caught that relabelling
    // one `unbound(...)` as `bound(...)` passed its tests because no asserted
    // COUNT moved. Counts are not what is pinned here: the full (boundary, hop,
    // kind, subject) tuple is, so removing a finding, moving it to another
    // boundary, or changing its class is red — and `AuthorityCensus_
    // BoundRepresentationNamingANonAuthority_IsAStaleException` above proves the
    // relabel does not even reach this pin unless it names a real authority.
    const report = runAuthorityCensus();
    const expected = [
      'action-contract | enforcement | stale-exception | the P05-05 reachability census (`contract/reachability/graph.ts`), which resolves every public action to exactly ONE schema/route/handler/output and fails on `missing` or `ambiguous`',
      'capability-posture | binding | missing | agent-spec YAML',
      'capability-posture | binding | missing | delegate skill prose',
      'capability-posture | binding | missing | the INV-11 invariants-catalog text',
      'cli-surface | authority | ambiguous | cli-surface',
      'effect-event | authority | missing | effect-event',
      'effect-event | binding | missing | EffectPlan (`core/effect-carrier.ts`)',
      'effect-event | binding | missing | the event append site',
      'event-catalog | binding | missing | PHASE_EXPECTED_EVENTS (`orchestrate/check-event-emissions.ts`)',
      'event-catalog | binding | missing | skill prose naming events to emit',
      'event-catalog | binding | missing | the registry `autoEmits` rows',
      'phase-sequencing | binding | missing | PHASE_EXPECTED_EVENTS (`orchestrate/check-event-emissions.ts`)',
      'phase-sequencing | binding | missing | the phase playbooks',
      'response-shape | binding | missing | Envelope<T>',
      'response-shape | binding | missing | the runtime response payload',
      'sdk-generation | authority | ambiguous | sdk-generation',
    ];

    expect(tuplesOf(report)).toEqual(expected);
    expect(report.ok).toBe(false);

    // ZERO of the eight boundaries are closed today. The table's own tests
    // record `action-contract` as the one row whose authority and bindings hold;
    // the census adds the third question — is it ENFORCED? — and the answer is
    // no, so no boundary is closed.
    expect(report.closedBoundaries).toEqual([]);
    expect(report.openBoundaries).toHaveLength(8);

    // Denominators, reported and non-trivial (DR-30: "the denominator is
    // reported and ratcheted").
    expect(report.rowCount).toBe(8);
    expect(report.evaluatedRows).toBe(8);
    expect(report.representationCount).toBe(24);
    expect(report.bindingSubjectCount).toBe(15);
    expect(report.totality.ok).toBe(true);
  });

  it('AuthorityCensus_LiveTopology_BlocksPerRowFromItsOwnEnforceFromWave', () => {
    // The schedule, measured. Wave 1 counts only the two wave-1 rows plus the
    // `already-enforced` claim; every later wave adds its own rows and never
    // drops an earlier one. A monotone series is the mechanical statement of
    // "each row flips at the wave that remediates it" — and it is what stops a
    // future edit from quietly deferring an already-live row.
    const perWave = ENFORCEMENT_WAVES.map((wave) => runAuthorityCensus(undefined, { atWave: wave }));
    expect(perWave.map((r) => r.blocking.length)).toEqual([5, 8, 11, 13, 16]);
    expect(perWave.map((r) => r.ok)).toEqual([false, false, false, false, false]);

    // Wave 1 counts exactly these — no wave-2+ subject leaks in early.
    const wave1 = perWave[0];
    expect([...new Set(wave1?.blocking.map((f) => f.boundary))].sort()).toEqual([
      'action-contract',
      'phase-sequencing',
      'response-shape',
    ]);

    // Monotonicity: a subject that counts at wave N still counts at wave N+1.
    for (let i = 1; i < perWave.length; i += 1) {
      const earlier = new Set(perWave[i - 1]?.blocking.map(tupleOf) ?? []);
      const later = new Set(perWave[i]?.blocking.map(tupleOf) ?? []);
      for (const subject of earlier) expect(later.has(subject)).toBe(true);
    }

    // By the last wave every finding counts — observe-only is an expiring
    // state, not an indefinite one.
    expect(perWave[perWave.length - 1]?.blocking.length).toBe(
      perWave[perWave.length - 1]?.findings.length,
    );
  });

  it('AuthorityCensus_ActionContractRow_ClaimsAnInstrumentThatDoesNotDischargeG5', () => {
    // The verdict on the one `already-enforced` row, stated where CI can see it.
    // The row names the P05-05 census; the census is registered; and the probe
    // above shows it walks authority → representation only. So the claim is
    // stale and the row belongs on a wave — the row is a live failing subject
    // for the enforcement hop, which is why the hop is not vacuous.
    const actionContract = topologyRows().find((r) => r.boundary === 'action-contract');
    if (actionContract === undefined) throw new Error('the action-contract row is missing');
    expect(actionContract.enforceFrom.kind).toBe('already-enforced');

    const claim =
      actionContract.enforceFrom.kind === 'already-enforced' ? actionContract.enforceFrom.by : '';
    expect(matchingInstruments(claim, ENFORCEMENT_INSTRUMENTS).map((i) => i.id)).toEqual([
      'p05-05-reachability-census',
    ]);

    const report = runAuthorityCensus();
    const finding = report.findings.find((f) => f.boundary === 'action-contract');
    expect(finding?.hop).toBe('enforcement');
    expect(finding?.kind).toBe('stale-exception');
    expect(finding?.blocking).toBe(true);

    // Its authority and bindings DO hold — the row is open on the enforcement
    // question alone. Stating that keeps the finding narrow and checkable.
    expect(declaredAuthorities(actionContract)).toHaveLength(1);
    expect(report.boundaries.find((b) => b.boundary === 'action-contract')?.findings).toHaveLength(
      1,
    );
  });

  it('AuthorityCensus_PhaseExpectedEvents_IsReportedUnboundOnBothRowsCarryingIt', () => {
    // The vacuity trap, pinned by subject rather than by count. A module-load
    // loop validates that every event `PHASE_EXPECTED_EVENTS` LISTS exists and
    // is `model`-sourced, but it can never see an event that should be listed
    // and is not — and 4 of its 6 phase entries are hand-written literals.
    // "A check exists" is not a binding, so the census must keep reporting it.
    const report = runAuthorityCensus();
    const carriers = report.findings.filter((f) => f.subject.startsWith('PHASE_EXPECTED_EVENTS'));

    expect(carriers.map((f) => f.boundary).sort()).toEqual(['event-catalog', 'phase-sequencing']);
    expect(carriers.map((f) => f.kind)).toEqual(['missing', 'missing']);

    // And the rows agree with each other about it, so there is no cross-row
    // `ambiguous` today — which is what makes relabelling it on one row alone a
    // detectable change rather than a silent one.
    expect(report.findings.filter((f) => f.kind === 'ambiguous').map((f) => f.hop)).toEqual([
      'authority',
      'authority',
    ]);
  });

  it('AuthorityCensus_EveryLiveRow_ResolvesEveryHopItCarries', () => {
    // Totality of the hop expansion itself: each row resolves the `authority`
    // hop, one `binding` hop per non-authoritative representation, and the
    // `enforcement` hop (applicable only where an `already-enforced` claim
    // exists). A row silently missing a hop would shrink the denominator
    // without shrinking any count this file otherwise asserts.
    const report = runAuthorityCensus();
    expect(report.boundaries).toHaveLength(topologyRows().length);

    for (const row_ of topologyRows()) {
      const closure = report.boundaries.find((b) => b.boundary === row_.boundary);
      expect(closure).toBeDefined();
      const hops = closure?.hops ?? [];
      expect(hops.filter((h) => h.hop === 'authority')).toHaveLength(1);
      expect(hops.filter((h) => h.hop === 'binding')).toHaveLength(bindingSubjects(row_).length);
      expect(hops.filter((h) => h.hop === 'enforcement')).toHaveLength(1);
      expect(hops.filter((h) => h.hop === 'enforcement')[0]?.applicable).toBe(
        row_.enforceFrom.kind === 'already-enforced',
      );
      // The authority hop's resolver count IS the number of declared
      // authorities — 1 is closure, 0 is `none`, ≥2 is the contest.
      expect(hops.find((h) => h.hop === 'authority')?.resolverCount).toBe(
        declaredAuthorities(row_).length,
      );
    }
  });

  it('AuthorityCensus_MalformedRowInTheSubject_FailsRatherThanBeingDropped', () => {
    // A row that does not narrow is not silently excluded from the denominator.
    // Dropping it would shrink the population the census ranges over while
    // leaving `ok` free to be true — the quietest possible way to lose a
    // boundary, and the one 024's derivation bridges exist to prevent upstream.
    const withJunk = census([row(), { boundary: 'not-a-real-boundary' }]);
    expect(withJunk.rowCount).toBe(2);
    expect(withJunk.evaluatedRows).toBe(1);
    expect(withJunk.ok).toBe(false);
    expect(withJunk.totality.ok).toBe(false);
  });
});
