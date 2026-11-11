/**
 * The read-only audit of the guard input over a copy of a store.
 *
 * The audit folds each stream of the copy and compares each state document with the ledger fold of its stream.
 * It reports the count of each kind of document and of each class of disagreement, and a strict `clean` verdict.
 * The audit appends no event row and writes no state row. The open of a store writes its schema rows, so the audit refuses a live state directory.
 * It runs under Bun, because the SQLite backend imports `bun:sqlite`.
 *
 * Usage: `bun tools/audit/core/guard-input-audit.ts --store <dir> [--out <file>]`.
 * Exit 0 means that the audit ran, not that the store is clean. Exit 2 is a refusal, and stderr names its code.
 */
import { existsSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { migrateEvents } from '../../../src/events/event-migration.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { compareGuardInputs, type GuardInputComparison } from '../../../src/projections/guard-input/compare.js';
import {
  documentGuardInput,
  foldGuardInput,
  type GuardInputOptions,
} from '../../../src/projections/guard-input/fold.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { resolveStateDir, STORE_DB_FILENAME, type StorePathResolutionInputs } from '../../../src/utils/paths.js';
import { collectCleanupEvidence } from '../../../src/workflow/cleanup.js';
import { getHSMDefinition, isBuiltInWorkflowType, type HSMDefinition } from '../../../src/workflow/state-machine.js';
import { isPlainObject } from '../../../src/workflow/state-mutation.js';

/** The reads of the audit. A `SqliteBackend` satisfies this port, and a test can wrap one. */
export interface GuardAuditReader {
  listStates(): readonly { readonly featureId: string; readonly state: unknown }[];
  listStreams(): readonly string[];
  queryEvents(streamId: string): readonly WorkflowEvent[];
}

/** The code of each refusal of the audit. */
type GuardAuditCode =
  | 'GUARD_AUDIT_USAGE'
  | 'GUARD_AUDIT_LIVE_STORE'
  | 'GUARD_AUDIT_NO_STORE'
  | 'GUARD_AUDIT_UNREADABLE'
  | 'GUARD_AUDIT_EMPTY_STORE';

/** The standing of a document: a final phase of its machine is terminal, and each other phase is active. */
type Standing = 'active' | 'terminal';

/** The kinds of a document that the audit does not compare, other than a custom type and an unknown phase. */
type DocumentKind = 'notOnLedger' | 'noRows' | 'noStartRow' | 'foldError';

/** A count of documents for each standing. */
interface StandingCounts {
  readonly active: number;
  readonly terminal: number;
}

/** One active document that disagrees, with its classes, its folded keys and its two read points. */
interface ActiveDisagreement {
  readonly featureId: string;
  readonly classes: readonly string[];
  readonly keys: readonly string[];
  /** The highest sequence of the folded rows. */
  readonly ledgerSequence: number;
  /** The `_eventSequence` of the state document, or `null` when the document holds no number. */
  readonly documentSequence: number | null;
}

/** One document that blocks `clean` and is not an active disagreement. An `unknownPhase` entry also names its phase. */
interface CleanBlocker {
  readonly featureId: string;
  readonly kind: DocumentKind | 'unknownPhase';
  readonly phase?: string | null;
}

/** The report of one audit. Each count by class and by key counts disagreeing documents, not differences. */
export interface GuardAuditReport extends Readonly<Record<DocumentKind, StandingCounts>> {
  /** The documents of a type that is not built in. The audit does not compare them, and they stay outside `clean`. */
  readonly customType: number;
  /** The documents whose phase is not a state of their machine. Each one blocks `clean`. */
  readonly unknownPhase: number;
  readonly compared: StandingCounts;
  readonly agreeing: StandingCounts;
  readonly disagreeing: StandingCounts;
  /** The streams with no document and no start row, such as sidecar and infra streams. */
  readonly nonWorkflowStreams: number;
  /** The streams with a start row and no document, and the count of those whose read or fold throws. */
  readonly streamWithoutDocument: { readonly count: number; readonly foldError: number };
  /** The disagreeing documents of each class. */
  readonly byClass: Readonly<Record<string, StandingCounts>>;
  /** The disagreeing documents of each key. Each task key folds to `tasks[*].complete` or `tasks[*].failed`. */
  readonly byKey: Readonly<Record<string, StandingCounts>>;
  readonly activeDisagreements: readonly ActiveDisagreement[];
  readonly blockers: readonly CleanBlocker[];
  /** True only when the audit compared one or more documents and no document blocks it. */
  readonly clean: boolean;
}

/** The result of one command-line run. A refusal holds its code and its message, and a run that completed holds its report. */
export type GuardAuditOutcome =
  | { readonly exitCode: 0; readonly report: GuardAuditReport }
  | { readonly exitCode: 2; readonly code: GuardAuditCode; readonly message: string };

/** A refusal of the audit with its code. */
class GuardAuditError extends Error {
  readonly code: GuardAuditCode;

  constructor(code: GuardAuditCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'GuardAuditError';
    this.code = code;
  }
}

/** The usage text of the command line. */
const USAGE = 'usage: bun tools/audit/core/guard-input-audit.ts --store <dir> [--out <file>]';

/** The `_esVersion` of a document that is on the ledger. */
const LEDGER_ES_VERSION = 2;

/** The type of the row that starts a workflow stream. */
const START_ROW_TYPE = 'workflow.started';

/** The kinds, in the order of the checks. */
const DOCUMENT_KINDS: readonly DocumentKind[] = ['notOnLedger', 'noRows', 'noStartRow', 'foldError'];

/** The options of each side. Each side computes its config from its own tier and its cleanup evidence from its own state. */
const SIDE_OPTIONS: GuardInputOptions = {
  config: {},
  cleanupEvidence: (state) => collectCleanupEvidence(state).verified,
};

/** A task key of a comparison. The count by key folds each task id into one key. */
const TASK_KEY = /^tasks\[.*\]\.(complete|failed)$/;

/** The outcome of the read of one stream. A throw of the read or of the row migration is the outcome `ok` false. */
type StreamRead = { readonly ok: true; readonly rows: readonly WorkflowEvent[] } | { readonly ok: false };

/** The outcome of one document. */
type DocumentOutcome =
  | { readonly kind: 'customType' }
  | { readonly kind: 'unknownPhase'; readonly phase: string | null }
  | { readonly kind: DocumentKind; readonly standing: Standing }
  | {
      readonly kind: 'compared';
      readonly standing: Standing;
      readonly comparison: GuardInputComparison;
      readonly ledgerSequence: number;
    };

/** A count of documents for each standing, as the audit builds it. */
interface StandingTally {
  active: number;
  terminal: number;
}

/** Returns a new tally of zero. */
function emptyTally(): StandingTally {
  return { active: 0, terminal: 0 };
}

/** Adds 1 to the tally of the key in the map. */
function addTo(tallies: Map<string, StandingTally>, key: string, standing: Standing): void {
  const tally = tallies.get(key) ?? emptyTally();
  tally[standing] += 1;
  tallies.set(key, tally);
}

/** Returns the tallies of the map as a record, by sorted key. */
function sortedRecord(tallies: ReadonlyMap<string, StandingTally>): Record<string, StandingCounts> {
  const keys = [...tallies.keys()].sort();
  return Object.fromEntries(keys.map((key) => [key, { ...(tallies.get(key) ?? emptyTally()) }]));
}

/** Returns the message of a thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Returns the value when it is a finite number, and otherwise `null`. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Returns the highest sequence of the rows, or 0 when the rows are empty. */
function highestSequence(rows: readonly WorkflowEvent[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.sequence), 0);
}

