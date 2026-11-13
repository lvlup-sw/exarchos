/**
 * The live shadow of the guard input.
 *
 * Before a guarded call, the handler compares the state document with the ledger fold of the same stream.
 * A disagreement gives one warning on the result and one line in a diagnostics file under the state directory.
 * The warning names that file only when this run wrote a line to it.
 * The shadow holds no event store, so it cannot append a row. The ledger fold decides each call, and the state document is the compared side.
 *
 * `runGuardInputShadow` is pure and synchronous, and it turns each throw into a failure value.
 * Only `recordGuardInputShadow` moves the counts and writes the file. A failed file write changes no decision and no count.
 * No reader decides on the file or on the counts.
 */
import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import * as path from 'node:path';

import type { WorkflowEvent } from '../../events/schemas.js';
import { GUARD_INPUT_DIAGNOSTICS_DIRNAME } from '../../utils/paths.js';
import { compareGuardInputs, type GuardInputComparison } from './compare.js';
import { foldGuardInput, type GuardInput, type GuardInputOptions } from './fold.js';

/** One guarded call that the shadow can compare. The handler builds it before the guard runs. */
export interface GuardInputShadowCall {
  /** The handler of the call. */
  readonly call: 'transition' | 'cleanup';
  readonly featureId: string;
  /** The target phase of the call. A call with no target gets no comparison. */
  readonly target: string | undefined;
  /** True when the call also updates fields. Such a call gets no comparison, because the rows do not hold the updates yet. */
  readonly hasUpdates: boolean;
  /** The guard input of the state document, as the guard gets it. The shadow reads it in place. */
  readonly document: GuardInput;
  /** The rows of the stream. With no event store or after a failed query, the handler passes no rows. */
  readonly rows: readonly WorkflowEvent[] | undefined;
  /** The pass of the CAS loop, from 0. */
  readonly pass: number;
  /** The options of the fold side. */
  readonly fold: GuardInputOptions;
  /** The skipped phases of the call. The comparator compiles the definition of the decide with them. */
  readonly skipPhases?: readonly string[];
}

/** The read points and the identity of one run. */
interface GuardInputShadowRunBase {
  readonly call: 'transition' | 'cleanup';
  readonly featureId: string;
  readonly workflowType: string | null;
  readonly from: string;
  readonly to: string;
  readonly pass: number;
  /** The highest sequence of the folded rows. */
  readonly ledgerSequence: number;
  /** The `_eventSequence` of the state document, or `null` when the document holds no number. */
  readonly documentSequence: number | null;
  /** The `_version` of the state document, or `null` when the document holds no number. */
  readonly documentVersion: number | null;
  /** The time of the fold and the comparison, in milliseconds. No code decides on it. */
  readonly foldMs: number;
}

/** A run that compared the two inputs. */
interface GuardInputShadowCompared extends GuardInputShadowRunBase {
  readonly kind: 'compared';
  readonly comparison: GuardInputComparison;
}

/** A run in which the fold or the comparison threw. */
interface GuardInputShadowFailed extends GuardInputShadowRunBase {
  readonly kind: 'failed';
  /** The `message` of the error, as the error gives it. */
  readonly error: string;
}

/** The result of one shadow run. */
export type GuardInputShadowRun = GuardInputShadowCompared | GuardInputShadowFailed;

/** The counts of the recorded runs of this process. They are a diagnostic, and no code decides on them. */
export interface GuardInputShadowCounts {
  /** The recorded runs with a comparison. */
  readonly compared: number;
  /** The recorded runs with a comparison that does not agree. */
  readonly disagreeing: number;
  /** The recorded runs that threw. */
  readonly failed: number;
}

/** Where `recordGuardInputShadow` writes, and whether it writes. */
export interface GuardInputShadowSink {
  readonly stateDir: string;
  /** False when the call writes no line, as a dry run does. The counts and the warning stay, and the warning names no file. */
  readonly writeLine?: boolean;
}

/** The `_esVersion` of a document that is on the ledger. */
const LEDGER_ES_VERSION = 2;

/** The type of the row that starts a workflow stream. */
const START_ROW_TYPE = 'workflow.started';

/** The most characters of a warning. */
const WARNING_MAX_CHARS = 300;

/** The text that ends a cut warning. */
const CUT_MARK = '...';

/** The most characters of an error message in a warning or a line. */
const ERROR_MAX_CHARS = 120;

/** The most keys that a disagreement warning names. */
const WARNING_KEY_COUNT = 3;

