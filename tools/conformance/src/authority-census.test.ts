// Tests for the authority census. They pin the closure verdict: per row, from the wave that fixes
// it, an unbound representation or a second authority fails.
//
// @oracle-sources: ./authority-topology.ts, ../../../src/contract/reachability/graph.ts
//
// The two authorities are independent. The rows are a committed human judgement about the tree,
// and the reachability graph is a shipped executable census. Neither module imports the other.
// The `action-contract` row names the ActionId-scoped closure instrument, not the forward-only
// wiring walk. A row that names the forward-only walk is stale.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fromSubjectPackage } from './subject-root.js';
import {
  evaluateClosure,
  type ReachabilityInputs,
} from '../../../src/contract/reachability/graph.js';
import {
  CONTRACT_BOUNDARIES,
  ENFORCEMENT_WAVES,
  topologyRows,
  type AuthorityTopologyRow,
  type BoundaryRepresentation,
  type EnforcementWave,
} from './authority-topology.js';
import {
  BOUNDARY_HOP_EVIDENCE,
  CENSUS_HOPS,
  ENFORCEMENT_INSTRUMENTS,
  auditRowEvidence,
  bindingSubjects,
  coversPopulation,
  declaredAuthorities,
  isEnforcedAt,
  liveMeasuredBoundaries,
  matchingInstruments,
  rowEvidence,
  runAuthorityCensus,
  waveIndex,
  type AnyRowHopEvidence,
  type AuthorityCensusReport,
  type CensusFinding,
  type EnforcementInstrument,
} from './authority-census.js';

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

/** Runs the census with no derivation bridges, so a fixture tests only its own property. */
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

