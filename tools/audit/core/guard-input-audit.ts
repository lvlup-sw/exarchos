/**
 * The read-only audit of the guard input over a copy of a store.
 *
 * The audit folds each stream of the copy and compares each state document with the ledger fold of its stream.
 * It reports the count of each kind of document and of each class of disagreement, and a strict `clean` verdict.
 * It runs under Bun, because the SQLite backend imports `bun:sqlite`.
 *
 * The audit itself appends no event row and writes no state row. The open of a store writes its schema rows, so the audit refuses a live state directory and a link to its store file.
 * The open also moves a copy from an older schema to the current one, and that step can add `migration.workflow_type_unknown` rows to the copy.
 * The projection ignores those rows, and both sides of each comparison read them, so they change no count, class or verdict.
 *
 * With `--preview`, the report also previews the switch of the guards to the ledger fold for each active compared document.
 * For each explicit edge out of the document phase, it gives the legacy verdict on the document and the decide verdict on the fold.
 * A `newly-admitted` or `newly-denied` edge names the fact keys that the decide found false. The preview changes no count and no `clean` verdict.
 *
 * Usage: `bun tools/audit/core/guard-input-audit.ts --store <dir> [--out <file>] [--preview]`.
 * Exit 0 means that the audit ran, not that the store is clean. Exit 2 is a refusal, and stderr names its code.
 * An `--out` that names a store file of the copy or of a live state directory is a usage refusal. So the report never overwrites a store.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
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
  type GuardInput,
  type GuardInputOptions,
} from '../../../src/projections/guard-input/fold.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { resolveStateDir, STORE_DB_FILENAME, type StorePathResolutionInputs } from '../../../src/utils/paths.js';
import { collectCleanupEvidence } from '../../../src/workflow/cleanup.js';
import { frozenFloorOf, mergeFloors, phaseMoveEvents, statedCoordinate } from '../../../src/workflow/decide/emit.js';
import { decide, type DecideOutcome } from '../../../src/workflow/decide/decide.js';
import { compileDecideDefinition, type DecideDefinition, type DecideEdge } from '../../../src/workflow/decide/edges.js';
import {
  builtInDefinition,
  isBuiltInDefinitionType,
  type BuiltInWorkflowType,
} from '../../../src/workflow/definitions/built-in.js';
import { executeTransition, getHSMDefinition, type HSMDefinition } from '../../../src/workflow/state-machine.js';
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

/** The change of one edge at the switch. `same` means that the legacy guard and the decide both admit, or both do not admit. */
type PreviewChange = 'same' | 'newly-admitted' | 'newly-denied';

/** The class of one previewed document. `mixed` means that one edge is newly admitted and another edge is newly denied. */
type PreviewEffect = 'no-effect' | 'newly-admitted' | 'newly-denied' | 'mixed';

/** The two verdicts of one explicit edge out of the document phase. */
interface PreviewEdge {
  readonly transitionId: string;
  readonly to: string;
  /** The verdict of the legacy transition on the document. */
  readonly legacy: 'allow' | 'deny' | 'throw';
  /** The verdict of the decide on the fold, from the document phase. */
  readonly decide: 'allow' | 'deny' | 'indeterminate' | 'throw';
  readonly change: PreviewChange;
  /**
   * The fact keys of a changed edge. A newly denied edge names the false facts of the decide on the fold.
   * A newly admitted edge names the false facts of the decide on the document. An edge with no change names no key.
   */
  readonly keys: readonly string[];
}

/** The preview of the switch for one active compared document. */
interface PreviewDocument {
  readonly featureId: string;
  readonly workflowType: string;
  readonly phase: { readonly document: string; readonly fold: string };
  readonly effect: PreviewEffect;
  readonly edges: readonly PreviewEdge[];
}

/** The options of one audit. */
export interface GuardAuditOptions {
  /** True when the report previews the switch for each active compared document. */
  readonly preview?: boolean;
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
  /** The preview of the switch, in the order of the documents. Only an audit with the preview option holds it. */
  readonly preview?: readonly PreviewDocument[];
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
const USAGE = 'usage: bun tools/audit/core/guard-input-audit.ts --store <dir> [--out <file>] [--preview]';

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
      readonly workflowType: BuiltInWorkflowType;
      readonly standing: Standing;
      readonly sides: ComparedSides;
      readonly rows: readonly WorkflowEvent[];
      readonly ledgerSequence: number;
    };

