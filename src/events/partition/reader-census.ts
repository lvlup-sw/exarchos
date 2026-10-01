/**
 * Measures which event types the source tree reads RAW, outside the canonical fold.
 *
 * A fence, an idempotency guard, or an HSM guard can depend on an event that no
 * projection reads. A hand-kept list of those readers drifts silently, so the census
 * measures the tree. The caller injects the parser, because `typescript` is a
 * devDependency and the shipped artifact resolves only `dependencies`.
 *
 * A discriminant that does not reduce to a string is UNRESOLVED, and the census
 * reports it. A query with no type discriminant is an UNSCOPED FOLD. A per-module scan
 * cannot see a `.type` comparison in another module, so the partition never demotes.
 *
 * Membership tests and family prefixes are read shapes. Only a literal in the
 * supplied catalog counts as a read.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { AuthorityWitness, EventAuthority } from './authority.js';

/**
 * What kind of read a site is.
 *
 * - `query-discriminant`: the type of `.query(stream, { type: X })` or `.queryByType(X, …)`.
 * - `type-comparison`: an `event.type === 'x'` or `!== 'x'` comparison.
 * - `switch-case`: a `case 'x':` arm on a switch over an event type.
 * - `membership-test`: `SET.has(event.type)` or `ARRAY.includes(event.type)`.
 * - `prefix-filter`: `event.type.startsWith('family.')`, a read of a whole family.
 * - `unscoped-query`: a query call with no type discriminant.
 */
export type EventReaderKind =
  | 'query-discriminant'
  | 'type-comparison'
  | 'switch-case'
  | 'membership-test'
  | 'prefix-filter'
  | 'unscoped-query';

/** One read site the scanner found. */
export interface EventReaderSite {
  /** 1-based line of the read in the scanned source. */
  readonly line: number;
  readonly kind: EventReaderKind;
  /**
   * The resolved event-type string, or `undefined` when it did not reduce.
   * For a `prefix-filter` it is the PREFIX. The census expands it against the catalog.
   */
  readonly discriminant: string | undefined;
}

/** Inputs a scanner needs beyond the source text. */
export interface EventReaderScanOptions {
  /** Only parse diagnostics use this name. It never changes the answer. */
  readonly fileName?: string;
  /**
   * Maps dotted access paths (`ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED`) to their
   * compile-time values. A discriminant written as the constant resolves like the literal.
   */
  readonly knownConstants: ReadonlyMap<string, string>;
}

/** The reader scanner port. The implementation is compiler-backed, under `tools/`. */
export type EventReaderScanner = (
  source: string,
  options: EventReaderScanOptions,
) => readonly EventReaderSite[];

/** A read site referenced by where it is, for a diagnostic that can be acted on. */
export interface EventReaderSiteRef {
  /** Source module, relative to the scan root, forward-slashed. */
  readonly module: string;
  readonly line: number;
  readonly kind: EventReaderKind;
}

/** Every fold-external reader, plus the two buckets that are not readers. */
export interface EventReaderCensus {
  /** Event type → the modules that read it raw, sorted and de-duplicated. */
  readonly modulesByEvent: ReadonlyMap<string, readonly string[]>;
  /** Reads whose discriminant is a runtime value. */
  readonly unresolved: readonly EventReaderSiteRef[];
  /** Queries with no type discriminant — the whole-universe dependencies. */
  readonly unscopedFolds: readonly EventReaderSiteRef[];
  /**
   * Every module the scan read, sorted. A consumer uses it to tell "scanned and
   * reads nothing" from "never in scope".
   */
  readonly scannedModules: readonly string[];
  /** Modules scanned — the DENOMINATOR, so a shrunken scan cannot read as clean. */
  readonly scannedModuleCount: number;
}

/**
 * Every non-test TypeScript module under `sourceDir`, sorted. A file that the build
 * does not emit cannot hold a shipped reader. The walk skips `excludeDirs`. The
 * caller excludes the projections, because they fold every event and the census
 * counts only readers outside the fold.
 */
async function collectSources(
  sourceDir: string,
  excludeDirs: readonly string[],
): Promise<string[]> {
  const files: string[] = [];
  const excluded = new Set(excludeDirs);
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        if (excluded.has(full)) continue;
        await walk(full);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.bench.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(full);
      }
    }
  };
  await walk(sourceDir);
  return files.sort();
}

/** Where the walk starts and what it refuses to descend into. */
export interface EventReaderScanScope {
  /** Directory the walk starts from, absolute. */
  readonly sourceDir: string;
  /** Absolute directories the walk does not descend into. */
  readonly excludeDirs: readonly string[];
}

/**
 * Scans a source tree and groups every resolved fold-external read by the event
 * that it names. The function judges no site.
 *
 * A prefix filter is a read of every catalog member that it covers. A literal that
 * is not in the catalog is not a read. Module paths are relative to `root`.
 */