describe('authority census — closure', () => {
  /**
   * Every representation that is not the authority must name what binds it. The census counts
   * unbound representations, and it does not check whether they agree with the authority today. The
   * row is due at `wave-1`, so the finding also blocks. The control binds the same representation,
   * and the row then passes.
   */
  it('AuthorityCensus_UnboundRepresentation_FailsClosure', () => {
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
    expect(report.blocking.map(tupleOf)).toEqual([
      'response-shape | binding | missing | a hand-authored copy',
    ]);

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

  /**
   * Two authoritative representations fail closure, even when they agree. The census counts
   * authorities and does not compare them. A row that declares the contest fails, and a row that
   * hides the contest behind one recorded authority fails the totality check.
   */
  it('AuthorityCensus_TwoAuthoritativeRepresentations_FailsClosure', () => {
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
    expect(declaredContest.findings[0]?.message).toContain('REGARDLESS');

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

    expect(census([row()]).ok).toBe(true);
  });

  /**
   * An empty denominator must fail, not pass with no findings. The three empty cases are no rows, a
   * row with no representations, and a binding hop with no subjects. A hop that examined zero
   * subjects has not cleared them.
   */
  it('AuthorityCensus_ZeroRowsEnumerated_FailsClosed', () => {
    const noRows = census([]);
    expect(noRows.ok).toBe(false);
    expect(noRows.rowCount).toBe(0);
    expect(noRows.findings).toEqual([]);
    expect(noRows.totality.diagnostics.map((d) => d.code)).toContain('EMPTY_TOPOLOGY');

    const noRepresentations = census([{ ...row(), representations: [] }]);
    expect(noRepresentations.ok).toBe(false);
    expect(noRepresentations.representationCount).toBe(0);
    expect(noRepresentations.totality.diagnostics.map((d) => d.code)).toContain(
      'MALFORMED_REPRESENTATIONS',
    );

    const noBindingSubjects = census([
      row({ representations: [authoritative('the authority itself')] }),
    ]);
    expect(noBindingSubjects.ok).toBe(false);
    expect(noBindingSubjects.representationCount).toBe(1);
    expect(noBindingSubjects.bindingSubjectCount).toBe(0);
    expect(noBindingSubjects.findings).toEqual([]);

    expect(census([row()]).bindingSubjectCount).toBe(1);
    expect(census([row()]).ok).toBe(true);
  });

  /**
   * Enforcement is per row. Before its `enforceFrom` wave, a finding is on the record but does not
   * block. From that wave on, the same finding blocks at every later wave. The switch happens at
   * `enforceFrom` exactly, not one wave to either side.
   */
  it('AuthorityCensus_RowBeforeItsEnforceFromWave_DoesNotBlock', () => {
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
    expect(early.ok).toBe(true);
    expect(early.openBoundaries).toEqual(['cli-surface']);

    for (const wave of ['wave-4', 'wave-5'] satisfies readonly EnforcementWave[]) {
      const late = census([wave4Row], wave);
      expect(late.blocking.map(tupleOf)).toEqual([
        'cli-surface | binding | missing | a hand-authored copy',
      ]);
      expect(late.boundaries[0]?.enforced).toBe(true);
      expect(late.ok).toBe(false);
    }

    expect(census([wave4Row], 'wave-3').ok).toBe(true);
    expect(census([wave4Row], 'wave-4').ok).toBe(false);
  });
});

/** An `already-enforced` claim is checked against the instrument that it names. */
describe('authority census — the enforcement hop', () => {
  /**
   * Runs the reachability census to prove the direction that `ENFORCEMENT_INSTRUMENTS` records. The
   * census walks from authority to representation only. Four orphan representations of an action
   * outside the denominator thus leave a clean result. A missing route, in the covered direction,
   * fails. The probe action declares no emission, so `emissions: []` is the correct input.
   */
  it('ReachabilityCensus_OrphanRepresentation_ResolvesCleanAndProvesTheDirection', () => {
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
      emissions: [],
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

    expect(orphaned.ok).toBe(true);
    expect(orphaned.diagnostics).toEqual([]);
    expect(orphaned.totalActions).toBe(1);
    expect(orphaned.closedActions).toBe(1);

    const broken = evaluateClosure({ ...closed, routes: [] });
    expect(broken.ok).toBe(false);
    expect(broken.diagnostics.map((d) => d.kind)).toEqual(['missing']);

    const p0505 = ENFORCEMENT_INSTRUMENTS.find((i) => i.id === 'p05-05-reachability-census');
    expect(p0505?.direction).toBe('authority-to-representation');
    expect(coversPopulation('authority-to-representation')).toBe(false);
    expect(coversPopulation('representation-to-authority')).toBe(true);
    expect(coversPopulation('both')).toBe(true);
  });

  /**
   * `already-enforced` is a claim about today, held to the population standard at every wave. A
   * forward-only instrument cannot see an unbound representation, so the claim is stale. With a
   * reciprocal instrument the claim holds. A claim that matches no instrument is `missing`, and a
   * claim that matches two is `ambiguous`.
   */
  it('AuthorityCensus_AlreadyEnforcedByAForwardOnlyInstrument_IsAStaleException', () => {
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

    const reciprocal = census([forwardOnly], 'wave-1', [
      { ...forwardInstrument, direction: 'representation-to-authority' },
    ]);
    expect(reciprocal.ok).toBe(true);
    expect(reciprocal.findings).toEqual([]);

    const unregistered = census([forwardOnly], 'wave-1', []);
    expect(unregistered.findings.map((f) => f.kind)).toEqual(['missing']);
    expect(unregistered.ok).toBe(false);

    const twoMatch = census([forwardOnly], 'wave-1', [
      { ...forwardInstrument, direction: 'both' },
      { ...forwardInstrument, id: 'fixture-duplicate', direction: 'both' },
    ]);
    expect(twoMatch.findings.map((f) => f.kind)).toEqual(['ambiguous']);
    expect(twoMatch.ok).toBe(false);
  });

  /**
   * A wave row can wait, but an `already-enforced` row states that the boundary is closed now. It
   * thus blocks at every wave.
   */
  it('AuthorityCensus_AlreadyEnforcedClaim_CountsAtEveryWave', () => {
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

/** A relabel of a representation must not remove a finding without a trace. */
describe('authority census — the two-way ratchet on `bound`', () => {
  /**
   * A `bound` claim must name one of the authorities of its own boundary, so a relabel from
   * `unbound` to a wrong target is stale. On a contested row, any candidate resolves. On a row with
   * no authority, every binding claim is stale.
   */
  it('AuthorityCensus_BoundRepresentationNamingANonAuthority_IsAStaleException', () => {
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

    const contested = row({
      authority: { kind: 'contested', candidates: ['first', 'second'] },
      representations: [
        authoritative('the first authority'),
        authoritative('the second authority'),
        bound('a derived view', 'second'),
      ],
    });
    expect(census([contested]).findings.map((f) => f.hop)).toEqual(['authority']);

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

  /**
   * Two rows carry `PHASE_EXPECTED_EVENTS`. A relabel on one of the rows removes the `missing`
   * finding of that row. But the disagreement is `ambiguous` on each row that carries the
   * representation, so the finding count goes up from two to three, not down.
   */
  it('AuthorityCensus_RepresentationRelabelledOnOneRowOnly_IsAmbiguous', () => {
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

    expect(tuplesOf(relabelled)).toEqual([
      'event-catalog | binding | ambiguous | PHASE_EXPECTED_EVENTS',
      'phase-sequencing | binding | ambiguous | PHASE_EXPECTED_EVENTS',
      'phase-sequencing | binding | missing | PHASE_EXPECTED_EVENTS',
    ]);
    expect(relabelled.findings.length).toBeGreaterThan(consistent.findings.length);
    expect(relabelled.ok).toBe(false);
  });
});

/** The census adds no new error codes. The tests read the vocabulary from the shipped census. */
describe('authority census — vocabulary', () => {
  /**
   * The census adds no new finding kinds. `_CensusKindsAreReachabilityKinds` is the compile-time
   * half. This runtime half runs the reachability census into each of its three arms to get the
   * shipped kinds. The live census uses only those kinds, and the fixtures use all three.
   */
  it('AuthorityCensus_FindingKinds_AreTheReachabilityCensusKinds', () => {
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
      emissions: [],
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

    const emitted = new Set(runAuthorityCensus().findings.map((f) => f.kind));
    for (const kind of emitted) expect(shipped.has(kind)).toBe(true);

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

  /**
   * The evidence table is total over boundary and hop, so no boundary or hop joins the census
   * without its evidence. Each cell names its own slot. `_InheritedEvidence_FailsCompile` enforces
   * that rule at compile time, and this test applies it to a table that arrives as data. Each
   * registered instrument names a module, a marker and a reason.
   */
  it('AuthorityCensus_EveryHopOfEveryRow_DeclaresItsEvidenceClass', () => {
    expect(Object.keys(BOUNDARY_HOP_EVIDENCE).sort()).toEqual([...CONTRACT_BOUNDARIES].sort());
    for (const boundary of CONTRACT_BOUNDARIES) {
      expect(Object.keys(rowEvidence(boundary)).sort()).toEqual([...CENSUS_HOPS].sort());
      for (const hop of CENSUS_HOPS) {
        const cell = rowEvidence(boundary)[hop];
        expect(cell.boundary).toBe(boundary);
        expect(cell.hop).toBe(hop);
        expect(cell.why.length).toBeGreaterThan(40);
      }
    }

    expect(ENFORCEMENT_INSTRUMENTS.length).toBeGreaterThan(0);
    for (const instrument of ENFORCEMENT_INSTRUMENTS) {
      expect(instrument.module.length).toBeGreaterThan(0);
      expect(instrument.marker.length).toBeGreaterThan(0);
      expect(instrument.why.length).toBeGreaterThan(40);
    }
  });

  /**
   * Four rows rest on an executable measurement, and the other five stay declared. A fifth live row
   * fails, and so does a live row that reverts. The evidence audit must range over every row and
   * every hop. Each live claim names an oracle that a reviewer can run again.
   */
  it('AuthorityCensus_LiveMeasuredRows_AreThreeAndTheOtherFiveStayDeclared', () => {
    expect([...liveMeasuredBoundaries()].sort()).toEqual([
      'cli-surface',
      'effect-event',
      'event-catalog',
      'phase-events',
    ]);

    const report = auditRowEvidence();
    expect(report.ok).toBe(true);
    expect(report.rowCount).toBe(CONTRACT_BOUNDARIES.length);
    expect(report.entryCount).toBe(CONTRACT_BOUNDARIES.length * CENSUS_HOPS.length);
    expect(report.checkedRows).toBe(CONTRACT_BOUNDARIES.length);
    expect(report.liveMeasured).toEqual(['cli-surface', 'effect-event', 'event-catalog', 'phase-events']);
    expect(report.declaredOnly).toHaveLength(5);
    expect(report.byClass['live-measurement']).toBe(8);
    expect(report.byClass['registered-instrument']).toBe(1);

    for (const boundary of liveMeasuredBoundaries()) {
      for (const hop of CENSUS_HOPS) {
        const cell = rowEvidence(boundary)[hop];
        if (cell.evidence !== 'live-measurement') continue;
        expect(cell.oracle.module).toContain('tools/audit/core/authority-live-proof.ts');
        expect(cell.oracle.entrypoint.length).toBeGreaterThan(0);
        expect(cell.oracle.subjects.length).toBeGreaterThan(0);
      }
    }

    const census = runAuthorityCensus();
    for (const closure of census.boundaries) {
      expect(closure.evidence).toEqual(rowEvidence(closure.boundary));
    }
  });

  /**
   * The authority and binding hops of `effect-event` rest on a live measurement, and both measure
   * the same existing paths. The enforcement hop stays `not-applicable`, because the row enforces
   * from a wave. The row stays open, because one representation is still unbound.
   */
  it('AuthorityCensus_EffectEventRow_NoLongerADeclaredRow', () => {
    const evidence = rowEvidence('effect-event');
    expect(evidence.authority.evidence).toBe('live-measurement');
    expect(evidence.binding.evidence).toBe('live-measurement');

    const subjectsOf = (cell: AnyRowHopEvidence): readonly string[] =>
      cell.evidence === 'live-measurement' ? cell.oracle.subjects : [];
    const authoritySubjects = subjectsOf(evidence.authority);
    expect(authoritySubjects.length).toBeGreaterThan(0);
    expect(subjectsOf(evidence.binding)).toEqual(authoritySubjects);
    for (const subject of authoritySubjects) {
      expect(existsSync(fromSubjectPackage(subject)), `${subject} exists`).toBe(true);
    }

    expect(evidence.enforcement.evidence).toBe('not-applicable');

    const closure = runAuthorityCensus().boundaries.find((b) => b.boundary === 'effect-event');
    expect(closure?.closed).toBe(false);
    expect(closure?.findings.map((f) => `${f.hop} | ${f.kind}`)).toEqual(['binding | missing']);
  });

  /**
   * The kill fixture for the runtime half of the inheritance rule. It copies the live entry of one
   * row into a row with no live measurement, and the audit must fail. The fixture mutates the
   * shipped table, so it keeps the real shape. The unmutated table passes.
   */
  it('AuthorityCensus_EvidenceInheritedFromAnotherRow_FailsTheAudit', () => {
    const inherited = {
      ...BOUNDARY_HOP_EVIDENCE,
      'response-shape': {
        ...BOUNDARY_HOP_EVIDENCE['response-shape'],
        authority: BOUNDARY_HOP_EVIDENCE['cli-surface'].authority,
      },
    };
    const report = auditRowEvidence(inherited);
    expect(report.ok).toBe(false);
    const inheritance = report.findings.filter(
      (f) => f.boundary === 'response-shape' && f.hop === 'authority',
    );
    expect(inheritance.length).toBeGreaterThan(0);
    expect(inheritance[0]?.kind).toBe('stale-exception');
    expect(inheritance.map((f) => f.message).join(' ')).toMatch(/cannot be inherited from another/);

    expect(auditRowEvidence().ok).toBe(true);
  });

  /**
   * An empty evidence map, an empty row list and a value that is not a table all fail. The audit
   * checks the denominators, not only the finding list.
   */
  it('AuthorityCensus_EmptyEvidenceMap_FailsRatherThanPassingClean', () => {
    const empty = auditRowEvidence({});
    expect(empty.ok).toBe(false);
    expect(empty.entryCount).toBe(0);
    expect(empty.rowCount).toBe(0);
    expect(empty.findings.some((f) => f.message.includes('ZERO (hop, row) entries'))).toBe(true);

    const noRows = auditRowEvidence(BOUNDARY_HOP_EVIDENCE, []);
    expect(noRows.ok).toBe(false);
    expect(noRows.checkedRows).toBe(0);
    expect(noRows.findings.some((f) => f.message.includes('ZERO rows'))).toBe(true);

    expect(auditRowEvidence(null).ok).toBe(false);
    expect(auditRowEvidence('not a table').ok).toBe(false);
  });

  /**
   * The audit checks a `not-applicable` claim against the row. A binding hop with a real population
   * cannot claim `not-applicable`. A row that becomes `already-enforced` makes its enforcement hop
   * apply, so a row cannot start to enforce and leave its evidence behind.
   */
  it('AuthorityCensus_NotApplicableEvidence_IsCheckedAgainstTheRow', () => {
    const withBindingPopulation = row({
      boundary: 'sdk-generation',
      representations: [authoritative('the authority itself'), unbound('a hand-authored copy')],
    });
    const stale = auditRowEvidence(BOUNDARY_HOP_EVIDENCE, [
      ...topologyRows().filter((r) => r.boundary !== 'sdk-generation'),
      withBindingPopulation,
    ]);
    expect(stale.ok).toBe(false);
    expect(
      stale.findings.some(
        (f) => f.boundary === 'sdk-generation' && f.hop === 'binding' && f.kind === 'stale-exception',
      ),
    ).toBe(true);

    const nowEnforced = row({
      boundary: 'response-shape',
      enforceFrom: {
        kind: 'already-enforced',
        by: 'contract/reachability/graph.ts',
      },
    });
    const underClaim = auditRowEvidence(BOUNDARY_HOP_EVIDENCE, [
      ...topologyRows().filter((r) => r.boundary !== 'response-shape'),
      nowEnforced,
    ]);
    expect(underClaim.ok).toBe(false);
    expect(
      underClaim.findings.some(
        (f) =>
          f.boundary === 'response-shape' &&
          f.hop === 'enforcement' &&
          f.kind === 'stale-exception',
      ),
    ).toBe(true);
  });

  /**
   * The evidence audit emits only the kinds of the reachability census. A `live-measurement` claim
   * with an empty subject list is a measurement over nothing, and it fails.
   */
  it('AuthorityCensus_EvidenceFindingKinds_AreTheImportedVocabulary', () => {
    const corrupt = auditRowEvidence({
      ...BOUNDARY_HOP_EVIDENCE,
      'not-a-boundary': BOUNDARY_HOP_EVIDENCE['cli-surface'],
      'effect-event': {
        authority: { boundary: 'effect-event', hop: 'authority', evidence: 'guesswork', why: 'x' },
        binding: BOUNDARY_HOP_EVIDENCE['effect-event'].binding,
        enforcement: BOUNDARY_HOP_EVIDENCE['effect-event'].enforcement,
      },
    });
    expect(corrupt.ok).toBe(false);
    const kinds = new Set(corrupt.findings.map((f) => f.kind));
    expect(kinds.size).toBeGreaterThan(1);
    for (const kind of kinds) expect(['missing', 'ambiguous', 'stale-exception']).toContain(kind);

    const hollow = auditRowEvidence({
      ...BOUNDARY_HOP_EVIDENCE,
      'cli-surface': {
        ...BOUNDARY_HOP_EVIDENCE['cli-surface'],
        authority: {
          boundary: 'cli-surface',
          hop: 'authority',
          evidence: 'live-measurement',
          oracle: { module: 'x.ts', entrypoint: 'measure', subjects: [] },
          why: BOUNDARY_HOP_EVIDENCE['cli-surface'].authority.why,
        },
      },
    });
    expect(hollow.ok).toBe(false);
    expect(hollow.findings.some((f) => f.message.includes('measurement over nothing'))).toBe(true);
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

/** The verdict of the census on the live topology. */
describe('authority census — the live topology', () => {
  /**
   * Pins the full finding tuples of the live census, not counts. The tree is not closed. A removed
   * finding, a finding on another boundary or a changed kind fails the test. Only `action-contract`
   * is closed. The denominators derive from `topologyRows()` and `bindingSubjects()`, not from
   * transcribed numbers.
   */
  it('AuthorityCensus_LiveTopology_ReportsTheMeasuredFindingPopulation', () => {
    const report = runAuthorityCensus();
    const expected = [
      'capability-posture | binding | missing | agent-spec YAML',
      'capability-posture | binding | missing | delegate skill prose',
      'capability-posture | binding | missing | the INV-11 invariants-catalog text',
      'cli-surface | authority | ambiguous | cli-surface',
      'effect-event | binding | missing | the promotion record sink (`install/atomic-promotion.ts`)',
      'event-catalog | binding | missing | skill prose naming events to emit',
      'event-catalog | binding | missing | the PHASE_EVENT_CONTRACTS rows (`workflow/topology/phase-events.ts`)',
      'event-catalog | binding | missing | the registry emission rows',
      'phase-events | binding | missing | the skill passages that say what the gate checks',
      'phase-sequencing | binding | missing | the PHASE_EVENT_CONTRACTS rows (`workflow/topology/phase-events.ts`)',
      'phase-sequencing | binding | missing | the phase playbooks',
      'response-shape | binding | missing | Envelope<T>',
      'response-shape | binding | missing | the runtime response payload',
      'sdk-generation | authority | ambiguous | sdk-generation',
    ];

    expect(tuplesOf(report)).toEqual(expected);
    expect(report.ok).toBe(false);

    expect(report.closedBoundaries).toEqual(['action-contract']);
    expect(report.openBoundaries).toHaveLength(8);

    const rows = topologyRows();
    expect(report.rowCount).toBe(rows.length);
    expect(report.evaluatedRows).toBe(rows.length);
    expect(report.representationCount).toBe(
      rows.reduce((sum, row) => sum + row.representations.length, 0),
    );
    expect(report.bindingSubjectCount).toBe(
      rows.reduce((sum, row) => sum + bindingSubjects(row).length, 0),
    );
    expect(report.totality.ok).toBe(true);
  });

  /**
   * Each row blocks from its own `enforceFrom` wave. A finding that blocks at one wave blocks at
   * every later wave, so no edit can defer a row that already blocks. At `wave-1` only the
   * `phase-sequencing` and `response-shape` rows block. At the last wave every finding blocks.
   */
  it('AuthorityCensus_LiveTopology_BlocksPerRowFromItsOwnEnforceFromWave', () => {
    const perWave = ENFORCEMENT_WAVES.map((wave) => runAuthorityCensus(undefined, { atWave: wave }));
    expect(perWave.map((r) => r.blocking.length)).toEqual([4, 5, 8, 10, 14]);
    expect(perWave.map((r) => r.ok)).toEqual([false, false, false, false, false]);

    const wave1 = perWave[0];
    expect([...new Set(wave1?.blocking.map((f) => f.boundary))].sort()).toEqual([
      'phase-sequencing',
      'response-shape',
    ]);

    for (let i = 1; i < perWave.length; i += 1) {
      const earlier = new Set(perWave[i - 1]?.blocking.map(tupleOf) ?? []);
      const later = new Set(perWave[i]?.blocking.map(tupleOf) ?? []);
      for (const subject of earlier) expect(later.has(subject)).toBe(true);
    }

    expect(perWave[perWave.length - 1]?.blocking.length).toBe(
      perWave[perWave.length - 1]?.findings.length,
    );
  });

  /**
   * The one `already-enforced` row names the ActionId-scoped closure instrument, not the wiring
   * reachability walk. The closure instrument walks representations back to the declared contract,
   * so the claim covers the population and the row is closed.
   */
  it('AuthorityCensus_ActionContract_UsesClosureInstrument', () => {
    const actionContract = topologyRows().find((r) => r.boundary === 'action-contract');
    if (actionContract === undefined) throw new Error('the action-contract row is missing');
    expect(actionContract.enforceFrom.kind).toBe('already-enforced');

    const claim =
      actionContract.enforceFrom.kind === 'already-enforced' ? actionContract.enforceFrom.by : '';
    expect(claim).toContain('action-contract-closure.ts');
    expect(claim).not.toContain('contract/reachability/graph.ts');
    expect(matchingInstruments(claim, ENFORCEMENT_INSTRUMENTS).map((i) => i.id)).toEqual([
      'action-contract-closure',
    ]);

    const closure = ENFORCEMENT_INSTRUMENTS.find((i) => i.id === 'action-contract-closure');
    expect(closure?.module).toContain('action-contract-closure.ts');
    expect(closure?.marker).toContain('action-contract-closure.ts');
    expect(coversPopulation(closure?.direction ?? 'authority-to-representation')).toBe(true);

    const wiring = ENFORCEMENT_INSTRUMENTS.find((i) => i.id === 'p05-05-reachability-census');
    expect(wiring, 'the wiring census stays registered').toBeDefined();
    expect(coversPopulation(wiring?.direction ?? 'both')).toBe(false);

    const report = runAuthorityCensus();
    const enforcementFindings = report.findings.filter(
      (f) => f.boundary === 'action-contract' && f.hop === 'enforcement',
    );
    expect(enforcementFindings).toEqual([]);
    expect(
      report.findings.some(
        (f) => f.boundary === 'action-contract' && f.kind === 'stale-exception',
      ),
    ).toBe(false);

    expect(declaredAuthorities(actionContract)).toHaveLength(1);
    expect(report.boundaries.find((b) => b.boundary === 'action-contract')?.findings).toEqual([]);
    expect(report.closedBoundaries).toContain('action-contract');
  });

  /**
   * A check that every listed event exists cannot see an event that the list omits, so a check is
   * not a binding. Both boundaries that carry the `PHASE_EVENT_CONTRACTS` rows report them as
   * `missing`. The rows agree, so no `binding` hop is `ambiguous`. The only `ambiguous` findings
   * are on two `authority` hops.
   */
  it('AuthorityCensus_PhaseExpectedEvents_IsReportedUnboundOnBothRowsCarryingIt', () => {
    const report = runAuthorityCensus();
    const carriers = report.findings.filter((f) => f.subject.startsWith('the PHASE_EVENT_CONTRACTS rows'));

    expect(carriers.map((f) => f.boundary).sort()).toEqual(['event-catalog', 'phase-sequencing']);
    expect(carriers.map((f) => f.kind)).toEqual(['missing', 'missing']);

    expect(report.findings.filter((f) => f.kind === 'ambiguous').map((f) => f.hop)).toEqual([
      'authority',
      'authority',
    ]);
  });

  /**
   * Each row resolves one `authority` hop, one `binding` hop per non-authoritative representation,
   * and one `enforcement` hop. The enforcement hop applies only to an `already-enforced` row. The
   * resolver count of the authority hop equals the declared authorities: 1 is closure, 0 is `none`,
   * and 2 or more is a contest.
   */
  it('AuthorityCensus_EveryLiveRow_ResolvesEveryHopItCarries', () => {
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
      expect(hops.find((h) => h.hop === 'authority')?.resolverCount).toBe(
        declaredAuthorities(row_).length,
      );
    }
  });

  /**
   * A row that does not narrow stays in the denominator and fails the census. A dropped row shrinks
   * the population and leaves `ok` free to be true.
   */
  it('AuthorityCensus_MalformedRowInTheSubject_FailsRatherThanBeingDropped', () => {
    const withJunk = census([row(), { boundary: 'not-a-real-boundary' }]);
    expect(withJunk.rowCount).toBe(2);
    expect(withJunk.evaluatedRows).toBe(1);
    expect(withJunk.ok).toBe(false);
    expect(withJunk.totality.ok).toBe(false);
  });
});