/** The most entries of each list of a line. */
const LINE_LIST_MAX = 32;

/** The most bytes of a line, with its newline. */
const LINE_MAX_BYTES = 8 * 1024;

/** The most bytes of a diagnostics file. */
const FILE_MAX_BYTES = 1024 * 1024;

/** The end of a capped line. The `capped` key is the last key of that line. */
const CAPPED_LINE_END = '"capped":true}\n';

/** The bytes of the file end that the writer reads to find a capped line. */
const CAPPED_TAIL_BYTES = 1024;

/** The version of the line format. */
const LINE_VERSION = 1;

/** The counts of this process. Only `recordGuardInputShadow` changes them. */
const counts = { compared: 0, disagreeing: 0, failed: 0 };

/** Returns a copy of the counts of the recorded runs of this process. */
export function guardInputShadowCounts(): GuardInputShadowCounts {
  return { ...counts };
}

/** Returns the value when it is a string, and otherwise an empty string. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Returns the value when it is a finite number, and otherwise `null`. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Returns the highest sequence of the rows, or 0 when the rows are empty. */
function highestSequence(rows: readonly WorkflowEvent[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.sequence), 0);
}

/** Returns the message of a thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compares the guard input of the state document with the fold of the rows.
 * A throw of the fold or of the comparison becomes a failed run, so the function never throws.
 *
 * The call must satisfy four conditions, each with one check. It holds a target and no updates, and it moves the phase.
 * The document is on the ledger, and the rows hold a start row. A call with no rows folds no rows, so the start-row check also covers it.
 * The comparator holds the type rule. A call that fails a condition, or that gets no comparison, gives no run.
 */
export function runGuardInputShadow(input: GuardInputShadowCall): GuardInputShadowRun | undefined {
  const { document, target } = input;
  const rows = input.rows ?? [];
  if (target === undefined || input.hasUpdates) return undefined;
  if (document.phase === target) return undefined;
  if (document._esVersion !== LEDGER_ES_VERSION) return undefined;
  if (!rows.some((row) => row.type === START_ROW_TYPE)) return undefined;
  const workflowType = document.workflowType;
  const started = performance.now();
  const base = {
    call: input.call,
    featureId: input.featureId,
    workflowType: typeof workflowType === 'string' ? workflowType : null,
    from: textOf(document.phase),
    to: target,
    pass: input.pass,
    ledgerSequence: highestSequence(rows),
    documentSequence: numberOf(document._eventSequence),
    documentVersion: numberOf(document._version),
  };
  try {
    const fold = foldGuardInput(rows, input.fold);
    const comparison = compareGuardInputs(
      document,
      fold,
      input.skipPhases === undefined ? {} : { skipPhases: input.skipPhases },
    );
    if (comparison === undefined) return undefined;
    return { ...base, kind: 'compared', comparison, foldMs: performance.now() - started };
  } catch (err) {
    return { ...base, kind: 'failed', error: messageOf(err), foldMs: performance.now() - started };
  }
}

/** Cuts a warning to its first 297 characters and `...` when it holds more than 300 characters. */
function capWarning(text: string): string {
  return text.length <= WARNING_MAX_CHARS ? text : `${text.slice(0, WARNING_MAX_CHARS - CUT_MARK.length)}${CUT_MARK}`;
}

/**
 * Returns the warning of a run. The count of keys is the count before the list cut of the line.
 * The details path appears only when `written` is true, so the warning never names a line that is not there.
 * The keys come last, so the cut of a long warning removes them first.
 */
function warningOf(run: GuardInputShadowRun, written: boolean): string {
  if (run.kind === 'failed') {
    return capWarning(`GUARD_INPUT_SHADOW_FAILED: ${run.error.slice(0, ERROR_MAX_CHARS)}. The shadow compared nothing.`);
  }
  const { differences } = run.comparison;
  const keys = differences.slice(0, WARNING_KEY_COUNT).map((difference) => difference.key).join(', ');
  const details = written ? `Details: ${GUARD_INPUT_DIAGNOSTICS_DIRNAME}/${run.featureId}.jsonl. ` : '';
  return capWarning(
    `GUARD_INPUT_DISAGREEMENT: the ledger fold decided, and the state document disagrees on ${differences.length} guard inputs ` +
      `at ${run.from} -> ${run.to}. ${details}Keys: ${keys}.`,
  );
}

/** Returns the first entries of a list, at most the cap of a line. */
function capList<T>(list: readonly T[]): readonly T[] {
  return list.length <= LINE_LIST_MAX ? list : list.slice(0, LINE_LIST_MAX);
}