export async function scanEventReaders(
  root: string,
  scope: EventReaderScanScope,
  scan: EventReaderScanner,
  knownEventTypes: ReadonlySet<string>,
  knownConstants: ReadonlyMap<string, string>,
): Promise<EventReaderCensus> {
  const files = await collectSources(scope.sourceDir, scope.excludeDirs);
  const byEvent = new Map<string, Set<string>>();
  const unresolved: EventReaderSiteRef[] = [];
  const unscopedFolds: EventReaderSiteRef[] = [];
  const scannedModules: string[] = [];
  const record = (eventType: string, module: string): void => {
    const modules = byEvent.get(eventType) ?? new Set<string>();
    modules.add(module);
    byEvent.set(eventType, modules);
  };

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const module = relative(root, file).replaceAll('\\', '/');
    scannedModules.push(module);
    for (const site of scan(source, { fileName: module, knownConstants })) {
      const ref: EventReaderSiteRef = { module, line: site.line, kind: site.kind };
      if (site.kind === 'unscoped-query') {
        unscopedFolds.push(ref);
        continue;
      }
      if (site.discriminant === undefined) {
        unresolved.push(ref);
        continue;
      }
      if (site.kind === 'prefix-filter') {
        for (const eventType of knownEventTypes) {
          if (!eventType.startsWith(site.discriminant)) continue;
          record(eventType, module);
        }
        continue;
      }
      if (!knownEventTypes.has(site.discriminant)) continue;
      record(site.discriminant, module);
    }
  }

  const modulesByEvent = new Map<string, readonly string[]>();
  for (const [event, modules] of byEvent) {
    modulesByEvent.set(event, Object.freeze([...modules].sort()));
  }
  const bySite = (a: EventReaderSiteRef, b: EventReaderSiteRef): number =>
    a.module.localeCompare(b.module) || a.line - b.line;
  return Object.freeze({
    modulesByEvent,
    unresolved: Object.freeze(unresolved.sort(bySite)),
    unscopedFolds: Object.freeze(unscopedFolds.sort(bySite)),
    scannedModules: Object.freeze(scannedModules.sort()),
    scannedModuleCount: files.length,
  });
}

/** A fold-external reader that names an event classified as telemetry. */
export interface TelemetryReadViolation {
  readonly module: string;
  readonly eventType: string;
  readonly message: string;
}

/** A declared raw-reader witness whose module no longer reads the type it cites. */
export interface StaleReaderWitness {
  readonly eventType: string;
  readonly module: string;
  readonly message: string;
}

/** Both directions of the census check. */
export interface EventReaderAudit {
  readonly violations: readonly TelemetryReadViolation[];
  readonly staleWitnesses: readonly StaleReaderWitness[];
}

/**
 * Reconciles a census against a classification in both directions.
 *
 * Forward: a module that reads a telemetry type raw is a violation.
 * Reverse: each module that a `raw-reader` witness cites must read that type in the
 * census. The audit names each stale witness.
 *
 * A read of a governance type needs no witness. The classification already marks
 * the type as a dependency.
 */
export function auditEventReaders(
  census: EventReaderCensus,
  classification: Readonly<Record<string, EventAuthority>>,
  witnesses: Readonly<Record<string, AuthorityWitness>>,
): EventReaderAudit {
  const violations: TelemetryReadViolation[] = [];
  for (const [eventType, modules] of census.modulesByEvent) {
    if (classification[eventType] !== 'telemetry') continue;
    for (const module of modules) {
      violations.push({
        module,
        eventType,
        message:
          `${module} reads "${eventType}" raw, outside the canonical fold, but the partition ` +
          'classifies that type as telemetry — a type nothing depends on. Either the read is ' +
          'not correctness-bearing and should stop naming the type, or the type is governance ' +
          'and needs a raw-reader witness naming this module.',
      });
    }
  }

  const staleWitnesses: StaleReaderWitness[] = [];
  for (const [eventType, witness] of Object.entries(witnesses)) {
    if (witness.arm !== 'raw-reader') continue;
    const readers = census.modulesByEvent.get(eventType) ?? [];
    for (const module of witness.evidence) {
      if (readers.includes(module)) continue;
      staleWitnesses.push({
        eventType,
        module,
        message:
          `The raw-reader witness for "${eventType}" cites ${module}, but the census finds no ` +
          `read of that type there. Readers found: ${readers.length === 0 ? '(none)' : readers.join(', ')}. ` +
          'The declaration outlived the code it names — repoint it or retire the promotion.',
      });
    }
  }

  return Object.freeze({
    violations: Object.freeze(
      violations.sort(
        (a, b) => a.eventType.localeCompare(b.eventType) || a.module.localeCompare(b.module),
      ),
    ),
    staleWitnesses: Object.freeze(
      staleWitnesses.sort(
        (a, b) => a.eventType.localeCompare(b.eventType) || a.module.localeCompare(b.module),
      ),
    ),
  });
}
