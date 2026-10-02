// Tests for the table in `authority-topology.ts`. They pin the shape of the rows, not closure
// over the live tree.
//
// @oracle-sources: ./authority-topology.ts, ../../../package.json
//
// The two authorities are independent. The topology rows are a committed judgement about the tree,
// and `package.json` is the manifest that npm resolves. `authority-topology.ts` imports no JSON,
// so the sdk-generation cross-check can disagree.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fromSubjectPackage } from './subject-root.js';
import { DECLARATION_KINDS } from '../../../src/contract/declaration.js';
import { scanGovernedSources } from '../../audit/core/cli-derivation-guard.js';
import {
  measureEffectEvent,
  readEffectEventSources,
} from '../../audit/core/authority-live-proof.js';
import {
  AUTHORITY_TOPOLOGY,
  CONTRACT_BOUNDARIES,
  DECLARATION_KIND_BOUNDARIES,
  SDK_GENERATION_REPRESENTATIONS,
  authoritativeRepresentations,
  checkTopologyTotality,
  isAuthorityTopologyRow,
  topologyRows,
  unboundRepresentations,
} from './authority-topology.js';
import { BOUNDARY_DERIVATIONS } from './bindings/index.js';

/** The SUBJECT's manifest — the one that installs the MCP SDK, not this package's. */
const PACKAGE_JSON = fromSubjectPackage('package.json');

/** Codes present in a report, for readable assertions. */
const codesOf = (report: { diagnostics: readonly { code: string }[] }): readonly string[] =>
  report.diagnostics.map((d) => d.code);

/**
 * A structurally complete row-shaped object, as untyped data. Built as `unknown`
 * on purpose: the required tests below have to feed rows that the TYPE forbids
 * (a row with no `enforceFrom` is a compile error), which is exactly why
 * `checkTopologyTotality` accepts `readonly unknown[]`.
 */
function wellFormedRowData(overrides: Record<string, unknown> = {}): unknown {
  return {
    boundary: 'effect-event',
    authority: { kind: 'none', why: 'neither representation derives the other' },
    representations: [
      { id: 'EffectPlan', binding: { kind: 'unbound', why: 'nothing derives it' } },
    ],
    enforceFrom: { kind: 'wave', wave: 'wave-2', driver: 'DR-7 bijection' },
    provenance: { kind: 'declared', whyNotDerivable: 'no enumerable upstream domain' },
    measured: 'no authority; no binding in either direction',
    ...overrides,
  };
}

/** Drop one field from the well-formed row data. */
function rowDataWithout(field: string): unknown {
  const row = wellFormedRowData();
  if (typeof row !== 'object' || row === null) throw new Error('fixture is not an object');
  const copy: Record<string, unknown> = { ...row };
  delete copy[field];
  return copy;
}

