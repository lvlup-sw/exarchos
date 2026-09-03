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
 * looks clean, which is the defect this repository keeps re-encountering. Four
 * assertions stand against that:
 *
 *   1. the scanned population is corroborated against `git ls-files`, so a
 *      shrunken walk shows up as a shrunken denominator;
 *   2. the resolved reader map is non-empty — a scanner that stopped resolving
 *      discriminants would otherwise pass silently;
 *   3. unscoped folds are non-empty, because this tree has many, and a zero
 *      there means the scan stopped seeing query calls at all;
 *   4. a seeded reader naming a telemetry type must be NAMED in the failure,
 *      by the same auditor that reads the real census.
 *
 * The reverse direction is checked too: every module a raw-reader witness cites
 * must still be found reading the type it was promoted for. A witness whose
 * reader moved away keeps asserting a promotion nothing supports.
 */

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

  it('RawReaderCensus_SeededReaderNamingATelemetryType_IsNamedInTheFailure', async () => {
    const census = await censusPromise;
    const [telemetryType] = [...TELEMETRY_EVENTS].sort();
    expect(telemetryType).toBeDefined();

    const seededModule = 'src/__seeded_reader__.ts';
    const seeded: EventReaderCensus = {
      ...census,
      modulesByEvent: new Map([
        ...census.modulesByEvent,
        [telemetryType ?? '', [seededModule]],
      ]),
    };

    const audit = auditEventReaders(seeded, EVENT_AUTHORITY, GOVERNANCE_WITNESSES);
    const messages = audit.violations.map((violation) => violation.message).join('\n');
    expect(audit.violations.length).toBe(1);
    expect(messages).toContain(seededModule);
    expect(messages).toContain(telemetryType ?? '');
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
