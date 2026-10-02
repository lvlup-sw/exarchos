// The authority census, proved live against the tree.
//
// The shipped census resolves its `authority` and `binding` hops against committed rows. Its
// evidence table marks them `declared-row`: a committed measurement, not evidence about the tree.
// These tests rebuild the measured rows from source and run the same census over them. The
// measured rows carry `live-measurement`, with a witness that this file resolves against the
// oracle.
//
// Nothing here remediates or judges. `runAuthorityCensus` gives the verdict, with its own finding
// kinds, closure rule and per-row `blocking` schedule. Only the evidence class of its input changes.
//
// @oracle-sources: ../../audit/core/authority-live-proof.ts, ./authority-topology.ts
//
// The two authorities differ in kind. One is a committed human measurement in a table. The other
// reads the tree now. Either can disagree with the other.
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

/** The live composition root that the CLI derivation guard governs. */
function governedSourcePath(): string {
  const rel = GOVERNED_SOURCES[0];
  if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
  return path.join(REPO_ROOT, rel);
}

/** A finding as a comparable tuple, in the census format. */
const tupleOf = (f: CensusFinding): string => `${f.boundary} | ${f.hop} | ${f.kind} | ${f.subject}`;
const tuplesFor = (report: AuthorityCensusReport, boundary: string): readonly string[] =>
  report.findings.filter((f) => f.boundary === boundary).map(tupleOf);

function committedRow(boundary: string): AuthorityTopologyRow {
  const row = topologyRows().find((r) => r.boundary === boundary);
  if (row === undefined) throw new Error(`the committed ${boundary} row is missing`);
  return row;
}

/**
 * The live topology: the committed rows, with each row under proof replaced by its measured
 * counterpart.
 *
 * A subject with only the measured rows trips `MISSING_DERIVED_BOUNDARY` for the absent rows. The
 * findings are then about the subject, not the tree. The untouched rows also keep the cross-row
 * `ambiguous` check live. That check catches a relabel of `PHASE_EXPECTED_EVENTS` on only one of
 * its two carriers.
 */
function liveTopology(measured: readonly MeasuredBoundary[]): readonly unknown[] {
  const byBoundary = new Map(measured.map((m) => [m.boundary, m]));
  return topologyRows().map((row) => {
    const live = byBoundary.get(row.boundary);
    return live === undefined ? row : measuredRow(live, row);
  });
}

/**
 * Gives the other carrier of a shared representation the measured binding.
 *
 * `PHASE_EXPECTED_EVENTS` belongs to two boundaries. A counterfactual on one of them leaves the
 * committed claim of the other, and the cross-row arm reports `ambiguous`. A boundary closes fully
 * only when both carriers say what the tree says. This function only completes that control. It
 * does not edit a committed row.
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

describe('authority census — the CLI-surface row, live', () => {
  /**
   * The CLI derivation guard reads the tree now. A literal bakes a command name into the
   * composition root, and a computed expression takes it from the registry. The built Commander
   * tree cannot show this difference, so the guard measures source.
   *
   * The totals come from the name list, so a correct paydown moves them together. The test builds
   * the row from the measurement, compares it with the committed row, and runs the census over it.
   * The sensitivity control rewrites every literal in memory. The row must then close, and the
   * other rows must not change.
   */
  it('AuthorityCensus_CliSurfaceRow_FailsLiveAgainstTheTree', () => {
    const scan = scanGovernedSources();
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
    expect(representation(cli, 'the registry-derived command tree').binding.kind).toBe('bound');
    expect(derivedSites(representation(cli, 'the registry-derived command tree'))).toHaveLength(3);

    const committed = committedRow('cli-surface');
    expect(cli.representations.map((r) => r.id).sort()).toEqual(
      committed.representations.map((r) => r.id).sort(),
    );
    expect(cli.authority).toEqual(committed.authority);

    const live = runAuthorityCensus(liveTopology([cli]));
    expect(live.totality.ok).toBe(true);
    expect(live.evaluatedRows).toBe(live.rowCount);
    expect(live.evaluatedRows).toBe(topologyRows().length);

    expect(tuplesFor(live, 'cli-surface')).toEqual(['cli-surface | authority | ambiguous | cli-surface']);
    expect(live.ok).toBe(false);
    expect(live.openBoundaries).toContain('cli-surface');
    expect(live.closedBoundaries).not.toContain('cli-surface');

    const cliSource = readFileSync(governedSourcePath(), 'utf8');
    const derivedEverywhere = cliSource.replace(/\.command\(\s*'[^']*'/g, '.command(cliName');
    expect(derivedEverywhere).not.toBe(cliSource);

    const afterScan = scanSourceForCommandSites(derivedEverywhere, GOVERNED_SOURCES[0] ?? 'cli.ts');
    expect(afterScan.sites).toHaveLength(scan.sites.length);
    expect(afterScan.literals).toHaveLength(0);
    expect(afterScan.derived).toHaveLength(scan.sites.length);

    const remediated = measureCliSurface(afterScan);
    expect(remediated.authority).toEqual({ kind: 'single', authority: 'registry' });
    const green = runAuthorityCensus(liveTopology([remediated]));
    expect(tuplesFor(green, 'cli-surface')).toEqual([]);
    expect(green.closedBoundaries).toContain('cli-surface');

    expect(green.findings.filter((f) => f.boundary !== 'cli-surface').map(tupleOf)).toEqual(
      live.findings.filter((f) => f.boundary !== 'cli-surface').map(tupleOf),
    );
  });
});