/** True when the rows hold a start row. */
function hasStartRow(rows: readonly WorkflowEvent[]): boolean {
  return rows.some((row) => row.type === START_ROW_TYPE);
}

/** Returns the key of the count by key. A task key becomes `tasks[*].complete` or `tasks[*].failed`. */
function foldedKey(key: string): string {
  const field = TASK_KEY.exec(key)?.[1];
  return field === undefined ? key : `tasks[*].${field}`;
}

/** Reads and migrates the rows of one stream. A throw becomes the outcome `ok` false. */
function readStream(reader: GuardAuditReader, streamId: string): StreamRead {
  try {
    return { ok: true, rows: migrateEvents(reader.queryEvents(streamId)) };
  } catch {
    return { ok: false };
  }
}

/** Returns the standing of a phase in the machine, or `undefined` when the machine does not hold the phase. */
function standingOf(machine: HSMDefinition, phase: unknown): Standing | undefined {
  if (typeof phase !== 'string' || !Object.hasOwn(machine.states, phase)) return undefined;
  return machine.states[phase]?.type === 'final' ? 'terminal' : 'active';
}

/** Compares the document side with the fold side of the rows. A throw of either side gives no comparison. */
function compareSides(document: Record<string, unknown>, rows: readonly WorkflowEvent[]): GuardInputComparison | undefined {
  try {
    const fold = foldGuardInput(rows, SIDE_OPTIONS);
    return compareGuardInputs(documentGuardInput(document, rows, SIDE_OPTIONS), fold);
  } catch {
    return undefined;
  }
}

/**
 * Gives the outcome of one document, in this order: a custom type, the standing, an unknown phase, the four kinds, and then the comparison.
 * A read error of the stream is a fold error, before the checks that need the rows.
 */
