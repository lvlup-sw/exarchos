/**
 * Nothing outside the canonical fold may depend on an event the partition calls
 * telemetry.
 *
 * @oracle-sources: ../../src/** minus ../../src/projections/**,
 * ../../src/events/partition/witnesses.ts
 *
 * The partition's claim about a telemetry event is that dropping it changes no
 * answer. The differential fold proves that for the projection. It proves
 * nothing about the other half of the system: fences, idempotency checks and
 * HSM guards read the event log raw, outside any reducer, and a type that is
 * droppable by the fold can be undroppable by one of those.
 *
 * So this walks the shipped tree, resolves every read of an event type it can,
 * and requires that none of them names a telemetry-classified type. The
 * projections are excluded on purpose — their job is to fold everything,
 * telemetry included, so scanning them would report the fold as a violation of
 * a rule about readers outside it.
 *
 * ## Why the vacuity assertions carry weight
 *
 * A census fails open. A walk that finds nothing reports no violations and
 * looks clean, which is the defect this repository keeps re-encountering. Five
 * assertions stand against that:
 *
 *   1. the scanned population is corroborated against `git ls-files`, so a
 *      shrunken walk shows up as a shrunken denominator;
 *   2. the resolved reader map is non-empty — a scanner that stopped resolving
 *      discriminants would otherwise pass silently;
 *   3. unscoped folds are non-empty, because this tree has many, and a zero
 *      there means the scan stopped seeing query calls at all;
 *   4. a seeded reader naming a telemetry type must be NAMED in the failure,
 *      and the seed is a MODULE ON DISK walked by the real scanner, not a row
 *      spliced into the census value. That distinction is the whole point: a
 *      seed injected into the value exercises the auditor and nothing else, so
 *      it stayed green through a grammar gap that made four shipped readers
 *      invisible;
 *   5. every read SPELLING the grammar claims to cover is proved to resolve, so
 *      a silently narrowed grammar shows up as a spelling that stopped
 *      resolving rather than as a clean tree.
 *
 * The reverse direction is checked too: every module a raw-reader witness cites
 * must still be found reading the type it was promoted for, and every
 * charter-pin witness — whose claim is that NO reader names its type — is held
 * to that claim against the same census.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EventTypes } from '../../src/events/schemas.js';
import { ADMISSION_EVENT_TYPES } from '../../src/workflow/admission/types.js';
import {
  auditEventReaders,
  scanEventReaders,
  type EventReaderCensus,
} from '../../src/events/partition/reader-census.js';
import {
  EVENT_AUTHORITY,
  TELEMETRY_EVENTS,
} from '../../src/events/partition/event-authority.js';
import { GOVERNANCE_WITNESSES } from '../../src/events/partition/witnesses.js';
import { scanEventReaders as compilerBackedScanner } from '../../tools/test-helpers/event-reader-scanner.js';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_DIR = path.join(REPO_ROOT, 'src');
const EXCLUDED_DIR = path.join(SOURCE_DIR, 'projections');

/**
 * The discriminant vocabulary the scanner may need, DERIVED from the live
 * constant table rather than transcribed — admission readers spell the type as
 * the exported constant, not as a literal.
 */
const KNOWN_CONSTANTS: ReadonlyMap<string, string> = new Map(
  Object.entries(ADMISSION_EVENT_TYPES).map(
    ([member, value]) => [`ADMISSION_EVENT_TYPES.${member}`, value] as const,
  ),
);

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(EventTypes);

const censusPromise: Promise<EventReaderCensus> = scanEventReaders(
  REPO_ROOT,
  { sourceDir: SOURCE_DIR, excludeDirs: [EXCLUDED_DIR] },
  compilerBackedScanner,
  KNOWN_EVENT_TYPES,
  KNOWN_CONSTANTS,
);