/**
 * Returns the line of a run with its newline.
 * Each list keeps at most 32 entries, and `error` keeps at most 120 characters. Each cut sets `truncated`.
 * The list `edges` holds the decide verdict of each edge on each input.
 * When the line still holds more than 8 KiB, it gets empty `differences` and `edges`, and it keeps `classes` and the read points.
 */
function lineOf(run: GuardInputShadowRun): string {
  const comparison = run.kind === 'compared' ? run.comparison : undefined;
  const differences = comparison?.differences ?? [];
  const edges = comparison?.edges ?? [];
  const classes = comparison?.classes ?? [];
  const error = run.kind === 'failed' ? run.error : null;
  const cut =
    differences.length > LINE_LIST_MAX ||
    edges.length > LINE_LIST_MAX ||
    classes.length > LINE_LIST_MAX ||
    (error !== null && error.length > ERROR_MAX_CHARS);
  const line = {
    v: LINE_VERSION,
    at: new Date().toISOString(),
    featureId: run.featureId,
    workflowType: run.workflowType,
    call: run.call,
    from: run.from,
    to: run.to,
    pass: run.pass,
    phase: comparison?.phase ?? null,
    differences: capList(differences),
    edges: capList(edges),
    classes: capList(classes),
    ledgerSequence: run.ledgerSequence,
    documentSequence: run.documentSequence,
    documentVersion: run.documentVersion,
    foldMs: run.foldMs,
    error: error === null ? null : error.slice(0, ERROR_MAX_CHARS),
    truncated: cut,
  };
  const text = `${JSON.stringify(line)}\n`;
  if (Buffer.byteLength(text) <= LINE_MAX_BYTES) return text;
  return `${JSON.stringify({ ...line, differences: [], edges: [], truncated: true })}\n`;
}

/** Returns the line that takes the place of a line that does not fit in the file. */
function cappedLineOf(featureId: string): string {
  return `${JSON.stringify({ v: LINE_VERSION, at: new Date().toISOString(), featureId, capped: true })}\n`;
}

/** Returns the size of a file in bytes, or 0 when the file does not exist. */
async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return 0;
    throw err;
  }
}

/** Returns true when the file ends with a capped line. */
async function endsCapped(file: string, size: number): Promise<boolean> {
  const length = Math.min(size, CAPPED_TAIL_BYTES);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8').endsWith(CAPPED_LINE_END);
  } finally {
    await handle.close();
  }
}

/**
 * Appends one line to the diagnostics file of the feature.
 * When the line takes the file past 1 MiB, the writer appends one capped line in its place.
 * A file that ends with a capped line gets no more lines. A cap occurs only near the limit, so the writer reads the file end only there.
 * Returns true when it appends a line, the capped line included, and false when the file already ends with a capped line.
 */
async function appendDiagnosticsLine(stateDir: string, run: GuardInputShadowRun): Promise<boolean> {
  const { featureId } = run;
  const line = lineOf(run);
  const directory = path.join(stateDir, GUARD_INPUT_DIAGNOSTICS_DIRNAME);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${featureId}.jsonl`);
  const size = await sizeOf(file);
  if (size > FILE_MAX_BYTES - LINE_MAX_BYTES && (await endsCapped(file, size))) return false;
  if (size + Buffer.byteLength(line) <= FILE_MAX_BYTES) {
    await appendFile(file, line, 'utf8');
    return true;
  }
  await appendFile(file, cappedLineOf(featureId), 'utf8');
  return true;
}

/**
 * Records one run after the decision of the call, and returns the warnings for the result.
 * No run gives no warning and moves no count. A run with a comparison moves `compared`, and a disagreement also moves `disagreeing`.
 * A failed run moves `failed`. A disagreement or a failure writes one line, unless `sink.writeLine` is false.
 * A failed or skipped file write keeps the warning without its details path, and the function does not throw.
 */
export async function recordGuardInputShadow(
  run: GuardInputShadowRun | undefined,
  sink: GuardInputShadowSink,
): Promise<readonly string[]> {
  if (run === undefined) return [];
  if (run.kind === 'compared') {
    counts.compared += 1;
    if (run.comparison.agrees) return [];
    counts.disagreeing += 1;
  } else {
    counts.failed += 1;
  }
  const written = sink.writeLine !== false && (await appendDiagnosticsLine(sink.stateDir, run).catch(() => false));
  return [warningOf(run, written)];
}
