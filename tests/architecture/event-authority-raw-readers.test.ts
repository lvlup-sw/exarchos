/**
 * No reader outside the canonical fold depends on an event that the partition
 * classifies as telemetry.
 *
 * @oracle-sources: ../../src/** minus ../../src/projections/**,
 * ../../src/events/partition/witnesses.ts
 *
 * The differential fold proves that the projection ignores a telemetry event.
 * Fences, idempotency checks and HSM guards read the event log raw. Thus this
 * suite scans each read of an event type in the shipped tree. The scan excludes
 * the projections because their job is to fold every event.
 *
 * A census that finds nothing looks clean. Thus the suite asserts its
 * denominators and seeds one violation on disk. It also holds each raw-reader
 * witness and each charter-pin witness to the same census.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_DIR = path.join(REPO_ROOT, 'src');
const EXCLUDED_DIR = path.join(SOURCE_DIR, 'projections');

/**
 * Maps each exported admission constant to its event type. An admission reader
 * names the type by the constant, not by a literal.
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

    const tracked = await listTrackedFiles(REPO_ROOT, {
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

  /** The size assertions are the denominator. A scan that resolves no reader reports no violation. */
  it('RawReaderCensus_EveryFoldExternalReader_NamesNoTelemetryClassifiedEventType', async () => {
    const census = await censusPromise;
    expect(census.modulesByEvent.size).toBeGreaterThan(0);
    expect(TELEMETRY_EVENTS.size).toBeGreaterThan(0);

    const audit = auditEventReaders(census, EVENT_AUTHORITY, GOVERNANCE_WITNESSES);
    expect(
      audit.violations.map((violation) => violation.message),
      describeUnread(census),
    ).toEqual([]);
  });

  /**
   * The seed is a module on disk that the real scanner walks, with the
   * array-membership spelling. A row put into a census value tests the auditor
   * only, not the grammar of the scanner.
   */
  it('RawReaderCensus_SeededReaderModuleOnDisk_IsWalkedResolvedAndNamed', async () => {
    const [telemetryType] = [...TELEMETRY_EVENTS].sort();
    expect(telemetryType).toBeDefined();

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
      await rmrfAsync(root);
    }
  });

  /**
   * Each spelling is live in this tree. A scanner that stops resolving one
   * reports its modules as readers of no event, and the census looks clean.
   */
  it('RawReaderCensus_EverySupportedReadSpelling_ResolvesToItsEventType', () => {
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

  /**
   * A table with no raw-reader witness makes the stale-witness check vacuous.
   * The count assertion fails such a table.
   */
  it('RawReaderCensus_DeclaredRawReaderWitness_IsNamedByALiveReader', async () => {
    const census = await censusPromise;
    const declared = Object.entries(GOVERNANCE_WITNESSES).filter(
      ([, witness]) => witness.arm === 'raw-reader',
    );
    expect(declared.length).toBeGreaterThan(0);

    const audit = auditEventReaders(census, EVENT_AUTHORITY, GOVERNANCE_WITNESSES);
    expect(
      audit.staleWitnesses.map((stale) => stale.message),
      describeUnread(census),
    ).toEqual([]);
  });

  /**
   * A charter-pin witness says that the promotion rests on the ratified family
   * decision alone. When a module reads a pinned type, the witness must move to
   * the raw-reader arm, which names the module.
   */
  it('RawReaderCensus_CharterPinWitness_IsNamedByNoLiveReader', async () => {
    const census = await censusPromise;
    expect(census.modulesByEvent.size).toBeGreaterThan(0);

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

  /**
   * A fold with no type filter depends on every event type. It is not a read of
   * nothing and it is not an unresolved discriminant, so it has its own bucket.
   * This tree has many such folds.
   */
  it('RawReaderCensus_UnscopedFoldsAndUnresolvedDiscriminants_AreReportedNotDropped', async () => {
    const census = await censusPromise;
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