describe('authority topology — required properties', () => {
  /**
   * Each row is in one of three states. `single` has one authority id, `contested` has two or more, and `none` says why.
   * Each representation states its binding: `bound` names what binds it, and `unbound` names the gap.
   */
  it('AuthorityTopology_EveryRow_NamesExactlyOneAuthorityOrRecordsContested', () => {
    const rows = topologyRows();
    expect(rows.length).toBe(CONTRACT_BOUNDARIES.length);

    for (const row of rows) {
      const authoritative = authoritativeRepresentations(row);

      switch (row.authority.kind) {
        case 'single':
          expect(row.authority.authority.length).toBeGreaterThan(0);
          expect(authoritative.length).toBe(1);
          break;
        case 'contested':
          expect(row.authority.candidates.length).toBeGreaterThanOrEqual(2);
          expect(authoritative.length).toBeGreaterThanOrEqual(2);
          break;
        case 'none':
          expect(row.authority.why.length).toBeGreaterThan(0);
          expect(authoritative.length).toBe(0);
          break;
      }

      for (const rep of row.representations) {
        expect(rep.id.length).toBeGreaterThan(0);
        if (rep.binding.kind === 'bound') expect(rep.binding.boundTo.length).toBeGreaterThan(0);
        if (rep.binding.kind === 'unbound') expect(rep.binding.why.length).toBeGreaterThan(0);
      }
    }

    expect(codesOf(checkTopologyTotality(topologyRows(), BOUNDARY_DERIVATIONS))).toEqual([]);
  });

  /**
   * A row that lacks only `enforceFrom` fails, and no allowlist rescues it.
   * The control row with `enforceFrom` passes, so the failure comes from the missing field.
   */
  it('AuthorityTopology_RowWithoutEnforceFrom_FailsTotality', () => {
    const report = checkTopologyTotality([rowDataWithout('enforceFrom')], []);

    expect(report.ok).toBe(false);
    expect(codesOf(report)).toContain('MISSING_ENFORCE_FROM');

    const control = checkTopologyTotality([wellFormedRowData()], []);
    expect(control.ok).toBe(true);
    expect(codesOf(control)).toEqual([]);
  });

  /** An empty census reports no findings, so zero rows must fail. */
  it('AuthorityTopology_ZeroRowsResolved_FailsClosed', () => {
    const report = checkTopologyTotality([], []);

    expect(report.ok).toBe(false);
    expect(report.rowCount).toBe(0);
    expect(codesOf(report)).toContain('EMPTY_TOPOLOGY');
  });
});

/** A boundary that is absent from the topology is the one place where an unbound representation can hide. */
describe('authority topology — derived boundaries', () => {
  /**
   * The bridge is total over `DeclarationKind`, so each kind maps to a boundary that the table must carry.
   * `tsc` rejects a new kind at the bridge. This test is the runtime half.
   */
  it('BoundaryDerivations_EveryDeclarationKind_ForcesABoundaryRow', () => {
    for (const kind of DECLARATION_KINDS) {
      const boundary = DECLARATION_KIND_BOUNDARIES[kind];
      expect(CONTRACT_BOUNDARIES).toContain(boundary);
      expect(AUTHORITY_TOPOLOGY[boundary].boundary).toBe(boundary);
    }
  });

  /** Without the sdk-generation row, the bridge must report a finding, or a boundary hides its unbound representations. */
  it('BoundaryDerivations_RequiredBoundaryMissingFromRows_FailsTotality', () => {
    const withoutSdk = topologyRows().filter((row) => row.boundary !== 'sdk-generation');
    const report = checkTopologyTotality(withoutSdk, BOUNDARY_DERIVATIONS);

    expect(report.ok).toBe(false);
    expect(codesOf(report)).toContain('MISSING_DERIVED_BOUNDARY');
    expect(report.diagnostics.some((d) => d.subject === 'sdk-generation')).toBe(true);
  });

  /** The same check on the other bridge: the `cli-verb` declaration kind requires the cli-surface row. */
  it('BoundaryDerivations_DeclarationKindRowDropped_FailsTotality', () => {
    const withoutCli = topologyRows().filter((row) => row.boundary !== 'cli-surface');
    const report = checkTopologyTotality(withoutCli, BOUNDARY_DERIVATIONS);

    expect(codesOf(report)).toContain('MISSING_DERIVED_BOUNDARY');
    expect(report.diagnostics.some((d) => d.subject === 'cli-surface')).toBe(true);
  });

  /**
   * A row cannot claim that it is derived when no bridge requires it.
   * Otherwise `provenance` becomes a free label, and hand-maintained rows stop showing as such.
   */
  it('RowProvenance_DerivedClaimNoBridgeProduces_IsStaleCover', () => {
    const overclaiming = wellFormedRowData({
      boundary: 'effect-event',
      provenance: { kind: 'derived', from: 'declaration-kinds' },
    });
    const report = checkTopologyTotality([overclaiming], BOUNDARY_DERIVATIONS);

    expect(codesOf(report)).toContain('STALE_DERIVED_PROVENANCE');
  });

  /** A hand-maintained row must say why it is not derivable, or a derivable boundary stays hand-maintained. */
  it('RowProvenance_DeclaredRowWithoutRationale_FailsTotality', () => {
    const unjustified = wellFormedRowData({ provenance: { kind: 'declared' } });
    const report = checkTopologyTotality([unjustified], []);

    expect(codesOf(report)).toContain('UNJUSTIFIED_DECLARED_ROW');
  });

  /**
   * A declared row states why it is not derivable. The bridge of a derived row requires that row,
   * which is the `STALE_DERIVED_PROVENANCE` check over the live table.
   */
  it('RowProvenance_EveryDeclaredRow_StatesWhyItIsNotDerivable', () => {
    for (const row of topologyRows()) {
      if (row.provenance.kind === 'declared') {
        expect(row.provenance.whyNotDerivable.length).toBeGreaterThan(40);
      } else {
        const bridge = BOUNDARY_DERIVATIONS.find((d) => d.id === row.provenance.from);
        expect(bridge?.requires).toContain(row.boundary);
      }
    }
  });
});

