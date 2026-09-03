/**
 * Which event types are read RAW outside the canonical fold, measured from the
 * source tree.
 *
 * ── Why the measurement, and not a table ────────────────────────────────────
 *
 * Half the correctness-bearing dependencies on an event never touch a
 * projection. A fence checks whether a request was already executed, an
 * idempotency guard looks for a prior operation, an HSM guard scans the
 * hydrated event tail for one type. None of that is visible in a projection's
 * reducer, so a type can be droppable by the fold and undroppable by the tree.
 * A hand-maintained list of those readers would drift the moment a reader
 * moved, and would drift silently, because the only instrument that could
 * detect the drift is the measurement it replaced.
 *
 * ── The scanner is a port ───────────────────────────────────────────────────
 *
 * Resolving what a discriminant MEANS is a question about bindings, and the
 * only instrument that cannot disagree with the compiler about bindings is the
 * compiler. `typescript` is a devDependency, and a shipped module importing it
 * would make the compiler a runtime dependency of a tree whose shipped artifact
 * resolves only `dependencies`. So the policy lives here and the parser is
 * injected, the same split the append-site census states for itself.
 *
 * ── Three buckets, and why the third is not a subset of the other two ───────
 *
 * A resolved discriminant is a reader. A discriminant that does not reduce to a
 * string is UNRESOLVED and is reported, never dropped — "the census could not
 * read this" and "this module reads nothing" are different answers.
 *
 * A query with no type discriminant at all is neither. It is an UNSCOPED FOLD,
 * and it gets its own bucket: merging it into unresolved would flag a working
 * scan as broken, and merging it into "resolved: nothing" would hide a reader
 * that depends on the entire type universe. This bucket is also the census's
 * acknowledged blind spot — a bare fold whose `.type` comparison happens in
 * another module, behind a helper or across a call boundary, is invisible to a
 * per-module scan. That is the second reason the partition promotes but never
 * demotes: an under-report here can only leave a type classified governance.
 *
 * ── A read is not always a comparison ───────────────────────────────────────
 *
 * Equality and `case` arms are the obvious spellings and they were once the only
 * ones this census could see. They are not the only ones in the tree: a fence
 * asks a set whether it holds the type, a saga verifier filters a stream by a
 * family prefix and decides on what survives. A census blind to those reports
 * zero violations over modules whose verdict is a function of the event it
 * cannot see — the failure mode that motivated the grammar rather than a
 * hypothetical one. So membership tests and family prefixes are first-class read
 * shapes, and a family prefix expands to every catalog member it covers.
 *
 * ── Only known event types count ────────────────────────────────────────────
 *
 * A resolved literal is admitted only when it is a member of the catalog the
 * caller supplies. That single filter is what keeps an unrelated
 * `finding.type === 'style'` comparison out of the census without anyone
 * maintaining an exclusion list.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { AuthorityWitness, EventAuthority } from './authority.js';

/** What kind of read a site is. */
export type EventReaderKind =
  /** A `.query(stream, { type: X })` or `.queryByType(X, …)` discriminant. */
  | 'query-discriminant'
  /** An `event.type === 'x'` / `!== 'x'` comparison. */
  | 'type-comparison'
  /** A `case 'x':` arm on a switch whose discriminant is an event type. */
  | 'switch-case'
  /** A `SET.has(event.type)` / `ARRAY.includes(event.type)` membership test. */
  | 'membership-test'
  /** An `event.type.startsWith('family.')` filter over a whole family. */
  | 'prefix-filter'
  /** A query call carrying no type discriminant at all. */
  | 'unscoped-query';

/** One read site the scanner found. */
export interface EventReaderSite {
  /** 1-based line of the read in the scanned source. */
  readonly line: number;
  readonly kind: EventReaderKind;
  /**
   * The resolved event-type string, or `undefined` when it did not reduce.
   *
   * For a `prefix-filter` this is the PREFIX, not a type: the site names a whole
   * family and only the catalog can say which members that is, so the expansion
   * happens where the catalog is known rather than in the parser.
   */
  readonly discriminant: string | undefined;
}

/** Inputs a scanner needs beyond the source text. */
export interface EventReaderScanOptions {
  /** Reported in parse diagnostics only; never affects the answer. */
  readonly fileName?: string;
  /**
   * Dotted access paths (`ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED`) mapped to
   * their compile-time value, so a discriminant written as the exported
   * constant resolves to the same answer as the raw literal.
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
   * Every module the scan read, sorted. Carried in full rather than only
   * counted, because a consumer needs to tell "scanned and reads nothing" from
   * "never in scope" — collapsing those turns an unanswered question into a
   * refutation.
   */
  readonly scannedModules: readonly string[];
  /** Modules scanned — the DENOMINATOR, so a shrunken scan cannot read as clean. */
  readonly scannedModuleCount: number;
}

/**
 * Every non-test TypeScript module under `sourceDir`, sorted.
 *
 * The suffix filter is a BUILD property, not a named subtree: a file the build
 * never emits cannot host a shipped reader. `excludeDirs` carries the one
 * deliberate subtree exclusion — the projections themselves, whose whole job is
 * to fold every event including telemetry, so scanning them would report the
 * fold as a violation of a rule about readers OUTSIDE it.
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
 * Scan a source tree and group every resolved fold-external read by the event
 * it names.
 *
 * Pure with respect to its inputs beyond the read: the same tree and the same
 * scanner produce the same census, and nothing here decides whether a site is a
 * fault.
 *
 * Module paths are reported relative to `root`, so a census taken from the
 * repository root names modules the way a witness declaration and a reviewer
 * both write them.
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
        // A family filter reads every member of the family. Expanding it here,
        // against the catalog the caller supplied, is what stops a reader
        // spelled `startsWith('team.')` from looking like a module that names no
        // event — the under-report that hides a whole family's dependency. A
        // prefix matching nothing in the catalog is not a read of an event.
        for (const eventType of knownEventTypes) {
          if (!eventType.startsWith(site.discriminant)) continue;
          record(eventType, module);
        }
        continue;
      }
      // A literal that is not a catalog member is not a read of an event.
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
 * Reconcile a census against a classification, in both directions.
 *
 * Forward: a module that reads a telemetry-classified type raw is a violation —
 * the read is a dependency, and the classification says there is none.
 *
 * Reverse: every module a `raw-reader` witness declares must still appear in the
 * census for the type it cites. A witness whose reader was deleted or moved
 * keeps asserting a promotion nothing supports, so it is NAMED rather than left
 * to rot.
 *
 * A read of a GOVERNANCE type needs no witness. Requiring a declaration for
 * every one of them would be a tax paid by ~80 sites for no additional check —
 * the classification already says those events are depended upon.
 *
 * Pure: the census is a value, so a probe can hand it a fabricated one.
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