describe('authority census — the event-catalog row, live', () => {
  /**
   * The parsed events must be contained in the live registry, because `registerEventType` can add
   * types at runtime. Every `PHASE_EVENT_CONTRACTS` row and emission row names its event as a
   * literal, so both representations are unbound. Skill prose is unbound by structure.
   *
   * `PHASE_EXPECTED_EVENTS` must stay unbound on both carriers, so a relabel on one row cannot hide
   * the finding. If all literals but one are derived, the row stays open. The full remediation
   * closes the row only when both carriers align. The phase-sequencing row then reports
   * `stale-exception`, because the event registry is not its HSM-guard authority.
   */
  it('AuthorityCensus_EventCatalogRow_FailsLiveAgainstTheTree', () => {
    const sources = readEventCatalogSources();
    const catalog = measureEventCatalog(sources);

    const liveEvents: ReadonlyMap<string, string> = new Map(
      Object.entries(EVENT_EMISSION_REGISTRY),
    );
    expect(catalog.registeredEvents.size).toBeGreaterThan(100);
    for (const [event, source] of catalog.registeredEvents) {
      expect(liveEvents.has(event)).toBe(true);
      expect(liveEvents.get(event)).toBe(source);
    }
    expect(catalog.modelEvents.size).toBeGreaterThan(0);

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

    const prose = representation(catalog, EVENT_CATALOG_REPRESENTATION_IDS.prose);
    expect(prose.sites.length).toBeGreaterThan(0);
    expect(new Set(prose.sites.map((s) => s.file)).size).toBeGreaterThan(1);
    for (const site of prose.sites) {
      expect(site.file.endsWith('.md')).toBe(true);
      expect(site.kind).toBe('literal');
      expect(catalog.modelEvents.has(site.subject)).toBe(true);
    }
    expect(prose.binding.kind).toBe('unbound');

    const live = runAuthorityCensus(liveTopology([catalog]));
    expect(live.totality.ok).toBe(true);
    expect(live.evaluatedRows).toBe(topologyRows().length);
    expect(tuplesFor(live, 'event-catalog')).toEqual([
      `event-catalog | binding | missing | ${EVENT_CATALOG_REPRESENTATION_IDS.prose}`,
      `event-catalog | binding | missing | ${EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents}`,
      `event-catalog | binding | missing | ${EVENT_CATALOG_REPRESENTATION_IDS.emissions}`,
    ]);
    expect(live.ok).toBe(false);

    const carriers = live.findings.filter(
      (f) => f.subject === EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents,
    );
    expect(carriers.map((f) => f.boundary).sort()).toEqual(['event-catalog', 'phase-sequencing']);
    expect(carriers.map((f) => f.kind)).toEqual(['missing', 'missing']);
    expect(live.findings.filter((f) => f.hop === 'binding' && f.kind === 'ambiguous')).toEqual([]);

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
    expect(remediated.representations.map((r) => r.id)).not.toContain(
      EVENT_CATALOG_REPRESENTATION_IDS.prose,
    );

    const green = runAuthorityCensus(liveTopology([remediated]));
    expect(green.totality.ok).toBe(true);

    expect(tuplesFor(green, 'event-catalog').filter((t) => t.includes('| missing |'))).toEqual([]);

    const stale = `binding | ambiguous | ${EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents}`;
    expect(tuplesFor(green, 'event-catalog')).toEqual([`event-catalog | ${stale}`]);
    expect(tuplesFor(green, 'phase-sequencing')).toContain(`phase-sequencing | ${stale}`);

    const closed = runAuthorityCensus(
      liveTopology([remediated]).map((row) => alignCarrier(row, remediated)),
    );
    expect(closed.totality.ok).toBe(true);
    expect(tuplesFor(closed, 'event-catalog')).toEqual([]);
    expect(closed.closedBoundaries).toContain('event-catalog');
    expect(closed.openBoundaries).toContain('phase-sequencing');

    expect(tuplesFor(closed, 'phase-sequencing')).toEqual([
      `phase-sequencing | binding | stale-exception | ${EVENT_CATALOG_REPRESENTATION_IDS.phaseExpectedEvents}`,
      'phase-sequencing | binding | missing | the phase playbooks',
    ]);
  });
});

