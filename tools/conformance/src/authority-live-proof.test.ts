// ─── The authority census, proved LIVE against the tree (DR-6, G5, task 026) ─
//
// Task 025's census resolves its `authority` and `binding` hops against task
// 024's committed rows, and says so as data: the evidence table marks both as
// `declared-row` — "a committed measurement, not independent evidence about the
// tree". So the shipped census proves the TABLE is inconsistent. These tests
// prove the TREE is, by rebuilding the two rows task 026 names FROM SOURCE and
// running the same unmodified census over them. Since task 066 re-keyed that
// table by (hop, ROW), these two rows — and only these two — now carry
// `live-measurement`, with a witness this file resolves against the oracle.
//
// Nothing here remediates anything, and nothing here judges: the verdict is
// `runAuthorityCensus`, with its own finding kinds, its own closure rule and its
// own per-row `blocking` schedule. Only the evidence class of its input changes.
//
// @oracle-sources: ../../audit/core/authority-live-proof.ts, ./authority-topology.ts
//
// The two authorities are independent in both senses DR-30 asks about. STATIC:
// `authority-live-proof.ts` imports only `node:*`, `typescript` and task 020's
// `cli-derivation-guard.ts` — nothing from `src/`, not even a type — so its
// transitive module closure and `authority-topology.ts`'s ({contract/
// declaration.ts, architecture/sdk-generation-seam.ts, review/check-catalog.ts,
// sdk/brand.ts}) are disjoint in both directions. SEMANTIC: one is a committed
// human measurement of the tree, written down in a table; the other is an
// executable measurement that reads the tree now. Those are exactly the two
// things task 026 exists to compare, and either can disagree with the other —
// the `PHASE_EXPECTED_EVENTS` partial-binding assertions below are precisely
// where a drift between them would surface.
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EVENT_EMISSION_REGISTRY } from '../../../src/events/schemas.js';
import { PHASE_EXPECTED_EVENTS } from '../../../src/verbs/gates/check-event-emissions.js';
import { topologyRows, type AuthorityTopologyRow } from './authority-topology.js';
import {
  runAuthorityCensus,
  liveMeasuredBoundaries,
  rowEvidence,
  type AuthorityCensusReport,
  type CensusFinding,
} from './authority-census.js';
import {
  scanGovernedSources,
  scanSourceForCommandSites,
  GOVERNED_SOURCES,
  REPO_ROOT,
} from '../../audit/core/cli-derivation-guard.js';
// The namespace import is what lets the evidence table's `oracle.entrypoint`
// be resolved BY NAME against the oracle's real exports (below) rather than
// compared against a string another list also restates.
import * as liveProof from '../../audit/core/authority-live-proof.js';
import {
  EFFECT_EVENT_REPRESENTATION_IDS,
  EFFECT_EVENT_SOURCES,
  EFFECT_PLAN_AUTHORITY,
  EVENT_CATALOG_REPRESENTATION_IDS,
  EVENT_CATALOG_SOURCES,
  bindingFor,
  measureActionEmissions,
  measureEffectEvent,
  measureEmissionSinks,
  readEffectEventSources,
  derivedSites,
  literalSites,
  measureCliSurface,
  measureCliSurfaceLive,
  measureEventCatalog,
  measureObjectLiteralEntries,
  measurePropertyAssignments,
  measureProseEventMentions,
  measureStringValuedEntries,
  measuredRow,
  readEventCatalogSources,
  spliceSites,
  type EventCatalogSources,
  type MeasuredBoundary,
  type MeasuredRepresentation,
  type MeasuredSite,
  GATE_TABLES,
  PHASE_EVENTS_REPRESENTATION_IDS,
  PHASE_EVENTS_SOURCES,
  measurePhaseEvents,
  measurePhaseEventsLive,
  readPhaseEventsSources,
} from '../../audit/core/authority-live-proof.js';

/** The live composition root task 020's guard governs. */
function governedSourcePath(): string {
  const rel = GOVERNED_SOURCES[0];
  if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
  return path.join(REPO_ROOT, rel);
}

// ════════════════════════════════════════════════════════════════════════════
// Harness — substitute a MEASURED row into the committed topology
// ════════════════════════════════════════════════════════════════════════════

/** A finding as a comparable tuple, in task 025's own format. */
const tupleOf = (f: CensusFinding): string => `${f.boundary} | ${f.hop} | ${f.kind} | ${f.subject}`;
const tuplesFor = (report: AuthorityCensusReport, boundary: string): readonly string[] =>
  report.findings.filter((f) => f.boundary === boundary).map(tupleOf);

function committedRow(boundary: string): AuthorityTopologyRow {
  const row = topologyRows().find((r) => r.boundary === boundary);
  if (row === undefined) throw new Error(`the committed ${boundary} row is missing`);
  return row;
}

/**
 * The live topology: task 024's eight rows, with the two rows under proof
 * replaced by their measured counterparts.
 *
 * Substitution rather than a two-row subject, deliberately. Running the census
 * over two rows alone would trip `MISSING_DERIVED_BOUNDARY` for the six absent
 * ones and report findings about the subject instead of about the tree; and the
 * six untouched rows are what keeps the cross-row `ambiguous` tooth live, which
 * is the tooth that catches `PHASE_EXPECTED_EVENTS` being relabelled on one of
 * its two carriers and not the other.
 */