/** The two guard inputs of one document and their comparison. */
interface ComparedSides {
  readonly document: GuardInput;
  readonly fold: GuardInput;
  readonly comparison: GuardInputComparison;
}

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
function compareSides(document: Record<string, unknown>, rows: readonly WorkflowEvent[]): ComparedSides | undefined {
  try {
    const fold = foldGuardInput(rows, SIDE_OPTIONS);
    const documentSide = documentGuardInput(document, rows, SIDE_OPTIONS);
    const comparison = compareGuardInputs(documentSide, fold);
    return comparison === undefined ? undefined : { document: documentSide, fold, comparison };
  } catch {
    return undefined;
  }
}

/** Combines the stated coordinate with the frozen obligations of the target. */
function previewFloor(input: GuardInput, rows: readonly WorkflowEvent[], target: string) {
  const coordinate = statedCoordinate(input);
  return mergeFloors([coordinate === null ? null : { coordinates: [coordinate] }, frozenFloorOf(rows, target)]);
}

/** Runs the pure emitter after admission so its refusals also deny the preview. */
function prospectiveVerdict(def: DecideDefinition, input: GuardInput, phase: string, outcome: DecideOutcome | undefined, rows: readonly WorkflowEvent[]): PreviewEdge['decide'] {
  if (outcome?.kind !== 'admit') return decideVerdictOf(outcome);
  try {
    return phaseMoveEvents(def, { ...input, phase }, outcome.move, previewFloor(input, rows, outcome.move.to)).success ? 'allow' : 'deny';
  } catch {
    return 'throw';
  }
}

/** Returns the verdict of the legacy transition to `to` on the document side. A throw gives `throw`. */
function legacyVerdictOf(machine: HSMDefinition, document: GuardInput, to: string, rows: readonly WorkflowEvent[]): PreviewEdge['legacy'] {
  try {
    return executeTransition(machine, { ...document }, to, undefined, previewFloor(document, rows, to)).success ? 'allow' : 'deny';
  } catch {
    return 'throw';
  }
}

/** Returns the outcome of a transition request to `to` on one input, from `phase`. A throw gives no outcome. */
function decideOutcomeOf(def: DecideDefinition, input: GuardInput, phase: string, to: string): DecideOutcome | undefined {
  try {
    return decide(def, { ...input, phase }, { kind: 'transition', target: to });
  } catch {
    return undefined;
  }
}

/** Returns the verdict of a decide outcome. An idempotent request admits. A request with no edge and a throw do not admit. */
function decideVerdictOf(outcome: DecideOutcome | undefined): PreviewEdge['decide'] {
  if (outcome === undefined) return 'throw';
  switch (outcome.kind) {
    case 'admit':
    case 'idempotent':
      return 'allow';
    case 'deny':
      return outcome.verdict.verdict;
    case 'no-edge':
    case 'stay':
      return 'deny';
  }
}

/** Returns the false facts of a denied outcome, and no fact for each other outcome. */
function falseFactsOf(outcome: DecideOutcome | undefined): readonly string[] {
  return outcome?.kind === 'deny' ? outcome.verdict.falseFacts : [];
}

/** Returns the change of one edge from its two verdicts. Only `allow` admits, so `indeterminate` and `throw` do not admit. */
function changeOf(legacy: PreviewEdge['legacy'], decided: PreviewEdge['decide']): PreviewChange {
  const legacyAdmits = legacy === 'allow';
  const decideAdmits = decided === 'allow';
  if (legacyAdmits === decideAdmits) return 'same';
  return decideAdmits ? 'newly-admitted' : 'newly-denied';
}

/** Returns the class of a document from the changes of its edges. */
function effectOf(edges: readonly PreviewEdge[]): PreviewEffect {
  const admitted = edges.some((edge) => edge.change === 'newly-admitted');
  const denied = edges.some((edge) => edge.change === 'newly-denied');
  if (admitted && denied) return 'mixed';
  if (admitted) return 'newly-admitted';
  return denied ? 'newly-denied' : 'no-effect';
}

/** Returns the preview of one explicit edge out of the document phase. */
function previewEdgeOf(
  def: DecideDefinition,
  machine: HSMDefinition,
  sides: ComparedSides,
  phase: string,
  edge: DecideEdge,
  rows: readonly WorkflowEvent[],
): PreviewEdge {
  const legacy = legacyVerdictOf(machine, sides.document, edge.to, rows);
  const onFold = decideOutcomeOf(def, sides.fold, phase, edge.to);
  const decided = prospectiveVerdict(def, sides.fold, phase, onFold, rows);
  const change = changeOf(legacy, decided);
  const keys =
    change === 'newly-denied'
      ? falseFactsOf(onFold)
      : change === 'newly-admitted'
        ? falseFactsOf(decideOutcomeOf(def, sides.document, phase, edge.to))
        : [];
  return { transitionId: edge.transitionId, to: edge.to, legacy, decide: decided, change, keys };
}