describe('authority census — the live proof fails closed', () => {
  /**
   * Every scan fails closed on an empty population. An empty registry, a renamed phase table and an
   * unknown property each throw. So do an empty emission-row scan, an empty prose corpus, an empty
   * CLI scan and a missing tree. A recovered parse is fatal and names this module.
   *
   * The emission-row scan counts only emission rows, not every `event:` key. A prose corpus with no
   * match is a valid empty report. The census itself still refuses an empty subject.
   */
  it('AuthorityCensus_LiveProof_ZeroSubjectsResolved_FailsClosed', () => {
    const sources = readEventCatalogSources();

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

    expect(() =>
      measureObjectLiteralEntries(
        sources.phaseExpectedEvents,
        EVENT_CATALOG_SOURCES.phaseExpectedEvents,
        'PHASE_EXPECTED_EVENTS_RENAMED',
      ),
    ).toThrow(/resolved ZERO sites/);

    expect(() =>
      measurePropertyAssignments(sources.emissions, EVENT_CATALOG_SOURCES.emissions, 'autoEmitz'),
    ).toThrow(/resolved ZERO sites/);

    expect(() => measureActionEmissions('export const nothing = 1;\n', 'fixture.ts')).toThrow(
      /resolved ZERO sites/,
    );

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

    expect(() => measureProseEventMentions([], new Set(['team.spawned']))).toThrow(/corpus is EMPTY/);
    expect(() => measureProseEventMentions(sources.docs, new Set())).toThrow(
      /event set is EMPTY/,
    );
    expect(
      measureProseEventMentions([{ file: 'x.md', text: 'no events here' }], new Set(['team.spawned'])),
    ).toEqual([]);

    expect(() => measureCliSurface({ sites: [], literals: [], derived: [], indeterminate: [] })).toThrow(
      /ZERO `\.command\(` sites/,
    );
    const indeterminate = scanSourceForCommandSites('program.command();\n', 'fixture.ts');
    expect(indeterminate.indeterminate).toHaveLength(1);
    expect(() => measureCliSurface(indeterminate)).toThrow(/could not be classified/);
    expect(() => measureCliSurfaceLive(mkdtempSync(path.join(tmpdir(), 'imo-026-')))).toThrow(
      /does not exist/,
    );

    expect(() => readEventCatalogSources(mkdtempSync(path.join(tmpdir(), 'imo-026-')))).toThrow(
      /is not a directory/,
    );

    expect(() => measureObjectLiteralEntries('const x = (;', 'broken.ts', 'X')).toThrow(
      /authority-live-proof: broken\.ts did not parse cleanly/,
    );

    const empty = runAuthorityCensus([]);
    expect(empty.ok).toBe(false);
    expect(empty.bindingSubjectCount).toBe(0);
  });

  /**
   * The evidence is keyed by hop and row, so only the measured rows carry `live-measurement`. The
   * other rows stay weaker on both hops. Each witness names a module, an exported entrypoint and the
   * tree paths that it reads. The test resolves each part against the oracle exports, through the
   * namespace import. The witness paths must equal the source lists of the oracle.
   *
   * The live report must match the committed report over the whole table, finding for finding.
   * `bindingFor` gives `bound` only when every site is derived.
   */
  it('AuthorityCensus_LiveProof_UpgradesEvidenceForTheMeasuredRowsOnly', () => {
    const LIVE = ['cli-surface', 'effect-event', 'event-catalog', 'phase-events'];
    expect([...liveMeasuredBoundaries()].sort()).toEqual(LIVE);
    for (const boundary of topologyRows().map((r) => r.boundary)) {
      if (!LIVE.includes(boundary)) continue;
      expect(rowEvidence(boundary).authority.evidence).toBe('live-measurement');
      expect(rowEvidence(boundary).binding.evidence).toBe('live-measurement');
    }
    const declaredOnly = topologyRows()
      .map((r) => r.boundary)
      .filter((b) => !LIVE.includes(b));
    expect(declaredOnly).toHaveLength(5);
    for (const boundary of declaredOnly) {
      expect(rowEvidence(boundary).authority.evidence).toBe('declared-row');
      expect(rowEvidence(boundary).binding.evidence).not.toBe('live-measurement');
    }

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

  /**
   * The witness on the row resolves to `measureEffectEvent`. The ledger owner names the event that
   * it appends from the emission that it gets. The promoter discards the emission and hands a typed
   * record to a destination that its caller owns. Both mint a receipt, so only this measurement can
   * tell them apart. A sink rewritten to ignore the emission must be unbound, and the unmutated
   * sinks must still bind. A deleted commit gate must remove the authority claim.
   */
  it('AuthorityLiveProof_EffectEventRow_NamesItsOracleModule', () => {
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

    expect(measured.authority).toEqual({ kind: 'single', authority: EFFECT_PLAN_AUTHORITY });
    const bindingById = new Map(measured.representations.map((r) => [r.id, r.binding.kind]));
    expect(bindingById.get(EFFECT_EVENT_REPRESENTATION_IDS.plan)).toBe('authoritative');
    expect(bindingById.get(EFFECT_EVENT_REPRESENTATION_IDS.vcsLedger)).toBe('bound');
    expect(bindingById.get(EFFECT_EVENT_REPRESENTATION_IDS.promotion)).toBe('unbound');

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
    expect(bindingFor(vcsSinks, EFFECT_PLAN_AUTHORITY, 'how', 'why').kind).toBe('bound');

    const gutted = sources.carrier.split('throw new UnrecordedEmissionError').join('void 0; //');
    expect(() => measureEffectEvent({ ...sources, carrier: gutted })).toThrow(
      /ZERO .*UnrecordedEmissionError/,
    );
  });
});

describe('authority census — the phase-events row, live', () => {
  /**
   * Every declared row names its event as a literal. The gate tables and the playbook rows are
   * computed from the contract, so they bind. The prose is authored and unbound. The row starts to
   * block at a later `atWave`, so at the default the prose finding does not block.
   */
  it('AuthorityCensus_PhaseEventsRow_DerivedSurfacesAreBoundAndProseIsNot', () => {
    const sources = readPhaseEventsSources();
    const measured = measurePhaseEvents(sources);

    const authority = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.authority);
    expect(authority.sites.length).toBeGreaterThan(10);
    expect(derivedSites(authority)).toHaveLength(0);

    const gate = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.gate);
    expect(gate.sites.map((s) => s.subject).sort()).toEqual([...GATE_TABLES].sort());
    expect(literalSites(gate)).toHaveLength(0);
    expect(gate.binding.kind).toBe('bound');

    const playbooks = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.playbooks);
    expect(playbooks.sites.length).toBeGreaterThan(30);
    expect(literalSites(playbooks)).toHaveLength(0);
    expect(playbooks.binding.kind).toBe('bound');

    const prose = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.prose);
    expect(prose.sites.length).toBeGreaterThan(0);
    expect(prose.binding.kind).toBe('unbound');

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

  /**
   * A playbook row or a gate table written back as a literal reopens the binding. A renamed gate
   * table fails closed and does not measure nothing.
   */
  it('AuthorityCensus_PhaseEventsRow_ASeededBakedRowIsNamed', () => {
    const sources = readPhaseEventsSources();
    const measured = measurePhaseEvents(sources);
    const playbooks = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.playbooks);
    const gate = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.gate);

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

    expect(() =>
      measurePhaseEvents({
        ...sources,
        gate: sources.gate.split('PHASE_EXPECTED_EVENTS').join('PHASE_EXPECTED_EVENTS_RENAMED'),
      }),
    ).toThrow(/exports no constant named PHASE_EXPECTED_EVENTS/);
  });

  /**
   * A site that is not a literal is not bound for that reason. A conditional with a baked name, an
   * unrelated helper, or the correct projection from the wrong module each compute a value without
   * the contract. Each reads `opaque` and reopens the binding. With the wrong import, only the
   * serializer copies of a row still bind.
   */
  it('AuthorityCensus_PhaseEventsRow_ADerivedSiteNotComputedFromTheContractIsNamed', () => {
    const sources = readPhaseEventsSources();
    const measured = measurePhaseEvents(sources);
    const [gateSite] = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.gate).sites;
    const [playbookSite] = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.playbooks).sites;
    expect(gateSite).toBeDefined();
    expect(playbookSite).toBeDefined();
    if (gateSite === undefined || playbookSite === undefined) return;

    const conditionalGate = spliceSites(
      sources.gate,
      [gateSite],
      () =>
        "process.env['SEEDED'] === '1' ? { delegate: ['team.spawned'] } : " +
        'expectedEventsByPhase(PHASE_EVENT_CONTRACTS)',
    );
    const seededGate = representation(
      measurePhaseEvents({ ...sources, gate: conditionalGate }),
      PHASE_EVENTS_REPRESENTATION_IDS.gate,
    );
    expect(seededGate.sites.filter((s) => s.kind === 'opaque').map((s) => s.subject)).toEqual([
      gateSite.subject,
    ]);
    expect(seededGate.binding.kind).toBe('unbound');
    expect(seededGate.binding.kind === 'unbound' ? seededGate.binding.why : '').toMatch(
      /1 compute it through something the measurement does not recognise/,
    );

    const helperPlaybooks = spliceSites(sources.playbooks, [playbookSite], () => "seededRows('delegate')");
    const seededHelper = measurePhaseEvents({ ...sources, playbooks: helperPlaybooks });
    const helperRows = representation(seededHelper, PHASE_EVENTS_REPRESENTATION_IDS.playbooks);
    expect(helperRows.sites.filter((s) => s.kind === 'opaque')).toHaveLength(1);
    expect(helperRows.binding.kind).toBe('unbound');
    expect(tuplesFor(runAuthorityCensus(liveTopology([seededHelper])), 'phase-events')).toContain(
      `phase-events | binding | missing | ${PHASE_EVENTS_REPRESENTATION_IDS.playbooks}`,
    );

    const elsewhere = sources.playbooks.replace(
      "from './topology/phase-events.js'",
      "from './topology/phase-events-copy.js'",
    );
    expect(elsewhere).not.toBe(sources.playbooks);
    const importedElsewhere = representation(
      measurePhaseEvents({ ...sources, playbooks: elsewhere }),
      PHASE_EVENTS_REPRESENTATION_IDS.playbooks,
    );
    expect(importedElsewhere.sites.filter((s) => s.kind === 'derived').length).toBeLessThan(4);
    expect(importedElsewhere.sites.filter((s) => s.kind === 'opaque').length).toBeGreaterThan(60);
    expect(importedElsewhere.binding.kind).toBe('unbound');
  });

  /**
   * The binder reads the whole initializer, not its two ends. A projection call in a chain, a
   * spread or a fallback carries what the wrapper adds. A same-named property on anything but a
   * `PhasePlaybook` parameter is a second table. Each such site reads `opaque`, and the serializer
   * copies stay `derived`. A named callback resolves to its declaration, so a callback that
   * rewrites a field is not a clone. The test declares it on the same line, so no site line moves.
   */
  it('AuthorityCensus_PhaseEventsRow_AWrappedProjectionOrAForeignCopyIsOpaque', () => {
    const sources = readPhaseEventsSources();
    const measured = measurePhaseEvents(sources);
    const playbooks = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.playbooks);
    const [projectionSite] = playbooks.sites.filter((s) => s.expression.startsWith('phaseEventInstructions('));
    const copySites = playbooks.sites.filter((s) => s.expression.startsWith('playbook.'));
    const [copySite] = copySites;
    const [gateSite] = representation(measured, PHASE_EVENTS_REPRESENTATION_IDS.gate).sites;
    expect(copySites.map((s) => s.kind)).toEqual(['derived', 'derived']);
    expect(projectionSite).toBeDefined();
    expect(copySite).toBeDefined();
    expect(gateSite).toBeDefined();
    if (projectionSite === undefined || copySite === undefined || gateSite === undefined) return;

    const playbookRowsOf = (playbooksSource: string): MeasuredRepresentation =>
      representation(
        measurePhaseEvents({ ...sources, playbooks: playbooksSource }),
        PHASE_EVENTS_REPRESENTATION_IDS.playbooks,
      );
    const opaqueLines = (rows: MeasuredRepresentation): readonly number[] =>
      rows.sites.filter((s) => s.kind === 'opaque').map((s) => s.line);

    for (const wrapped of [
      "phaseEventInstructions('delegate').concat([{ type: 'team.spawned', when: 'seeded' }])",
      "phaseEventInstructions(SEEDED) ?? phaseEventInstructions('delegate')",
      "[...phaseEventInstructions('delegate'), { type: 'team.spawned', when: 'seeded' }]",
      "phaseEventInstructions(seededPhaseFor('delegate'))",
    ]) {
      const rows = playbookRowsOf(spliceSites(sources.playbooks, [projectionSite], () => wrapped));
      expect(opaqueLines(rows), wrapped).toEqual([projectionSite.line]);
      expect(rows.binding.kind, wrapped).toBe('unbound');
    }

    for (const foreign of [
      'LEGACY_ROWS.events.map(cloneEvent)',
      'LEGACY_ROWS.events',
      "playbook.events.map((e) => ({ ...e, type: 'team.spawned' }))",
    ]) {
      const rows = playbookRowsOf(spliceSites(sources.playbooks, [copySite], () => foreign));
      expect(opaqueLines(rows), foreign).toEqual([copySite.line]);
      expect(rows.binding.kind, foreign).toBe('unbound');
    }

    const retyped = sources.playbooks.replace(
      '  playbook: PhasePlaybook,\n): SerializedPhasePlaybook {',
      '  playbook: SerializedPhasePlaybook,\n): SerializedPhasePlaybook {',
    );
    expect(retyped).not.toBe(sources.playbooks);
    expect([...opaqueLines(playbookRowsOf(retyped))].sort()).toEqual(copySites.map((s) => s.line).sort());

    const rewriter = spliceSites(
      sources.playbooks,
      [copySite],
      () => 'playbook.events.map(rewriteEvent)',
    ).replace(
      '  const cloneEvent =',
      "  const rewriteEvent = (e) => ({ ...e, type: 'team.spawned' }); const cloneEvent =",
    );
    expect(rewriter).not.toBe(sources.playbooks);
    const rewritten = playbookRowsOf(rewriter);
    expect(opaqueLines(rewritten)).toEqual([copySite.line]);
    expect(rewritten.binding.kind).toBe('unbound');

    const spread = spliceSites(
      sources.gate,
      [gateSite],
      () => "{ ...expectedEventsByPhase(PHASE_EVENT_CONTRACTS), delegate: ['team.spawned'] }",
    );
    const gateRows = representation(
      measurePhaseEvents({ ...sources, gate: spread }),
      PHASE_EVENTS_REPRESENTATION_IDS.gate,
    );
    expect(gateRows.sites.filter((s) => s.kind === 'opaque').map((s) => s.subject)).toEqual([gateSite.subject]);
    expect(gateRows.binding.kind).toBe('unbound');
  });

  /**
   * `events` instructs the model, and `autoEmittedEvents` discloses what the runtime fires. A row
   * that calls the projection of the other property swaps these semantics. Thus each property binds
   * only through its own projection.
   */
  it('AuthorityCensus_PhaseEventsRow_APlaybookRowCallingTheOtherPropertysProjectionIsOpaque', () => {
    const sources = readPhaseEventsSources();
    const playbooks = representation(
      measurePhaseEvents(sources),
      PHASE_EVENTS_REPRESENTATION_IDS.playbooks,
    );
    const [instructionSite] = playbooks.sites.filter((s) =>
      s.expression.startsWith('phaseEventInstructions('),
    );
    const [disclosureSite] = playbooks.sites.filter((s) =>
      s.expression.startsWith('phaseRuntimeEmissions('),
    );
    expect(instructionSite).toBeDefined();
    expect(disclosureSite).toBeDefined();
    if (instructionSite === undefined || disclosureSite === undefined) return;

    for (const [site, swapped] of [
      [instructionSite, "phaseRuntimeEmissions('delegate')"],
      [disclosureSite, "phaseEventInstructions('delegate')"],
    ] as const) {
      const rows = representation(
        measurePhaseEvents({
          ...sources,
          playbooks: spliceSites(sources.playbooks, [site], () => swapped),
        }),
        PHASE_EVENTS_REPRESENTATION_IDS.playbooks,
      );
      expect(rows.sites.filter((s) => s.kind === 'opaque').map((s) => s.line), swapped).toEqual([
        site.line,
      ]);
      expect(rows.binding.kind, swapped).toBe('unbound');
    }
  });
});