/** More than one authoritative representation is a finding, even when the copies agree today. */
describe('authority topology — plural authority', () => {
  /** A `single` authority with two authoritative representations is a finding. The check counts them and does not compare them. */
  it('AuthorityTopology_TwoAuthoritativeRepresentations_CannotBeRecordedAsSingle', () => {
    const twoAuthorities = wellFormedRowData({
      authority: { kind: 'single', authority: 'registry' },
      representations: [
        { id: 'registry descriptor', binding: { kind: 'authoritative' } },
        { id: 'hand-written literals', binding: { kind: 'authoritative' } },
      ],
    });
    const report = checkTopologyTotality([twoAuthorities], []);

    expect(report.ok).toBe(false);
    expect(codesOf(report)).toContain('AUTHORITY_REPRESENTATION_DISAGREEMENT');
  });

  /** The same two representations pass when the row declares the contest. The finding is the mismatch, not the plurality. */
  it('AuthorityTopology_ContestedWithTwoAuthoritativeRepresentations_IsWellFormed', () => {
    const contested = wellFormedRowData({
      authority: {
        kind: 'contested',
        candidates: ['registry', 'hand-written literals'],
      },
      representations: [
        { id: 'registry descriptor', binding: { kind: 'authoritative' } },
        { id: 'hand-written literals', binding: { kind: 'authoritative' } },
      ],
    });

    expect(checkTopologyTotality([contested], []).ok).toBe(true);
  });

  it('AuthorityTopology_ContestedWithOneCandidate_IsNotAContest', () => {
    const notAContest = wellFormedRowData({
      authority: { kind: 'contested', candidates: ['registry'] },
      representations: [{ id: 'registry descriptor', binding: { kind: 'authoritative' } }],
    });

    expect(codesOf(checkTopologyTotality([notAContest], []))).toContain('MALFORMED_AUTHORITY');
  });
});