/**
 * Returns the preview of the switch for one compared document.
 * Each explicit edge out of the document phase gives one verdict pair, in edge order. The decide reads the fold from the document phase.
 */
function previewOf(
  featureId: string,
  workflowType: BuiltInWorkflowType,
  sides: ComparedSides,
  definitions: Map<string, DecideDefinition>,
  rows: readonly WorkflowEvent[],
): PreviewDocument {
  const def = definitions.get(workflowType) ?? compileDecideDefinition(workflowType, builtInDefinition(workflowType));
  definitions.set(workflowType, def);
  const machine = getHSMDefinition(workflowType);
  const { phase } = sides.comparison;
  const edges = def.edges
    .filter((edge) => edge.from === phase.document)
    .map((edge) => previewEdgeOf(def, machine, sides, phase.document, edge, rows));
  return { featureId, workflowType, phase, effect: effectOf(edges), edges };
}

/**
 * Gives the outcome of one document, in this order: a custom type, the standing, an unknown phase, the four kinds, and then the comparison.
 * A read error of the stream is a fold error, before the checks that need the rows.
 */
function auditDocument(reader: GuardAuditReader, featureId: string, state: unknown): DocumentOutcome {
  const document = isPlainObject(state) ? state : {};
  const workflowType = document.workflowType;
  if (!isBuiltInDefinitionType(workflowType)) return { kind: 'customType' };
  const standing = standingOf(getHSMDefinition(workflowType), document.phase);
  if (standing === undefined) {
    return { kind: 'unknownPhase', phase: typeof document.phase === 'string' ? document.phase : null };
  }
  if (document._esVersion !== LEDGER_ES_VERSION) return { kind: 'notOnLedger', standing };
  const read = readStream(reader, featureId);
  if (!read.ok) return { kind: 'foldError', standing };
  if (read.rows.length === 0) return { kind: 'noRows', standing };
  if (!hasStartRow(read.rows)) return { kind: 'noStartRow', standing };
  const sides = compareSides(document, read.rows);
  if (sides === undefined) return { kind: 'foldError', standing };
  return { kind: 'compared', workflowType, standing, sides, rows: read.rows, ledgerSequence: highestSequence(read.rows) };
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
 * The function reads only through the reader, so it changes no row. With `options.preview`, the report also holds the preview of the switch.
 * @throws a refusal with the code `GUARD_AUDIT_UNREADABLE` when a listing throws, or `GUARD_AUDIT_EMPTY_STORE` for a store with no document and no stream.
 */
export async function auditGuardInputs(reader: GuardAuditReader, options: GuardAuditOptions = {}): Promise<GuardAuditReport> {
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
  const preview: PreviewDocument[] = [];
  const definitions = new Map<string, DecideDefinition>();
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
      const { standing, sides } = outcome;
      const { comparison } = sides;
      compared[standing] += 1;
      if (options.preview === true && standing === 'active') {
        preview.push(previewOf(featureId, outcome.workflowType, sides, definitions, outcome.rows));
      }
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
    ...(options.preview === true ? { preview } : {}),
  };
}

/** The arguments of the command line. Each path is absolute. */
interface AuditArgs {
  readonly store: string;
  readonly out: string | undefined;
  readonly preview: boolean;
}

/** Parses the arguments. A call with no `--store` or with an unknown argument is a usage refusal. */
function parseAuditArgs(argv: readonly string[]): AuditArgs {
  let store: string | undefined;
  let out: string | undefined;
  let preview = false;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { store: { type: 'string' }, out: { type: 'string' }, preview: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    });
    store = values.store;
    out = values.out;
    preview = values.preview === true;
  } catch (err) {
    throw new GuardAuditError('GUARD_AUDIT_USAGE', `${messageOf(err)}. ${USAGE}`);
  }
  if (store === undefined || store.length === 0) {
    throw new GuardAuditError('GUARD_AUDIT_USAGE', `the call holds no --store. ${USAGE}`);
  }
  return { store: path.resolve(store), out: out === undefined ? undefined : path.resolve(out), preview };
}

/** Returns the real path of a path, or `undefined` when the path does not exist. A missing path matches no other path. */
function realPathOf(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
}