function liveTopology(measured: readonly MeasuredBoundary[]): readonly unknown[] {
  const byBoundary = new Map(measured.map((m) => [m.boundary, m]));
  return topologyRows().map((row) => {
    const live = byBoundary.get(row.boundary);
    return live === undefined ? row : measuredRow(live, row);
  });
}

/**
 * Give the OTHER carrier of a shared representation the measured binding.
 *
 * `PHASE_EXPECTED_EVENTS` belongs to two boundaries. A counterfactual applied
 * to one of them leaves the other's committed claim behind, which task 025's
 * cross-row arm correctly reports as `ambiguous` — so a fully closed boundary
 * is only reachable when both carriers say what the tree says. Used ONLY to
 * complete that control; nothing here edits a committed row.
 */
function alignCarrier(row: unknown, measured: MeasuredBoundary): unknown {
  if (typeof row !== 'object' || row === null) return row;
  if (Reflect.get(row, 'boundary') !== 'phase-sequencing') return row;
  const reps: unknown = Reflect.get(row, 'representations');
  if (!Array.isArray(reps)) return row;
  const shared = measured.representations.find(
    (r) => r.id === EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents,
  );
  if (shared === undefined) return row;
  return {
    ...row,
    representations: reps.map((rep: unknown) => {
      const id: unknown =
        typeof rep === 'object' && rep !== null ? Reflect.get(rep, 'id') : undefined;
      return id === shared.id ? { id: shared.id, binding: shared.binding } : rep;
    }),
  };
}

function representation(m: MeasuredBoundary, id: string): MeasuredRepresentation {
  const rep = m.representations.find((r) => r.id === id);
  if (rep === undefined) {
    throw new Error(
      `measured boundary "${m.boundary}" carries no representation "${id}" (has: ` +
        `${m.representations.map((r) => r.id).join(' | ')})`,
    );
  }
  return rep;
}

// ════════════════════════════════════════════════════════════════════════════
// The CLI-surface row
// ════════════════════════════════════════════════════════════════════════════