/** The rows carry the measured state of the tree as data. */
describe('authority topology — the rows', () => {
  /** A row under the wrong key reports the findings of one boundary against another. */
  it('AuthorityTopology_EveryBoundary_CarriesExactlyOneRowKeyedByItself', () => {
    for (const boundary of CONTRACT_BOUNDARIES) {
      expect(AUTHORITY_TOPOLOGY[boundary].boundary).toBe(boundary);
    }
    expect(Object.keys(AUTHORITY_TOPOLOGY).sort()).toEqual([...CONTRACT_BOUNDARIES].sort());
  });

  /** The runtime half of the envelope check: each row survives a JSON round trip. */
  it('AuthorityTopology_EveryRow_IsStructurallyValidFromUntypedInput', () => {
    for (const row of topologyRows()) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(row));
      expect(isAuthorityTopologyRow(roundTripped)).toBe(true);
    }
  });

  /** A row that is not enforced names the driver of its enforcement wave. An enforced row names what enforces it. */
  it('AuthorityTopology_UnenforcedRows_CarryAWaveAndADriver', () => {
    for (const row of topologyRows()) {
      if (row.enforceFrom.kind === 'wave') {
        expect(row.enforceFrom.driver.length).toBeGreaterThan(0);
      } else {
        expect(row.enforceFrom.by.length).toBeGreaterThan(0);
      }
    }
  });

  /** `already-enforced` is a positive claim, not an exemption. The row must have one authority and nothing unbound. */
  it('AuthorityTopology_AlreadyEnforcedRow_HasNoUnboundRepresentation', () => {
    for (const row of topologyRows()) {
      if (row.enforceFrom.kind !== 'already-enforced') continue;
      expect(row.authority.kind).toBe('single');
      expect(unboundRepresentations(row)).toEqual([]);
    }
  });

  /**
   * Pins the measured state. `action-contract` is the one closed row.
   * Each other row has no single authority or has an unbound representation.
   */
  it('AuthorityTopology_ContestedAndUnboundRows_AreTheOpenOnes', () => {
    const open = topologyRows().filter(
      (row) => row.authority.kind !== 'single' || unboundRepresentations(row).length > 0,
    );
    const closed = topologyRows().filter((row) => !open.includes(row));

    expect(closed.map((r) => r.boundary)).toEqual(['action-contract']);
    expect(open.map((r) => r.boundary).sort()).toEqual([
      'capability-posture',
      'cli-surface',
      'effect-event',
      'event-catalog',
      'phase-events',
      'phase-sequencing',
      'response-shape',
      'sdk-generation',
    ]);
  });

  /**
   * Pins the authoritative, bound and unbound counts of each row. It is not a live-tree proof.
   * A relabel of one `unbound` representation as `bound` changes no other count in this file, so this pin catches it.
   */
  it('AuthorityTopology_EveryRow_PinsItsBindingComposition', () => {
    const composition = topologyRows().map((row) => ({
      boundary: row.boundary,
      authoritative: authoritativeRepresentations(row).length,
      bound: row.representations.filter((r) => r.binding.kind === 'bound').length,
      unbound: unboundRepresentations(row).length,
    }));

    const expected = [
      { boundary: 'action-contract', authoritative: 1, bound: 1, unbound: 0 },
      { boundary: 'capability-posture', authoritative: 1, bound: 1, unbound: 3 },
      { boundary: 'cli-surface', authoritative: 2, bound: 1, unbound: 0 },
      { boundary: 'effect-event', authoritative: 1, bound: 1, unbound: 1 },
      { boundary: 'event-catalog', authoritative: 1, bound: 0, unbound: 3 },
      { boundary: 'phase-events', authoritative: 1, bound: 2, unbound: 1 },
      { boundary: 'phase-sequencing', authoritative: 1, bound: 0, unbound: 2 },
      { boundary: 'response-shape', authoritative: 1, bound: 0, unbound: 2 },
      { boundary: 'sdk-generation', authoritative: 2, bound: 0, unbound: 0 },
    ];

    expect(composition).toEqual(expected);
  });

  /**
   * Nothing derives the hand-written literals and nothing derives from them, so they are a second authority.
   * The count in the `measured` note must agree with the count in the representation id and with the live tree.
   * The test does not hard-code the count, so a stale note fails even when the id is correct.
   */
  it('AuthorityTopology_CliSurfaceRow_RecordsTheHandWrittenLiteralsAsASecondAuthority', () => {
    const row = AUTHORITY_TOPOLOGY['cli-surface'];
    expect(row.authority.kind).toBe('contested');
    expect(authoritativeRepresentations(row).length).toBe(2);

    const idCount = authoritativeRepresentations(row)
      .map((r) => /\bthe (\d+) hand-written\b/.exec(r.id)?.[1])
      .find((c) => c !== undefined);
    expect(idCount, 'the second authority id states a literal count').toBeDefined();
    expect(row.measured).toContain(idCount as string);

    expect(Number(idCount)).toBe(scanGovernedSources().literals.length);
  });

  /**
   * The carrier gives this row its authority. A plan that declares an emission cannot reach a committed value without a receipt.
   * The one `bound` representation must name the authority of the row.
   * The row stays open, because one owner hands its record to a destination that the caller owns.
   * The committed binding kinds must match the live measurement.
   */
  it('AuthorityTopology_EffectEventRow_RecordsTheCarrierCoupling', () => {
    const row = AUTHORITY_TOPOLOGY['effect-event'];
    expect(row.authority.kind).toBe('single');
    expect(authoritativeRepresentations(row).length).toBe(1);

    const authority = row.authority.kind === 'single' ? row.authority.authority : '';
    const boundReps = row.representations.filter((r) => r.binding.kind === 'bound');
    expect(boundReps.length).toBe(1);
    for (const rep of boundReps) {
      expect(rep.binding.kind === 'bound' ? rep.binding.boundTo : '').toBe(authority);
    }

    expect(unboundRepresentations(row).length).toBe(1);

    const live = measureEffectEvent(readEffectEventSources());
    const kindById = new Map(live.representations.map((r) => [r.id, r.binding.kind]));
    for (const rep of row.representations) {
      expect(kindById.get(rep.id), `the tree classifies ${rep.id}`).toBe(rep.binding.kind);
    }
    expect(kindById.size).toBe(row.representations.length);
  });
});