function describeUnread(census: EventReaderCensus): string {
  const unresolved = census.unresolved
    .slice(0, 20)
    .map((site) => `${site.module}:${site.line} (${site.kind})`)
    .join(', ');
  return (
    `scanned ${census.scannedModuleCount} module(s); ` +
    `${census.unresolved.length} unresolved discriminant(s)` +
    `${unresolved === '' ? '' : `: ${unresolved}`}; ` +
    `${census.unscopedFolds.length} unscoped fold(s)`
  );
}

describe('RawReaderCensus — no fold-external reader depends on a telemetry event', () => {
  it('RawReaderCensus_ScannedPopulation_IsNonEmptyAndCorroboratedByGit', async () => {
    const census = await censusPromise;
    expect(census.scannedModuleCount).toBeGreaterThan(0);

    const tracked = listTrackedFiles(REPO_ROOT, {
      exclude: (file) =>
        !file.startsWith('src/') ||
        file.startsWith('src/projections/') ||
        file.endsWith('.test.ts') ||
        file.endsWith('.bench.ts') ||
        file.endsWith('.d.ts'),
    });
    expect(tracked.length).toBeGreaterThan(0);

    const walked = new Set(census.scannedModules);
    const missed = tracked.filter((file) => !walked.has(file));
    expect(missed).toEqual([]);
  });

  it('RawReaderCensus_EveryFoldExternalReader_NamesNoTelemetryClassifiedEventType', async () => {
    const census = await censusPromise;
    // The denominator: a scan that resolved no reader at all would report no
    // violations and read as a clean tree.
    expect(census.modulesByEvent.size).toBeGreaterThan(0);
    expect(TELEMETRY_EVENTS.size).toBeGreaterThan(0);

    const audit = auditEventReaders(census, EVENT_AUTHORITY, GOVERNANCE_WITNESSES);
    expect(
      audit.violations.map((violation) => violation.message),
      describeUnread(census),
    ).toEqual([]);
  });

  it('RawReaderCensus_SeededReaderModuleOnDisk_IsWalkedResolvedAndNamed', async () => {
    const [telemetryType] = [...TELEMETRY_EVENTS].sort();
    expect(telemetryType).toBeDefined();

    // A module on disk, walked by the real scanner — not a row spliced into a
    // census value. The spelling is the membership test, because that is the
    // spelling a value-level seed could never have caught.
    const root = await mkdtemp(path.join(os.tmpdir(), 'exarchos-reader-census-'));
    try {
      const sourceDir = path.join(root, 'src');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, 'seeded-reader.ts'),
        [
          `const WATCHED: readonly string[] = ['${telemetryType ?? ''}'];`,
          'export function isWatched(event: { type: string }): boolean {',
          '  return WATCHED.includes(event.type);',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      const seeded = await scanEventReaders(
        root,
        { sourceDir, excludeDirs: [] },
        compilerBackedScanner,
        KNOWN_EVENT_TYPES,
        KNOWN_CONSTANTS,
      );
      expect(seeded.scannedModuleCount).toBe(1);
      expect(seeded.modulesByEvent.get(telemetryType ?? '')).toEqual(['src/seeded-reader.ts']);

      const audit = auditEventReaders(seeded, EVENT_AUTHORITY, GOVERNANCE_WITNESSES);
      const messages = audit.violations.map((violation) => violation.message).join('\n');
      expect(audit.violations.length).toBe(1);
      expect(messages).toContain('src/seeded-reader.ts');
      expect(messages).toContain(telemetryType ?? '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('RawReaderCensus_EverySupportedReadSpelling_ResolvesToItsEventType', () => {
    // The grammar's own denominator. Each entry is a spelling that is LIVE in
    // this tree; a scanner that quietly stopped covering one would otherwise
    // report the modules using it as depending on no event, and the census would
    // read clean over exactly the readers it had gone blind to.
    const [governanceType] = [...EventTypes].sort();
    expect(governanceType).toBeDefined();
    const target = governanceType ?? '';
    const family = `${target.split('.')[0] ?? ''}.`;

    const spellings: ReadonlyMap<string, string> = new Map([
      ['comparison', `export const f = (e: { type: string }) => e.type === '${target}';`],
      ['switch-case', `export function f(e: { type: string }) { switch (e.type) { case '${target}': return 1; default: return 0; } }`],
      ['query-filter', `export const f = (s: { query: Function }) => s.query('id', { type: '${target}' });`],
      ['array-membership', `const T = ['${target}']; export const f = (e: { type: string }) => T.includes(e.type);`],
      ['set-membership', `const T = new Set(['${target}']); export const f = (e: { type: string }) => T.has(e.type);`],
      ['prefix-filter', `export const f = (e: { type: string }) => e.type.startsWith('${family}');`],
    ]);

    const blind: string[] = [];
    for (const [name, source] of spellings) {
      const sites = compilerBackedScanner(source, {
        fileName: `${name}.ts`,
        knownConstants: KNOWN_CONSTANTS,
      });
      const named = sites.some(
        (site) =>
          site.discriminant === target ||
          (site.kind === 'prefix-filter' && site.discriminant === family),
      );
      if (!named) blind.push(name);
    }
    expect(blind, `the scanner no longer resolves these read spellings`).toEqual([]);
  });

  it('RawReaderCensus_DeclaredRawReaderWitness_IsNamedByALiveReader', async () => {
    const census = await censusPromise;
    const declared = Object.entries(GOVERNANCE_WITNESSES).filter(
      ([, witness]) => witness.arm === 'raw-reader',
    );
    // A table with no raw-reader arm would make the reverse check vacuous.
    expect(declared.length).toBeGreaterThan(0);

    const audit = auditEventReaders(census, EVENT_AUTHORITY, GOVERNANCE_WITNESSES);
    expect(
      audit.staleWitnesses.map((stale) => stale.message),
      describeUnread(census),
    ).toEqual([]);
  });

  it('RawReaderCensus_CharterPinWitness_IsNamedByNoLiveReader', async () => {
    const census = await censusPromise;
    expect(census.modulesByEvent.size).toBeGreaterThan(0);

    // A charter pin says the promotion rests on the ratified family decision
    // ALONE — no fold, no reader. Left unmeasured, that arm is where a promotion
    // with real evidence goes to escape every oracle, so the negative half is
    // held to the census: a pinned type a module actually reads has to move to
    // the raw-reader arm, which names its module and is re-measured.
    const pinned = Object.entries(GOVERNANCE_WITNESSES)
      .filter(([, witness]) => witness.arm === 'charter-pin')
      .map(([type]) => type);
    expect(pinned.length).toBeGreaterThan(0);

    const contradicted = pinned
      .map((type) => ({ type, readers: census.modulesByEvent.get(type) ?? [] }))
      .filter((row) => row.readers.length > 0)
      .map(
        (row) =>
          `The charter-pin witness for "${row.type}" claims no fold-external reader names it, ` +
          `but the census finds ${row.readers.join(', ')}. Move it to the raw-reader arm.`,
      );
    expect(contradicted, describeUnread(census)).toEqual([]);
  });

  it('RawReaderCensus_UnscopedFoldsAndUnresolvedDiscriminants_AreReportedNotDropped', async () => {
    const census = await censusPromise;
    // A bare fold depends on the whole type universe. Reporting it as "reads
    // nothing" would hide a dependency; reporting it as unresolved would flag a
    // working scan as broken. It gets its own bucket, and this tree has many.
    expect(census.unscopedFolds.length).toBeGreaterThan(0);

    const buckets = new Set(census.unscopedFolds.map((site) => site.kind));
    expect([...buckets]).toEqual(['unscoped-query']);

    const misfiled = census.unresolved.filter((site) => site.kind === 'unscoped-query');
    expect(misfiled).toEqual([]);

    for (const site of [...census.unscopedFolds, ...census.unresolved]) {
      expect(site.module).not.toBe('');
      expect(site.line).toBeGreaterThan(0);
    }
  });
});