describe('authority census — the CLI-surface row, live', () => {
  it('AuthorityCensus_CliSurfaceRow_FailsLiveAgainstTheTree', () => {
    // ── 1. The tree, read now ────────────────────────────────────────────────
    // Task 020's guard, reused unchanged: it reads `adapters/cli/cli.ts` off disk,
    // parses it, and classifies each `.command(` argument. A string literal
    // bakes the name into the composition root; a computed expression takes it
    // from a registry declaration. That distinction is invisible in the built
    // Commander tree — `program.command('doctor')` and `program.command(cliName)`
    // produce byte-identical nodes — which is why this is measured in SOURCE.
    const scan = scanGovernedSources();
    // The names are the claim; the counts follow from them. `merge-orchestrate`
    // left this list in task 076, which deleted its hand-written promotion and
    // moved it onto the registry's `cli.topLevel` hint — so the population is
    // ten, and the row below says ten. The totals are DERIVED from the name list
    // rather than written beside it, because a correct paydown moves them all
    // together and a transcribed total would redden on exactly the change this
    // census exists to encourage.
    const expectedLiterals = [
      'doctor',
      'emissions',
      'feedback',
      'init',
      'install-skills',
      'mcp',
      'onboard',
      'schema',
      'topology',
      'version',
    ];
    expect(scan.literals.map((s) => s.name).sort()).toEqual(expectedLiterals);
    expect(scan.literals).toHaveLength(expectedLiterals.length);
    expect(scan.derived).toHaveLength(3);
    expect(scan.indeterminate).toHaveLength(0);
    expect(scan.sites).toHaveLength(scan.literals.length + scan.derived.length);

    // ── 2. The row, BUILT from that measurement ──────────────────────────────
    // The authority arm is computed from the count of authoritative
    // representations (the `sdkAuthority()` idiom), never written down. There
    // is no branch that can report `single` while two are present.
    const cli = measureCliSurface(scan);
    expect(cli.authority).toEqual({
      kind: 'contested',
      candidates: ['registry', 'adapters/cli/cli.ts hand-written `.command()` literals'],
    });
    expect(
      cli.representations.filter((r) => r.binding.kind === 'authoritative').map((r) => r.id),
    ).toEqual([
      'registry action descriptor (TOOL_REGISTRY)',
      "the 10 hand-written `.command('…')` literals in `adapters/cli/cli.ts`",
    ]);
    // The derived loops are NOT reported as a second authority — they are bound
    // to the registry, which is what makes the finding narrow rather than a
    // blanket complaint about the file.
    expect(representation(cli, 'the registry-derived command tree').binding.kind).toBe('bound');
    expect(derivedSites(representation(cli, 'the registry-derived command tree'))).toHaveLength(3);

    // ── 3. The two authorities agree — which is the corroboration ────────────
    // The measured representation id reproduces the COMMITTED row's id string,
    // count included. Task 024 wrote "the 11 hand-written …" from a human read
    // of the tree; the parser arrives at the same 11 independently. A drift in
    // the live count changes the id, which changes the census tuple, rather than
    // hiding inside a number nothing compares.
    const committed = committedRow('cli-surface');
    expect(cli.representations.map((r) => r.id).sort()).toEqual(
      committed.representations.map((r) => r.id).sort(),
    );
    expect(cli.authority).toEqual(committed.authority);

    // ── 4. The census, run over the measured row ─────────────────────────────
    const live = runAuthorityCensus(liveTopology([cli]));
    expect(live.totality.ok).toBe(true);
    // Every measured row narrowed through `isAuthorityTopologyRow`. Without
    // this the census would silently drop a malformed measurement and report a
    // smaller, cleaner tree. `topologyRows().length` (not a transcribed
    // count) is the independent population `liveTopology` maps over — see
    // `liveTopology`'s definition below.
    expect(live.evaluatedRows).toBe(live.rowCount);
    expect(live.evaluatedRows).toBe(topologyRows().length);

    expect(tuplesFor(live, 'cli-surface')).toEqual(['cli-surface | authority | ambiguous | cli-surface']);
    expect(live.ok).toBe(false);
    expect(live.openBoundaries).toContain('cli-surface');
    expect(live.closedBoundaries).not.toContain('cli-surface');

    // ── 5. SENSITIVITY CONTROL — the proof goes green when the fact changes ──
    // The counterfactual is applied to the LIVE source in memory: every baked
    // `.command('name')` is rewritten to take its name from the registry. If the
    // proof merely asserted failure it would stay red here.
    const cliSource = readFileSync(governedSourcePath(), 'utf8');
    const derivedEverywhere = cliSource.replace(/\.command\(\s*'[^']*'/g, '.command(cliName');
    expect(derivedEverywhere).not.toBe(cliSource);

    const afterScan = scanSourceForCommandSites(derivedEverywhere, GOVERNED_SOURCES[0] ?? 'cli.ts');
    // The counterfactual PRESERVES the site count and moves every one of them
    // from `literal` to `derived` — stated against the live scan rather than a
    // transcribed total, so paying a literal down does not redden the control.
    expect(afterScan.sites).toHaveLength(scan.sites.length);
    expect(afterScan.literals).toHaveLength(0);
    expect(afterScan.derived).toHaveLength(scan.sites.length);

    const remediated = measureCliSurface(afterScan);
    expect(remediated.authority).toEqual({ kind: 'single', authority: 'registry' });
    const green = runAuthorityCensus(liveTopology([remediated]));
    expect(tuplesFor(green, 'cli-surface')).toEqual([]);
    expect(green.closedBoundaries).toContain('cli-surface');

    // The control is specific, not a global amnesty: every OTHER row's findings
    // are untouched, so the green above is the cli-surface fact moving and
    // nothing else.
    expect(green.findings.filter((f) => f.boundary !== 'cli-surface').map(tupleOf)).toEqual(
      live.findings.filter((f) => f.boundary !== 'cli-surface').map(tupleOf),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The event-catalog row
// ════════════════════════════════════════════════════════════════════════════

describe('authority census — the event-catalog row, live', () => {
  it('AuthorityCensus_EventCatalogRow_FailsLiveAgainstTheTree', () => {
    const sources = readEventCatalogSources();
    const catalog = measureEventCatalog(sources);

    // ── 1. The authority, read from its own declaration ──────────────────────
    // Cross-checked against the LIVE imported registry. The parse is a static
    // under-approximation (`registerEventType` can add custom types at runtime),
    // so the claim is containment, not equality — stated rather than smoothed
    // over. A parse that lost entries would break this immediately.
    const liveEvents: ReadonlyMap<string, string> = new Map(
      Object.entries(EVENT_EMISSION_REGISTRY),
    );
    expect(catalog.registeredEvents.size).toBeGreaterThan(100);
    for (const [event, source] of catalog.registeredEvents) {
      expect(liveEvents.has(event)).toBe(true);
      expect(liveEvents.get(event)).toBe(source);
    }
    expect(catalog.modelEvents.size).toBeGreaterThan(0);

    // ── 2. `PHASE_EXPECTED_EVENTS` — the partial-binding trap, MEASURED ──────
    // 2 of 6 entries derive; 4 are hand-written literal arrays. The module-load
    // loop validates that every event the table LISTS is registered and
    // `model`-sourced, and can never see an event that should be listed and is
    // not. Partial derivation is therefore not a binding, and the measurement
    // records the split rather than collapsing it to a verdict.
    // ── 2. `PHASE_EVENT_CONTRACTS` — declared rows, MEASURED ─────────────────
    // The contract declares which phase expects which event. Every row names its
    // event as a literal: the fact is authored here and validated against the
    // registry at load, never computed from it — so the representation is
    // unbound by the census's rule, and honestly so. The old half-derived gate
    // table this section used to measure is now a projection of these rows and
    // is measured by the `phase-events` row below.
    const phase = representation(catalog, EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents);
    expect(phase.sites.length).toBeGreaterThan(10);
    expect(derivedSites(phase)).toHaveLength(0);
    expect(literalSites(phase)).toHaveLength(phase.sites.length);
    expect(phase.binding.kind).toBe('unbound');
    const declared = new Set(phase.sites.map((s) => s.subject));
    for (const expected of Object.values(PHASE_EXPECTED_EVENTS).flat()) {
      expect(declared.has(expected), `${expected} is a declared row`).toBe(true);
    }
    const emissionRows = representation(catalog, EVENT_CATALOG_REPRESENTATION_IDS.emissions);
    expect(emissionRows.sites.length).toBeGreaterThan(0);
    expect(derivedSites(emissionRows)).toHaveLength(0);
    expect(literalSites(emissionRows)).toHaveLength(emissionRows.sites.length);
    expect(emissionRows.binding.kind).toBe('unbound');

    // ── 4. Skill prose — unbound structurally, not by measurement outcome ────
    const prose = representation(catalog, EVENT_CATALOG_REPRESENTATION_IDS.prose);
    expect(prose.sites.length).toBeGreaterThan(0);
    expect(new Set(prose.sites.map((s) => s.file)).size).toBeGreaterThan(1);
    for (const site of prose.sites) {
      expect(site.file.endsWith('.md')).toBe(true);
      expect(site.kind).toBe('literal');
      expect(catalog.modelEvents.has(site.subject)).toBe(true);
    }
    expect(prose.binding.kind).toBe('unbound');

    // ── 5. The census, run over the measured row ─────────────────────────────
    const live = runAuthorityCensus(liveTopology([catalog]));
    expect(live.totality.ok).toBe(true);
    // Derived against the same independent population as the cli-surface
    // proof above — `liveTopology` maps over every row `topologyRows()`
    // returns.
    expect(live.evaluatedRows).toBe(topologyRows().length);
    expect(tuplesFor(live, 'event-catalog')).toEqual([
      `event-catalog | binding | missing | ${EVENT_CATALOG_REPRESENTATION_IDS.prose}`,
      `event-catalog | binding | missing | ${EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents}`,
      `event-catalog | binding | missing | ${EVENT_CATALOG_REPRESENTATION_IDS.emissions}`,
    ]);
    expect(live.ok).toBe(false);

    // ── 6. The cross-row tooth is NOT undone ─────────────────────────────────
    // `PHASE_EXPECTED_EVENTS` is carried by BOTH the event-catalog and the
    // phase-sequencing rows. The measured row must keep claiming `unbound` for
    // it, because relabelling it here and not there would launder the finding
    // out of half the table while every per-row count stayed put — which task
    // 025 added the cross-row `ambiguous` arm to catch.
    const carriers = live.findings.filter(
      (f) => f.subject === EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents,
    );
    expect(carriers.map((f) => f.boundary).sort()).toEqual(['event-catalog', 'phase-sequencing']);
    expect(carriers.map((f) => f.kind)).toEqual(['missing', 'missing']);
    expect(live.findings.filter((f) => f.hop === 'binding' && f.kind === 'ambiguous')).toEqual([]);

    // ── 7. SENSITIVITY CONTROL A — the partial-binding trap itself ───────────
    // Derive FIVE of the six entries and leave one literal. If the proof
    // measured "a derivation exists" it would go green here; it must not,
    // because G5 is a claim about the population. This is the control that
    // separates measuring the fact from measuring the presence of a check.
    // All but one row computed must NOT close the row — partial derivation is
    // not a binding over the population.
    const onlyOneLeft = spliceSites(
      sources.phaseExpectedEvents,
      literalSites(phase).slice(0, -1),
      (site) => `eventFor('${site.subject}')`,
    );
    const allButOne = measureEventCatalog({ ...sources, phaseExpectedEvents: onlyOneLeft });
    const stillOpen = representation(
      allButOne,
      EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents,
    );
    expect(derivedSites(stillOpen)).toHaveLength(phase.sites.length - 1);
    expect(literalSites(stillOpen)).toHaveLength(1);
    expect(stillOpen.binding.kind).toBe('unbound');
    expect(
      tuplesFor(runAuthorityCensus(liveTopology([allButOne])), 'event-catalog'),
    ).toContain(
      `event-catalog | binding | missing | ${EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents}`,
    );
    const allDerived = spliceSites(
      sources.phaseExpectedEvents,
      literalSites(phase),
      (site) => `eventFor('${site.subject}')`,
    );
    const emissionsDerived = spliceSites(
      sources.emissions,
      literalSites(emissionRows),
      () => 'eventFor(name)',
    );
    const proseRedacted: EventCatalogSources['docs'] = sources.docs.map((doc) => ({
      file: doc.file,
      text: [...catalog.modelEvents].reduce(
        (text, event) => text.split(event).join('«redacted-event»'),
        doc.text,
      ),
    }));

    const remediated = measureEventCatalog({
      authority: sources.authority,
      // The per-event tier/lifecycle declarations the emission source is derived from (task 011);
      // unmodified here, because this counterfactual remediates the REPRESENTATIONS, not the
      // authority.
      annotations: sources.annotations,
      emissions: emissionsDerived,
      phaseExpectedEvents: allDerived,
      docs: proseRedacted,
    });
    expect(
      representation(remediated, EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents).binding.kind,
    ).toBe('bound');
    expect(representation(remediated, EVENT_CATALOG_REPRESENTATION_IDS.emissions).binding.kind).toBe(
      'bound',
    );
    // The prose representation does not become "bound" — it ceases to exist.
    // Markdown has no expression that could derive it, so the only way for it to
    // stop being a finding is for it to stop being a representation.
    expect(remediated.representations.map((r) => r.id)).not.toContain(
      EVENT_CATALOG_REPRESENTATION_IDS.prose,
    );

    const green = runAuthorityCensus(liveTopology([remediated]));
    expect(green.totality.ok).toBe(true);

    // All three of the row's OWN findings are gone — the fact moved, and the
    // proof followed it.
    expect(tuplesFor(green, 'event-catalog').filter((t) => t.includes('| missing |'))).toEqual([]);

    // What is left is trap #2, live. `PHASE_EXPECTED_EVENTS` is carried by two
    // rows; the counterfactual derives it for the event-catalog row and leaves
    // the phase-sequencing row's committed claim saying `unbound`. Task 025's
    // cross-row arm reports that disagreement on BOTH carriers rather than
    // letting half the table go quiet — which is exactly the laundering it was
    // added to catch, and this is the first time it has fired against a real
    // change rather than a fixture. Task 026 does not undo it.
    const stale = `binding | ambiguous | ${EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents}`;
    expect(tuplesFor(green, 'event-catalog')).toEqual([`event-catalog | ${stale}`]);
    expect(tuplesFor(green, 'phase-sequencing')).toContain(`phase-sequencing | ${stale}`);

    // And the genuinely-closed state, to complete the control: the boundary
    // closes clean once BOTH carriers of the representation record what the
    // (counterfactual) tree says. Carried here as a fixture only — task 026
    // measures the event-catalog row and does not move the phase-sequencing
    // row, whose other representation (the phase playbooks) stays unbound
    // either way.
    const closed = runAuthorityCensus(
      liveTopology([remediated]).map((row) => alignCarrier(row, remediated)),
    );
    expect(closed.totality.ok).toBe(true);
    expect(tuplesFor(closed, 'event-catalog')).toEqual([]);
    expect(closed.closedBoundaries).toContain('event-catalog');
    expect(closed.openBoundaries).toContain('phase-sequencing');

    // And a finding worth stating plainly, surfaced by running the control
    // rather than by reasoning about it: binding `PHASE_EXPECTED_EVENTS` to the
    // EVENT registry does not bind it to the HSM guard. The phase-sequencing
    // row's authority is `HSM guard (INV-9)`, so the aligned claim points
    // somewhere that row does not declare, and task 025's two-way ratchet
    // reports it as `stale-exception` instead of accepting the label. ONE
    // representation carried by two boundaries needs a binding per boundary —
    // deriving the event names says nothing about whether the phase KEYS track
    // the HSM phase set, which is the gap the phase-sequencing row records.
    expect(tuplesFor(closed, 'phase-sequencing')).toEqual([
      `phase-sequencing | binding | stale-exception | ${EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents}`,
      'phase-sequencing | binding | missing | the phase playbooks',
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The empty-denominator posture
// ════════════════════════════════════════════════════════════════════════════

describe('authority census — the live proof fails closed', () => {
  it('AuthorityCensus_LiveProof_ZeroSubjectsResolved_FailsClosed', () => {
    const sources = readEventCatalogSources();

    // ── The authority ────────────────────────────────────────────────────────
    // A registry that parses cleanly and declares nothing. Without this tooth
    // the model-event set is empty, no prose mention can match, and the prose
    // representation quietly disappears from the boundary.
    expect(() =>
      measureStringValuedEntries(
        'export const EVENT_EMISSION_REGISTRY = {};\n',
        'fixture.ts',
        'EVENT_EMISSION_REGISTRY',
      ),
    ).toThrow(/ZERO string-valued entries/);
    expect(() =>
      measureStringValuedEntries('export const somethingElse = 1;\n', 'fixture.ts', 'EVENT_EMISSION_REGISTRY'),
    ).toThrow(/ZERO string-valued entries/);

    // ── The phase table ──────────────────────────────────────────────────────
    // A renamed or moved constant must fail, not report a bound representation
    // because it found no unbound entries.
    expect(() =>
      measureObjectLiteralEntries(
        sources.phaseExpectedEvents,
        EVENT_CATALOG_SOURCES.phaseExpectedEvents,
        'PHASE_EXPECTED_EVENTS_RENAMED',
      ),
    ).toThrow(/resolved ZERO sites/);

    // ── The emission-row population ──────────────────────────────────────────
    // The generic helper, on a property name nothing declares.
    expect(() =>
      measurePropertyAssignments(sources.emissions, EVENT_CATALOG_SOURCES.emissions, 'autoEmitz'),
    ).toThrow(/resolved ZERO sites/);

    // The row scan itself. These rows have already moved once — they were a
    // sibling `autoEmits:` array before the action contract absorbed them, and
    // the scan that went looking for the old name resolved zero sites. It threw
    // instead of reporting a catalog with nothing unbound in it, which is the
    // only reason the move was visible at all. The tooth stays.
    expect(() => measureActionEmissions('export const nothing = 1;\n', 'fixture.ts')).toThrow(
      /resolved ZERO sites/,
    );

    // …and it must stay SPECIFIC to emission rows. `event:` on its own also
    // appears on the postcondition rows and in the request schemas; counting
    // those would inflate the denominator with sites that say nothing about
    // this representation, and would keep the scan alive on a tree where every
    // real emission row had been deleted.
    expect(() =>
      measureActionEmissions(
        "const x = { source: 'event-append', when: 'success', event: 'export.executed' };\n",
        'fixture.ts',
      ),
    ).toThrow(/resolved ZERO sites/);
    const oneRow = measureActionEmissions(
      "const x = { event: 'workflow.started', condition: 'always', owner: 'w', role: 'primary' };\n",
      'fixture.ts',
    );
    expect(oneRow.map((s) => [s.subject, s.kind])).toEqual([['workflow.started', 'literal']]);

    // ── The prose corpus ─────────────────────────────────────────────────────
    // The tooth is on the CORPUS, not on the result: an empty corpus is a broken
    // scan and throws; a non-empty corpus in which nothing matches is the honest
    // report that the representation is absent (control B above depends on being
    // able to tell those apart).
    expect(() => measureProseEventMentions([], new Set(['team.spawned']))).toThrow(/corpus is EMPTY/);
    expect(() => measureProseEventMentions(sources.docs, new Set())).toThrow(
      /event set is EMPTY/,
    );
    expect(
      measureProseEventMentions([{ file: 'x.md', text: 'no events here' }], new Set(['team.spawned'])),
    ).toEqual([]);

    // ── The CLI scan ─────────────────────────────────────────────────────────
    // A composition root that registers nothing is a broken scan, not a
    // boundary with one authority. Task 020's guard fails closed first; the
    // measurement fails closed too when handed a scan it did not produce.
    expect(() => measureCliSurface({ sites: [], literals: [], derived: [], indeterminate: [] })).toThrow(
      /ZERO `\.command\(` sites/,
    );
    const indeterminate = scanSourceForCommandSites('program.command();\n', 'fixture.ts');
    expect(indeterminate.indeterminate).toHaveLength(1);
    expect(() => measureCliSurface(indeterminate)).toThrow(/could not be classified/);
    expect(() => measureCliSurfaceLive(mkdtempSync(path.join(tmpdir(), 'imo-026-')))).toThrow(
      /does not exist/,
    );

    // ── Reading the tree ─────────────────────────────────────────────────────
    expect(() => readEventCatalogSources(mkdtempSync(path.join(tmpdir(), 'imo-026-')))).toThrow(
      /is not a directory/,
    );

    // ── A recovered parse is fatal, and carries THIS module's name ───────────
    expect(() => measureObjectLiteralEntries('const x = (;', 'broken.ts', 'X')).toThrow(
      /authority-live-proof: broken\.ts did not parse cleanly/,
    );

    // ── And the census itself still refuses an empty subject ─────────────────
    // The proof cannot pass by handing the shipped census nothing to range over.
    const empty = runAuthorityCensus([]);
    expect(empty.ok).toBe(false);
    expect(empty.bindingSubjectCount).toBe(0);
  });

  it('AuthorityCensus_LiveProof_UpgradesEvidenceForTheMeasuredRowsOnly', () => {
    // What the oracle did and did NOT earn, stated where CI can see it.
    //
    // The evidence field is keyed by (hop, ROW) precisely so this cannot be an
    // all-or-nothing flip: moving `authority`/`binding` away from `declared-row`
    // wholesale would claim live evidence for all eight rows when only the
    // measured ones have any. These rows, and only these, have a measurement
    // that reads the tree.
    const LIVE = ['cli-surface', 'effect-event', 'event-catalog', 'phase-events'];
    expect([...liveMeasuredBoundaries()].sort()).toEqual(LIVE);
    for (const boundary of topologyRows().map((r) => r.boundary)) {
      if (!LIVE.includes(boundary)) continue;
      expect(rowEvidence(boundary).authority.evidence).toBe('live-measurement');
      expect(rowEvidence(boundary).binding.evidence).toBe('live-measurement');
    }
    // The rest earned nothing and stay strictly weaker on both row-resolved hops.
    const declaredOnly = topologyRows()
      .map((r) => r.boundary)
      .filter((b) => !LIVE.includes(b));
    expect(declaredOnly).toHaveLength(5);
    for (const boundary of declaredOnly) {
      expect(rowEvidence(boundary).authority.evidence).toBe('declared-row');
      expect(rowEvidence(boundary).binding.evidence).not.toBe('live-measurement');
    }

    // ── The witness is checked, not described ────────────────────────────────
    // Every `live-measurement` entry names a module, an exported entrypoint and
    // the tree paths the measurement reads. Here — the one place that can import
    // BOTH the evidence table and the oracle — each part is resolved against the
    // oracle itself, so a row cannot claim a live measurement by describing one.
    const oracleExports: Record<string, unknown> = { ...liveProof };
    const declaredSubjects = new Set<string>();
    for (const boundary of liveMeasuredBoundaries()) {
      for (const hop of ['authority', 'binding'] as const) {
        const cell = rowEvidence(boundary)[hop];
        expect(cell.evidence).toBe('live-measurement');
        if (cell.evidence !== 'live-measurement') continue;
        expect(cell.oracle.module).toBe('tools/audit/core/authority-live-proof.ts');
        expect(existsSync(path.join(REPO_ROOT, cell.oracle.module))).toBe(true);
        expect(typeof oracleExports[cell.oracle.entrypoint]).toBe('function');
        for (const subject of cell.oracle.subjects) {
          expect(existsSync(path.join(REPO_ROOT, subject))).toBe(true);
          declaredSubjects.add(subject);
        }
      }
    }
    // …and the declared subject set is exactly what the oracle's own source
    // lists say it reads — DERIVED from `GOVERNED_SOURCES` +
    // `EVENT_CATALOG_SOURCES`, never restated here. A source added to either
    // list without reaching the evidence table fails this.
    expect([...declaredSubjects].sort()).toEqual(
      [
        ...new Set([
          ...GOVERNED_SOURCES,
          ...Object.values(EVENT_CATALOG_SOURCES),
          ...Object.values(EFFECT_EVENT_SOURCES),
          ...Object.values(PHASE_EVENTS_SOURCES).flat(),
        ]),
      ].sort(),
    );

    const measured: readonly MeasuredBoundary[] = [
      measureCliSurfaceLive(),
      measureEventCatalog(readEventCatalogSources()),
      measureEffectEvent(readEffectEventSources()),
      measurePhaseEventsLive(),
    ];
    expect(measured.map((m) => m.boundary).sort()).toEqual([
      'cli-surface',
      'effect-event',
      'event-catalog',
      'phase-events',
    ]);

    // The live report and the committed report agree, finding for finding, over
    // the WHOLE table. That is the corroboration this proof exists to produce:
    // the measured rows for these boundaries were not merely plausible, they
    // are what the tree says. The action-contract row names the closure
    // instrument and is closed; it does not report an enforcement stale-exception.
    const committedReport = runAuthorityCensus();
    const liveReport = runAuthorityCensus(liveTopology(measured));
    expect(liveReport.findings.map(tupleOf)).toEqual(committedReport.findings.map(tupleOf));
    expect(liveReport.representationCount).toBe(committedReport.representationCount);
    expect(liveReport.bindingSubjectCount).toBe(committedReport.bindingSubjectCount);
    expect(liveReport.closedBoundaries).toEqual(['action-contract']);
    expect(
      liveReport.findings.some(
        (f) =>
          f.boundary === 'action-contract' &&
          f.hop === 'enforcement' &&
          f.kind === 'stale-exception',
      ),
    ).toBe(false);

    // `bindingFor` is total over the two outcomes, and the rule is the one thing
    // this module decides: all-derived is bound, anything else is not.
    const derived: MeasuredSite = {
      file: 'f.ts',
      line: 1,
      kind: 'derived',
      subject: 'a',
      expression: 'f(x)',
      start: 0,
      end: 4,
    };
    const literal: MeasuredSite = {
      file: 'f.ts',
      line: 2,
      kind: 'literal',
      subject: 'b',
      expression: "'b'",
      start: 5,
      end: 8,
    };
    expect(bindingFor([derived, derived], 'A', 'how', 'why').kind).toBe('bound');
    expect(bindingFor([derived, literal], 'A', 'how', 'why').kind).toBe('unbound');
    expect(bindingFor([literal], 'A', 'how', 'why').kind).toBe('unbound');
  });

  it('AuthorityLiveProof_EffectEventRow_NamesItsOracleModule', () => {
    // The witness on the row resolves: the module exists, the entrypoint is a
    // real exported function of it, and both hops name the same one. A row can
    // otherwise claim a live measurement by describing one.
    for (const hop of ['authority', 'binding'] as const) {
      const cell = rowEvidence('effect-event')[hop];
      expect(cell.evidence).toBe('live-measurement');
      if (cell.evidence !== 'live-measurement') continue;
      expect(cell.oracle.module).toBe('tools/audit/core/authority-live-proof.ts');
      expect(existsSync(path.join(REPO_ROOT, cell.oracle.module))).toBe(true);
      expect(typeof Reflect.get(liveProof, cell.oracle.entrypoint)).toBe('function');
      expect(cell.oracle.entrypoint).toBe('measureEffectEvent');
    }

    const sources = readEffectEventSources();
    const measured = measureEffectEvent(sources);

    // What the tree says, stated as the split it actually is. The ledger owner
    // names the event it appends off the emission it was handed; the promoter
    // discards the emission and hands a typed record to a destination its caller
    // owns. Both mint a receipt, so the carrier's commit gate cannot tell them
    // apart — this measurement is the only thing that can.
    expect(measured.authority).toEqual({ kind: 'single', authority: EFFECT_PLAN_AUTHORITY });
    const bindingById = new Map(measured.representations.map((r) => [r.id, r.binding.kind]));
    expect(bindingById.get(EFFECT_EVENT_REPRESENTATION_IDS.plan)).toBe('authoritative');
    expect(bindingById.get(EFFECT_EVENT_REPRESENTATION_IDS.vcsLedger)).toBe('bound');
    expect(bindingById.get(EFFECT_EVENT_REPRESENTATION_IDS.promotion)).toBe('unbound');

    // The COUNTERFACTUAL, applied to the exact span the measurement classified.
    // Rewrite the ledger owner's sink into one that ignores the emission and the
    // representation must stop being bound — otherwise `bound` here is a
    // property of the code being present, not of it deriving anything, and the
    // row would close on a sink that had quietly stopped following the plan.
    const vcsSinks = measureEmissionSinks(sources.vcsLedger, EFFECT_EVENT_SOURCES.vcsLedger);
    expect(vcsSinks.length).toBeGreaterThan(0);
    expect(literalSites({ id: 'x', binding: { kind: 'authoritative' }, sites: vcsSinks })).toEqual(
      [],
    );
    const blinded = spliceSites(
      sources.vcsLedger,
      vcsSinks,
      () => 'emissionRecorder(async () => { await Promise.resolve(); })',
    );
    const blindedSinks = measureEmissionSinks(blinded, EFFECT_EVENT_SOURCES.vcsLedger);
    expect(blindedSinks.every((s) => s.kind === 'literal')).toBe(true);
    expect(bindingFor(blindedSinks, EFFECT_PLAN_AUTHORITY, 'how', 'why').kind).toBe('unbound');
    // CONTROL: the unmutated sinks still bind, so the flip above is attributable
    // to the splice and not to the re-measurement being broken.
    expect(bindingFor(vcsSinks, EFFECT_PLAN_AUTHORITY, 'how', 'why').kind).toBe('bound');

    // Deleting the commit gate must take the authority claim with it. Without
    // this the `single` authority above would survive the field becoming a
    // comment, which is the whole difference between a declaration and a rule.
    const gutted = sources.carrier.split('throw new UnrecordedEmissionError').join('void 0; //');
    expect(() => measureEffectEvent({ ...sources, carrier: gutted })).toThrow(
      /ZERO .*UnrecordedEmissionError/,
    );
  });
});

describe('authority census — the phase-events row, live', () => {
  it('AuthorityCensus_PhaseEventsRow_DerivedSurfacesAreBoundAndProseIsNot', () => {
    const sources = readPhaseEventsSources();
    const measured = measurePhaseEvents(sources);

    // The authority: every declared row names its event as a literal.
    const authority = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.authority);
    expect(authority.sites.length).toBeGreaterThan(10);
    expect(derivedSites(authority)).toHaveLength(0);

    // The gate tables: both computed from the contract.
    const gate = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.gate);
    expect(gate.sites.map((s) => s.subject).sort()).toEqual([...GATE_TABLES].sort());
    expect(literalSites(gate)).toHaveLength(0);
    expect(gate.binding.kind).toBe('bound');

    // The playbooks: every `events` / `autoEmittedEvents` row computed.
    const playbooks = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.playbooks);
    expect(playbooks.sites.length).toBeGreaterThan(30);
    expect(literalSites(playbooks)).toHaveLength(0);
    expect(playbooks.binding.kind).toBe('bound');

    // The prose: authored, counted, unbound.
    const prose = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.prose);
    expect(prose.sites.length).toBeGreaterThan(0);
    expect(prose.binding.kind).toBe('unbound');

    // The census over the live row: open on the prose alone. The row enforces
    // from wave-5, so at the default wave the finding is reported, not blocking.
    const live = runAuthorityCensus(liveTopology([measured]));
    expect(live.totality.ok).toBe(true);
    expect(tuplesFor(live, 'phase-events')).toEqual([
      `phase-events | binding | missing | ${PHASE_EVENTS_REPRESENTATION_IDS.prose}`,
    ]);
    expect(live.blocking.filter((f) => f.boundary === 'phase-events')).toHaveLength(0);
    const atWave5 = runAuthorityCensus(liveTopology([measured]), { atWave: 'wave-5' });
    expect(atWave5.blocking.filter((f) => f.boundary === 'phase-events')).toHaveLength(1);
    expect(
      live.findings.filter((f) => f.boundary === 'phase-events' && f.hop === 'enforcement'),
    ).toEqual([]);
  });

  it('AuthorityCensus_PhaseEventsRow_ASeededBakedRowIsNamed', () => {
    const sources = readPhaseEventsSources();
    const measured = measurePhaseEvents(sources);
    const playbooks = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.playbooks);
    const gate = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.gate);

    // One playbook row written back as a literal array reopens the binding.
    const [firstRow] = playbooks.sites;
    expect(firstRow).toBeDefined();
    if (firstRow === undefined) return;
    const bakedPlaybooks = spliceSites(
      sources.playbooks,
      [firstRow],
      () => "[{ type: 'team.spawned', when: 'seeded' }]",
    );
    const seeded = measurePhaseEvents({ ...sources, playbooks: bakedPlaybooks });
    expect(representation(seeded, PHASE_EVENTS_REPRESENTATION_IDS.playbooks).binding.kind).toBe(
      'unbound',
    );
    expect(tuplesFor(runAuthorityCensus(liveTopology([seeded])), 'phase-events')).toContain(
      `phase-events | binding | missing | ${PHASE_EVENTS_REPRESENTATION_IDS.playbooks}`,
    );

    // A gate table written back as a literal reopens the binding.
    const [gateSite] = gate.sites;
    expect(gateSite).toBeDefined();
    if (gateSite === undefined) return;
    const bakedGate = spliceSites(sources.gate, [gateSite], () => '{}');
    expect(
      representation(
        measurePhaseEvents({ ...sources, gate: bakedGate }),
        PHASE_EVENTS_REPRESENTATION_IDS.gate,
      ).binding.kind,
    ).toBe('unbound');

    // A renamed gate table fails closed rather than measuring nothing.
    expect(() =>
      measurePhaseEvents({
        ...sources,
        gate: sources.gate.split('PHASE_EXPECTED_EVENTS').join('PHASE_EXPECTED_EVENTS_RENAMED'),
      }),
    ).toThrow(/exports no constant named PHASE_EXPECTED_EVENTS/);
  });
});