/** The device and the inode of a file. Two paths with an equal identity name one file. */
interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Returns the device and the inode of a file, or `undefined` when the file does not exist.
 * The stat follows each symlink, so a symlink and a hard link get the identity of their target. A missing file matches no other file.
 */
function fileIdentityOf(target: string): FileIdentity | undefined {
  try {
    const stats = statSync(target, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

/** Returns true when two identities name one file. A missing file on either side gives false. */
function isSameFile(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

/** Returns the live state directories: the state directory of the inputs, `<home>/.claude/workflow-state` and `<home>/.exarchos/state`. */
function liveStateDirs(inputs: StorePathResolutionInputs): string[] {
  const home = inputs.homedir ?? os.homedir();
  return [resolveStateDir(inputs), path.join(home, '.claude', 'workflow-state'), path.join(home, '.exarchos', 'state')];
}

/**
 * Refuses a store directory that is a live state directory, or whose store file is the store file of a live state directory.
 * The directory rule compares real paths. The file rule compares the device and the inode, so it refuses a symlinked or a hard-linked store file.
 */
function refuseLiveStore(store: string, inputs: StorePathResolutionInputs): void {
  const liveDirs = liveStateDirs(inputs);
  const target = realPathOf(store);
  const live = target === undefined ? undefined : liveDirs.find((dir) => realPathOf(dir) === target);
  if (live !== undefined) {
    throw new GuardAuditError('GUARD_AUDIT_LIVE_STORE', `${store} is the live state directory ${live}. Audit a copy.`);
  }
  const storeFile = path.join(store, STORE_DB_FILENAME);
  const storeIdentity = fileIdentityOf(storeFile);
  const linked = liveDirs.find((dir) => isSameFile(storeIdentity, fileIdentityOf(path.join(dir, STORE_DB_FILENAME))));
  if (linked !== undefined) {
    throw new GuardAuditError(
      'GUARD_AUDIT_LIVE_STORE',
      `${storeFile} is the store file of the live state directory ${linked}, through a link. Audit a copy.`,
    );
  }
}

/**
 * Refuses an `--out` that names a store file of the audited copy or of a live state directory.
 * A store file is the database, its WAL or its shared-memory file.
 * The rule compares the device and the inode, so it also refuses a symlink or a hard link to a store file. A new report file matches no store file.
 */
function refuseStoreFileOut(out: string | undefined, store: string, inputs: StorePathResolutionInputs): void {
  if (out === undefined) return;
  const outIdentity = fileIdentityOf(out);
  if (outIdentity === undefined) return;
  const names = [STORE_DB_FILENAME, `${STORE_DB_FILENAME}-wal`, `${STORE_DB_FILENAME}-shm`];
  for (const dir of [store, ...liveStateDirs(inputs)]) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isSameFile(outIdentity, fileIdentityOf(file))) {
        throw new GuardAuditError('GUARD_AUDIT_USAGE', `--out ${out} names the store file ${file}. Write the report to another file.`);
      }
    }
  }
}

/** Opens the store at the path, audits it and closes it. A failed open refuses the audit as unreadable. */
async function auditStoreFile(dbPath: string, options: GuardAuditOptions): Promise<GuardAuditReport> {
  const backend = new SqliteBackend(dbPath);
  try {
    try {
      backend.initialize();
    } catch (err) {
      throw new GuardAuditError('GUARD_AUDIT_UNREADABLE', `the store does not open: ${messageOf(err)}`);
    }
    return await auditGuardInputs(backend, options);
  } finally {
    backend.close();
  }
}

/**
 * Runs the audit of the command line. Four refusals run before any open: the usage, the live store, an `--out` that names a store file and the missing store.
 * The `inputs` give the paths of the live state directory, so a test can pass a temporary home.
 * With `--out`, the report also goes to that file. With `--preview`, the report also holds the preview of the switch.
 */
export async function runGuardInputAudit(
  argv: readonly string[],
  inputs: StorePathResolutionInputs = {},
): Promise<GuardAuditOutcome> {
  try {
    const args = parseAuditArgs(argv);
    refuseLiveStore(args.store, inputs);
    refuseStoreFileOut(args.out, args.store, inputs);
    const dbPath = path.join(args.store, STORE_DB_FILENAME);
    if (!existsSync(dbPath)) {
      throw new GuardAuditError('GUARD_AUDIT_NO_STORE', `${args.store} holds no ${STORE_DB_FILENAME}`);
    }
    const report = await auditStoreFile(dbPath, { preview: args.preview });
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