function auditDocument(reader: GuardAuditReader, featureId: string, state: unknown): DocumentOutcome {
  const document = isPlainObject(state) ? state : {};
  const workflowType = document.workflowType;
  if (typeof workflowType !== 'string' || !isBuiltInWorkflowType(workflowType)) return { kind: 'customType' };
  const standing = standingOf(getHSMDefinition(workflowType), document.phase);
  if (standing === undefined) {
    return { kind: 'unknownPhase', phase: typeof document.phase === 'string' ? document.phase : null };
  }
  if (document._esVersion !== LEDGER_ES_VERSION) return { kind: 'notOnLedger', standing };
  const read = readStream(reader, featureId);
  if (!read.ok) return { kind: 'foldError', standing };
  if (read.rows.length === 0) return { kind: 'noRows', standing };
  if (!hasStartRow(read.rows)) return { kind: 'noStartRow', standing };
  const comparison = compareSides(document, read.rows);
  if (comparison === undefined) return { kind: 'foldError', standing };
  return { kind: 'compared', standing, comparison, ledgerSequence: highestSequence(read.rows) };
}

/** Calls a listing of the reader. A throw refuses the audit as unreadable. */
function listOrRefuse<T>(name: string, list: () => T): T {
  try {
    return list();
  } catch (err) {
    throw new GuardAuditError('GUARD_AUDIT_UNREADABLE', `${name} failed: ${messageOf(err)}`);
  }
}

/**
 * Folds each stream of a store and compares each state document with the fold of its stream.
 * The function reads only through the reader, so it changes no row.
 * @throws a refusal with the code `GUARD_AUDIT_UNREADABLE` when a listing throws, or `GUARD_AUDIT_EMPTY_STORE` for a store with no document and no stream.
 */
export async function auditGuardInputs(reader: GuardAuditReader): Promise<GuardAuditReport> {
  const states = listOrRefuse('listStates', () => reader.listStates());
  const streams = listOrRefuse('listStreams', () => reader.listStreams());
  if (states.length === 0 && streams.length === 0) {
    throw new GuardAuditError('GUARD_AUDIT_EMPTY_STORE', 'the store holds no document and no stream');
  }

  const kinds = new Map<string, StandingTally>(DOCUMENT_KINDS.map((kind) => [kind, emptyTally()]));
  const compared = emptyTally();
  const agreeing = emptyTally();
  const disagreeing = emptyTally();
  const byClass = new Map<string, StandingTally>();
  const byKey = new Map<string, StandingTally>();
  const activeDisagreements: ActiveDisagreement[] = [];
  const blockers: CleanBlocker[] = [];
  let customType = 0;
  let unknownPhase = 0;

  for (const { featureId, state } of states) {
    const outcome = auditDocument(reader, featureId, state);
    if (outcome.kind === 'customType') {
      customType += 1;
    } else if (outcome.kind === 'unknownPhase') {
      unknownPhase += 1;
      blockers.push({ featureId, kind: 'unknownPhase', phase: outcome.phase });
    } else if (outcome.kind !== 'compared') {
      addTo(kinds, outcome.kind, outcome.standing);
      if (outcome.standing === 'active') blockers.push({ featureId, kind: outcome.kind });
    } else {
      const { standing, comparison } = outcome;
      compared[standing] += 1;
      if (comparison.agrees) {
        agreeing[standing] += 1;
        continue;
      }
      disagreeing[standing] += 1;
      for (const disagreementClass of comparison.classes) addTo(byClass, disagreementClass, standing);
      const keys = [...new Set(comparison.differences.map((difference) => foldedKey(difference.key)))];
      for (const key of keys) addTo(byKey, key, standing);
      if (standing === 'active') {
        activeDisagreements.push({
          featureId,
          classes: comparison.classes,
          keys: comparison.differences.map((difference) => difference.key),
          ledgerSequence: outcome.ledgerSequence,
          documentSequence: numberOf(isPlainObject(state) ? state._eventSequence : undefined),
        });
      }
    }
  }

  const documentIds = new Set(states.map((entry) => entry.featureId));
  let nonWorkflowStreams = 0;
  let streamCount = 0;
  let streamFoldErrors = 0;
  for (const streamId of streams) {
    if (documentIds.has(streamId)) continue;
    const read = readStream(reader, streamId);
    if (read.ok && !hasStartRow(read.rows)) {
      nonWorkflowStreams += 1;
      continue;
    }
    streamCount += 1;
    if (!read.ok) {
      streamFoldErrors += 1;
      continue;
    }
    try {
      foldGuardInput(read.rows, SIDE_OPTIONS);
    } catch {
      streamFoldErrors += 1;
    }
  }

  const kindCounts: Record<DocumentKind, StandingCounts> = {
    notOnLedger: { ...(kinds.get('notOnLedger') ?? emptyTally()) },
    noRows: { ...(kinds.get('noRows') ?? emptyTally()) },
    noStartRow: { ...(kinds.get('noStartRow') ?? emptyTally()) },
    foldError: { ...(kinds.get('foldError') ?? emptyTally()) },
  };
  const clean =
    compared.active + compared.terminal >= 1 &&
    unknownPhase === 0 &&
    DOCUMENT_KINDS.every((kind) => kindCounts[kind].active === 0) &&
    disagreeing.active === 0;

  return {
    ...kindCounts,
    customType,
    unknownPhase,
    compared: { ...compared },
    agreeing: { ...agreeing },
    disagreeing: { ...disagreeing },
    nonWorkflowStreams,
    streamWithoutDocument: { count: streamCount, foldError: streamFoldErrors },
    byClass: sortedRecord(byClass),
    byKey: sortedRecord(byKey),
    activeDisagreements,
    blockers,
    clean,
  };
}