/** Cross-checks the sdk-generation row against the package manifest, the second authority. */
describe('authority topology — sdk-generation row vs the package manifest', () => {
  function installedSdkPackages(): readonly string[] {
    const manifest: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) return [];
    const deps: unknown = 'dependencies' in manifest ? manifest.dependencies : undefined;
    if (typeof deps !== 'object' || deps === null) return [];
    return Object.keys(deps).filter((name) => name.startsWith('@modelcontextprotocol/'));
  }

  /**
   * The row is contested because two package families can represent the MCP SDK, and the system must decide between them.
   * `classifySdkImport` still resolves `@modelcontextprotocol/sdk` to `v1` to reject it, so the boundary stays.
   * The installed packages are a separate check: v1 is absent and a v2 package is present.
   */
  it('SdkGenerationRow_RecognisedGenerations_AreRecordedAsContested', () => {
    const row = AUTHORITY_TOPOLOGY['sdk-generation'];
    expect(row.authority.kind).toBe('contested');
    expect(Object.keys(SDK_GENERATION_REPRESENTATIONS).length).toBeGreaterThan(1);

    const installed = installedSdkPackages();
    expect(
      installed.some((p) => p === '@modelcontextprotocol/sdk'),
      'v1 was removed by task 049. Its return is the alongside-install ' +
        'resuming unreviewed — a DR-0 decision to reverse, not a dependency ' +
        'to re-add.',
    ).toBe(false);
    expect(
      installed.some(
        (p) =>
          p === '@modelcontextprotocol/core' ||
          p === '@modelcontextprotocol/server' ||
          p === '@modelcontextprotocol/client',
      ),
      'no v2 package is installed — the server has no SDK at all',
    ).toBe(true);
  });

  /** The representations of the row come from the bridge, so a new generation in the seam appears here without an edit. */
  it('SdkGenerationRow_EveryGeneration_ContributesAnAuthoritativeRepresentation', () => {
    const row = AUTHORITY_TOPOLOGY['sdk-generation'];
    const generationCount = Object.keys(SDK_GENERATION_REPRESENTATIONS).length;

    expect(row.representations.length).toBe(generationCount);
    expect(authoritativeRepresentations(row).length).toBe(generationCount);
  });

  /** Pins the word `ZERO` in the `measured` note, which records a disagreement with the "imported directly" claim of the spec table. */
  it('SdkGenerationRow_MeasuredState_RecordsTheDisagreementWithTheSpecTable', () => {
    expect(AUTHORITY_TOPOLOGY['sdk-generation'].measured).toContain('ZERO');
  });
});
