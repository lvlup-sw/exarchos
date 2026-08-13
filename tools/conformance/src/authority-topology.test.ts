// ─── The authority topology as data (DR-6, G5) — co-located tests ────────────
//
// Scope note: these tests pin the TABLE's own well-formedness, not closure over
// the live tree. Evaluating closure (and failing it) is task 025; proving the
// failure fires live on the CLI-surface and event-catalog rows is task 026.
//
// @oracle-sources: ./authority-topology.ts, ../../../servers/exarchos-mcp/package.json
//
// The two authorities are genuinely independent: the topology rows are a
// committed human judgement about the tree, while `package.json` is the manifest
// npm actually resolves. `authority-topology.ts` imports no JSON and the manifest
// imports nothing, so neither is reachable from the other and the sdk-generation
// cross-check below can really disagree.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fromSubjectPackage } from './subject-root.js';
import { DECLARATION_KINDS } from '../../../servers/exarchos-mcp/src/contract/declaration.js';
import { scanGovernedSources } from '../../../servers/exarchos-mcp/scripts/cli-derivation-guard.js';
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

// ════════════════════════════════════════════════════════════════════════════
// The three required properties
// ════════════════════════════════════════════════════════════════════════════

describe('authority topology — required properties', () => {
  it('AuthorityTopology_EveryRow_NamesExactlyOneAuthorityOrRecordsContested', () => {
    const rows = topologyRows();
    expect(rows.length).toBe(CONTRACT_BOUNDARIES.length);

    for (const row of rows) {
      const authoritative = authoritativeRepresentations(row);

      // The three well-formed states, and nothing else. `single` carries ONE
      // authority id (never an array — see `_AuthorityPluralInSingleArm_
      // FailsCompile`), `contested` carries two or more, `none` says why.
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

      // Every non-authoritative representation states its relationship: `bound`
      // names what binds it, `unbound` names the gap. There is no third,
      // unstated option.
      for (const rep of row.representations) {
        expect(rep.id.length).toBeGreaterThan(0);
        if (rep.binding.kind === 'bound') expect(rep.binding.boundTo.length).toBeGreaterThan(0);
        if (rep.binding.kind === 'unbound') expect(rep.binding.why.length).toBeGreaterThan(0);
      }
    }

    // The live table is well-formed end to end.
    expect(codesOf(checkTopologyTotality(topologyRows(), BOUNDARY_DERIVATIONS))).toEqual([]);
  });

  it('AuthorityTopology_RowWithoutEnforceFrom_FailsTotality', () => {
    // The row is complete in every other respect — only `enforceFrom` is gone.
    // No allowlist, blanket or otherwise, may rescue it.
    const report = checkTopologyTotality([rowDataWithout('enforceFrom')], []);

    expect(report.ok).toBe(false);
    expect(codesOf(report)).toContain('MISSING_ENFORCE_FROM');

    // Control: the same row WITH `enforceFrom` passes, so the failure is
    // attributable to the missing field and not to the fixture being junk.
    const control = checkTopologyTotality([wellFormedRowData()], []);
    expect(control.ok).toBe(true);
    expect(codesOf(control)).toEqual([]);
  });

  it('AuthorityTopology_ZeroRowsResolved_FailsClosed', () => {
    // An empty census reports no findings and passes — the instrument silently
    // dying green. Zero rows must be a failure, never a clean bill of health.
    const report = checkTopologyTotality([], []);

    expect(report.ok).toBe(false);
    expect(report.rowCount).toBe(0);
    expect(codesOf(report)).toContain('EMPTY_TOPOLOGY');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The derivation guarantee — "a boundary absent from the topology is the one
// place an unbound representation can hide"
// ════════════════════════════════════════════════════════════════════════════

describe('authority topology — derived boundaries', () => {
  it('BoundaryDerivations_EveryDeclarationKind_ForcesABoundaryRow', () => {
    // The bridge is total over `DeclarationKind`, so every kind maps to a
    // boundary that the table must carry. A fourth kind landing upstream is a
    // compile error at the bridge, which is the half `tsc` owns; this is the
    // runtime half.
    for (const kind of DECLARATION_KINDS) {
      const boundary = DECLARATION_KIND_BOUNDARIES[kind];
      expect(CONTRACT_BOUNDARIES).toContain(boundary);
      expect(AUTHORITY_TOPOLOGY[boundary].boundary).toBe(boundary);
    }
  });

  it('BoundaryDerivations_RequiredBoundaryMissingFromRows_FailsTotality', () => {
    // The SDK-generation row is the one an earlier revision of this table
    // omitted outright. Drop it and the bridge must notice — otherwise a
    // boundary can go missing and take its unbound representations with it.
    const withoutSdk = topologyRows().filter((row) => row.boundary !== 'sdk-generation');
    const report = checkTopologyTotality(withoutSdk, BOUNDARY_DERIVATIONS);

    expect(report.ok).toBe(false);
    expect(codesOf(report)).toContain('MISSING_DERIVED_BOUNDARY');
    expect(report.diagnostics.some((d) => d.subject === 'sdk-generation')).toBe(true);
  });

  it('BoundaryDerivations_DeclarationKindRowDropped_FailsTotality', () => {
    // Same tooth, on the other bridge: the cli-surface row is required by the
    // `cli-verb` declaration kind.
    const withoutCli = topologyRows().filter((row) => row.boundary !== 'cli-surface');
    const report = checkTopologyTotality(withoutCli, BOUNDARY_DERIVATIONS);

    expect(codesOf(report)).toContain('MISSING_DERIVED_BOUNDARY');
    expect(report.diagnostics.some((d) => d.subject === 'cli-surface')).toBe(true);
  });

  it('RowProvenance_DerivedClaimNoBridgeProduces_IsStaleCover', () => {
    // The second ratchet tooth. A row may not claim it was derived when no
    // bridge requires it — otherwise `provenance` degrades into a label anyone
    // can apply, and the hand-maintained rows stop being visible as such.
    const overclaiming = wellFormedRowData({
      boundary: 'effect-event',
      provenance: { kind: 'derived', from: 'declaration-kinds' },
    });
    const report = checkTopologyTotality([overclaiming], BOUNDARY_DERIVATIONS);

    expect(codesOf(report)).toContain('STALE_DERIVED_PROVENANCE');
  });

  it('RowProvenance_DeclaredRowWithoutRationale_FailsTotality', () => {
    // A hand-maintained row must say why it could not be derived. Silence is
    // how a derivable boundary quietly stays hand-maintained forever.
    const unjustified = wellFormedRowData({ provenance: { kind: 'declared' } });
    const report = checkTopologyTotality([unjustified], []);

    expect(codesOf(report)).toContain('UNJUSTIFIED_DECLARED_ROW');
  });

  it('RowProvenance_EveryDeclaredRow_StatesWhyItIsNotDerivable', () => {
    for (const row of topologyRows()) {
      if (row.provenance.kind === 'declared') {
        expect(row.provenance.whyNotDerivable.length).toBeGreaterThan(40);
      } else {
        // A derived row's bridge really does require it — the same tooth as
        // STALE_DERIVED_PROVENANCE, asserted over the live table.
        const bridge = BOUNDARY_DERIVATIONS.find((d) => d.id === row.provenance.from);
        expect(bridge?.requires).toContain(row.boundary);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G5's sharpest clause: more than one authoritative representation is a finding
// REGARDLESS of whether the copies currently agree
// ════════════════════════════════════════════════════════════════════════════

describe('authority topology — plural authority', () => {
  it('AuthorityTopology_TwoAuthoritativeRepresentations_CannotBeRecordedAsSingle', () => {
    // Two authoritative representations while claiming a single authority is
    // the G5 defect. Note what the check does NOT consult: whether the two
    // representations agree. Only the count matters, which is what makes
    // "they happen to match today" unable to buy a pass.
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

  it('AuthorityTopology_ContestedWithTwoAuthoritativeRepresentations_IsWellFormed', () => {
    // The positive control: the SAME two representations are well-formed once
    // the contest is declared rather than hidden. The finding is the mismatch,
    // not the plurality itself.
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

// ════════════════════════════════════════════════════════════════════════════
// The rows themselves — the spec's measured state, carried as data
// ════════════════════════════════════════════════════════════════════════════

describe('authority topology — the rows', () => {
  it('AuthorityTopology_EveryBoundary_CarriesExactlyOneRowKeyedByItself', () => {
    // Guards the transcription: a row filed under the wrong key would let one
    // boundary's findings be reported against another.
    for (const boundary of CONTRACT_BOUNDARIES) {
      expect(AUTHORITY_TOPOLOGY[boundary].boundary).toBe(boundary);
    }
    expect(Object.keys(AUTHORITY_TOPOLOGY).sort()).toEqual([...CONTRACT_BOUNDARIES].sort());
  });

  it('AuthorityTopology_EveryRow_IsStructurallyValidFromUntypedInput', () => {
    // The runtime half of the envelope guarantee: rows survive a JSON round
    // trip, which is what task 025 does when it loads them from a store.
    for (const row of topologyRows()) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(row));
      expect(isAuthorityTopologyRow(roundTripped)).toBe(true);
    }
  });

  it('AuthorityTopology_UnenforcedRows_CarryAWaveAndADriver', () => {
    // Every row that is not already enforced names the wave AND the DR that
    // lands the enforcement, so the schedule is checkable rather than asserted.
    for (const row of topologyRows()) {
      if (row.enforceFrom.kind === 'wave') {
        expect(row.enforceFrom.driver.length).toBeGreaterThan(0);
      } else {
        expect(row.enforceFrom.by.length).toBeGreaterThan(0);
      }
    }
  });

  it('AuthorityTopology_AlreadyEnforcedRow_HasNoUnboundRepresentation', () => {
    // `already-enforced` is a positive claim, not an exemption: a row making it
    // must actually be closed — exactly one authority, nothing unbound. This is
    // what stops the arm becoming the blanket allowlist the spec forbids.
    for (const row of topologyRows()) {
      if (row.enforceFrom.kind !== 'already-enforced') continue;
      expect(row.authority.kind).toBe('single');
      expect(unboundRepresentations(row)).toEqual([]);
    }
  });

  it('AuthorityTopology_ContestedAndUnboundRows_AreTheOpenOnes', () => {
    // The measured state, pinned. `action-contract` is the only closed row;
    // every other boundary is either contested or carries an unbound
    // representation, which is what tasks 025/026 will fail on.
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
      'phase-sequencing',
      'response-shape',
      'sdk-generation',
    ]);
  });

  it('AuthorityTopology_EveryRow_PinsItsBindingComposition', () => {
    // A characterization pin over each row's (authoritative, bound, unbound)
    // counts — NOT a live-tree proof, which is task 025's census.
    //
    // It exists because relabelling one `unbound(...)` representation as
    // `bound(...)` is otherwise invisible: it launders a finding out of the
    // table without changing any count this file already asserts, and the
    // census downstream would then range over a table that has quietly stopped
    // reporting the gap. Pinning the composition makes that edit red, so
    // re-classifying a representation has to be a conscious, reviewed change
    // with a matching update here.
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
      { boundary: 'effect-event', authoritative: 0, bound: 0, unbound: 2 },
      { boundary: 'event-catalog', authoritative: 1, bound: 0, unbound: 3 },
      { boundary: 'phase-sequencing', authoritative: 1, bound: 0, unbound: 2 },
      { boundary: 'response-shape', authoritative: 1, bound: 0, unbound: 2 },
      { boundary: 'sdk-generation', authoritative: 2, bound: 0, unbound: 0 },
    ];

    expect(composition).toEqual(expected);
  });

  it('AuthorityTopology_CliSurfaceRow_RecordsTheHandWrittenLiteralsAsASecondAuthority', () => {
    const row = AUTHORITY_TOPOLOGY['cli-surface'];
    expect(row.authority.kind).toBe('contested');
    // The hand-written literals are not merely "unbound" — nothing derives them
    // AND nothing derives from them, so they are a second authoritative
    // representation. That distinction is what makes the row contested rather
    // than a single authority with a loose end.
    expect(authoritativeRepresentations(row).length).toBe(2);

    // The row's `measured` note must state a COUNT, and that count must agree
    // with the count baked into the second authority's representation id. The
    // magnitude itself is not pinned here: it was 11 until task 076 deleted the
    // `merge-orchestrate` literal and became 10, and DR-19 drives it to 0. What
    // must never drift is the two halves of the row disagreeing with each other,
    // which is what a hard-coded '11' in this test would have hidden — the note
    // could go stale while the id stayed correct, and nothing would say so.
    const idCount = authoritativeRepresentations(row)
      .map((r) => /\bthe (\d+) hand-written\b/.exec(r.id)?.[1])
      .find((c) => c !== undefined);
    expect(idCount, 'the second authority id states a literal count').toBeDefined();
    expect(row.measured).toContain(idCount as string);

    // …and both agree with the LIVE tree. `authority-live-proof.test.ts` owns the
    // full live measurement; this is the cheap consistency tooth that keeps the
    // committed row from drifting away from it silently.
    expect(Number(idCount)).toBe(scanGovernedSources().literals.length);
  });

  it('AuthorityTopology_EffectEventRow_RecordsNoAuthority', () => {
    // The only row with no authority at all: neither `EffectPlan` nor the
    // append site derives the other.
    const row = AUTHORITY_TOPOLOGY['effect-event'];
    expect(row.authority.kind).toBe('none');
    expect(authoritativeRepresentations(row)).toEqual([]);
    expect(unboundRepresentations(row).length).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The SDK-generation row, cross-checked against the manifest (second authority)
// ════════════════════════════════════════════════════════════════════════════

describe('authority topology — sdk-generation row vs the package manifest', () => {
  /** The MCP SDK package roots the manifest actually installs. */
  function installedSdkPackages(): readonly string[] {
    const manifest: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) return [];
    const deps: unknown = 'dependencies' in manifest ? manifest.dependencies : undefined;
    if (typeof deps !== 'object' || deps === null) return [];
    return Object.keys(deps).filter((name) => name.startsWith('@modelcontextprotocol/'));
  }

  it('SdkGenerationRow_RecognisedGenerations_AreRecordedAsContested', () => {
    // ── WHAT "CONTESTED" MEASURES, corrected by task 049 ────────────────────
    // This test used to assert that BOTH generations were installed, on the
    // reading that the contest is between installed packages. DR-0's migration
    // falsified that reading: v1 is gone and the row is still — correctly —
    // contested.
    //
    // The boundary is contested because two distinct package families can
    // represent "the MCP SDK" and the system must ADJUDICATE between them. That
    // adjudication is live code, not history: `classifySdkImport` must still
    // resolve `@modelcontextprotocol/sdk` to `v1` in order to REJECT it, the
    // mixing lint's kill fixtures still name both, and `contract/sdk/brand.ts` still
    // brands handles by generation so a reintroduced v1 handle fails to compile.
    // Uninstalling a generation resolves the contest for today; it does not
    // dissolve the boundary, and a table that forgot v1 could not classify one
    // if it came back.
    //
    // So the two claims are now asserted SEPARATELY rather than conflated:
    // vocabulary breadth (why the row is contested) and installation reality
    // (which generation actually ships). Conflating them is what made a
    // correctly-migrated tree read as a table gone stale.
    const row = AUTHORITY_TOPOLOGY['sdk-generation'];
    expect(row.authority.kind).toBe('contested');
    expect(Object.keys(SDK_GENERATION_REPRESENTATIONS).length).toBeGreaterThan(1);

    // Installation reality, cross-checked against npm — still a genuinely
    // independent authority, and still able to disagree.
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

  it('SdkGenerationRow_EveryGeneration_ContributesAnAuthoritativeRepresentation', () => {
    // Derived, not restated: the row's representations come from the bridge, so
    // a third generation added to the seam appears here without an edit.
    const row = AUTHORITY_TOPOLOGY['sdk-generation'];
    const generationCount = Object.keys(SDK_GENERATION_REPRESENTATIONS).length;

    expect(row.representations.length).toBe(generationCount);
    expect(authoritativeRepresentations(row).length).toBe(generationCount);
  });

  it('SdkGenerationRow_MeasuredState_RecordsTheDisagreementWithTheSpecTable', () => {
    // The spec's table says both generations are "imported directly". They are
    // both INSTALLED, but v2 has zero production import sites — every v2
    // specifier in the tree is fixture text inside the seam's own test. The row
    // records what the tree says, not what the table asserted.
    expect(AUTHORITY_TOPOLOGY['sdk-generation'].measured).toContain('ZERO');
  });
});