/** The arguments of the command line. Each path is absolute. */
interface AuditArgs {
  readonly store: string;
  readonly out: string | undefined;
}

/** Parses the arguments. A call with no `--store` or with an unknown argument is a usage refusal. */
function parseAuditArgs(argv: readonly string[]): AuditArgs {
  let store: string | undefined;
  let out: string | undefined;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { store: { type: 'string' }, out: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    store = values.store;
    out = values.out;
  } catch (err) {
    throw new GuardAuditError('GUARD_AUDIT_USAGE', `${messageOf(err)}. ${USAGE}`);
  }
  if (store === undefined || store.length === 0) {
    throw new GuardAuditError('GUARD_AUDIT_USAGE', `the call holds no --store. ${USAGE}`);
  }
  return { store: path.resolve(store), out: out === undefined ? undefined : path.resolve(out) };
}

/** Returns the real path of a path, or `undefined` when the path does not exist. A missing path matches no other path. */
function realPathOf(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
}

/**
 * Refuses a store directory that is a live state directory.
 * The live directories are the state directory of the inputs, `<home>/.claude/workflow-state` and `<home>/.exarchos/state`.
 */
function refuseLiveStore(store: string, inputs: StorePathResolutionInputs): void {
  const target = realPathOf(store);
  if (target === undefined) return;
  const home = inputs.homedir ?? os.homedir();
  const liveDirs = [
    resolveStateDir(inputs),
    path.join(home, '.claude', 'workflow-state'),
    path.join(home, '.exarchos', 'state'),
  ];
  const live = liveDirs.find((dir) => realPathOf(dir) === target);
  if (live !== undefined) {
    throw new GuardAuditError('GUARD_AUDIT_LIVE_STORE', `${store} is the live state directory ${live}. Audit a copy.`);
  }
}

/** Opens the store at the path, audits it and closes it. A failed open refuses the audit as unreadable. */
async function auditStoreFile(dbPath: string): Promise<GuardAuditReport> {
  const backend = new SqliteBackend(dbPath);
  try {
    try {
      backend.initialize();
    } catch (err) {
      throw new GuardAuditError('GUARD_AUDIT_UNREADABLE', `the store does not open: ${messageOf(err)}`);
    }
    return await auditGuardInputs(backend);
  } finally {
    backend.close();
  }
}

/**
 * Runs the audit of the command line. Three refusals run before any open: the usage, the live store and the missing store.
 * The `inputs` give the paths of the live state directory, so a test can pass a temporary home.
 * With `--out`, the report also goes to that file.
 */
export async function runGuardInputAudit(
  argv: readonly string[],
  inputs: StorePathResolutionInputs = {},
): Promise<GuardAuditOutcome> {
  try {
    const args = parseAuditArgs(argv);
    refuseLiveStore(args.store, inputs);
    const dbPath = path.join(args.store, STORE_DB_FILENAME);
    if (!existsSync(dbPath)) {
      throw new GuardAuditError('GUARD_AUDIT_NO_STORE', `${args.store} holds no ${STORE_DB_FILENAME}`);
    }
    const report = await auditStoreFile(dbPath);
    if (args.out !== undefined) await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return { exitCode: 0, report };
  } catch (err) {
    if (err instanceof GuardAuditError) return { exitCode: 2, code: err.code, message: err.message };
    throw err;
  }
}

/** Runs the audit of the process arguments, prints the report or the refusal, and sets the exit status of the process. */
async function runAsMain(): Promise<void> {
  const outcome = await runGuardInputAudit(process.argv.slice(2));
  if (outcome.exitCode === 0) {
    process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
  } else {
    process.stderr.write(`${outcome.message}\n`);
  }
  process.exitCode = outcome.exitCode;
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedAs)).href) {
  void runAsMain();
}
