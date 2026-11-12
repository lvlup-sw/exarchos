/**
 * Encodes a fixture of the transition-admission corpus as the two sides of the guard input.
 *
 * The fold side is a list of ledger rows. The document side is the fixture state with its phase and its type.
 * Each underscore field goes into the ephemerals of both sides, so both sides read one `_events` list.
 * The helper takes a structural fixture type, because a module under `tests/helpers/` cannot import a module under `tests/unit/`.
 */
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { getInitialPhase } from '../../../src/workflow/state-machine.js';
import { isReservedField } from '../../../src/workflow/schemas.js';

/** The parts of a corpus fixture that the encoder reads. */
export interface CorpusFixtureShape {
  readonly id: string;
  readonly workflowType: string;
  readonly from: string;
  readonly state: Readonly<Record<string, unknown>>;
}

/** The options of the encoder. */
export interface CorpusEncodeOptions {
  /**
   * When true, the document side gets the merge orchestrator phase that the merge handlers write for each merge entry of `_events`.
   * The default is true. Only a kill case turns the rule off.
   */
  readonly mergeWriterRule?: boolean;
}

/** The two sides of one encoded fixture. */
export interface EncodedCorpusFixture {
  /** The document side: the fixture state with its phase, its type and the merge orchestrator phase of the writer rule. */
  readonly document: Readonly<Record<string, unknown>>;
  /** The rows of the fold side, in stream order. */
  readonly rows: readonly WorkflowEvent[];
  /** The underscore fields of the fixture state. Both sides take them as given. */
  readonly ephemerals: Readonly<Record<string, unknown>>;
}

/** The top-level keys that the start row and the transition row give. The encoder writes no patch for them. */
const ROW_KEYS: ReadonlySet<string> = new Set(['phase', 'workflowType', 'featureId']);

/**
 * The merge orchestrator phase that each merge entry gives the document, as the merge handlers write it.
 * The retired `merge.rollback` stays, because the projection still folds it.
 */
const MERGE_WRITER_PHASES: ReadonlyMap<string, string> = new Map([
  ['merge.executed', 'completed'],
  ['merge.recovered', 'rolled-back'],
  ['merge.rollback', 'rolled-back'],
]);

/** The phase that a failed `merge.preflight` entry gives the document. */
const FAILED_PREFLIGHT_PHASE = 'aborted';

/** The time of the first row. Each later row is one second later. */
const EPOCH_MS = Date.parse('2026-11-11T00:00:00.000Z');

/** True when the value is an object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the entries of a list value, or an empty list when the value is not a list. */
function listOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return [];
  const list: readonly unknown[] = value;
  return list;
}

/** Returns the data of an `_events` entry: its `data` record, or else the entry without `type` and `timestamp`. */
function entryData(entry: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (isRecord(entry.data)) return { ...entry.data };
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'type' && key !== 'timestamp'));
}

/** Returns the merge orchestrator phase that an `_events` entry gives the document, or `undefined` when the entry gives none. */
function writerPhaseOf(entry: Readonly<Record<string, unknown>>): string | undefined {
  const type = entry.type;
  if (typeof type !== 'string') return undefined;
  if (type === 'merge.preflight') {
    return entryData(entry).passed === false ? FAILED_PREFLIGHT_PHASE : undefined;
  }
  return MERGE_WRITER_PHASES.get(type);
}

/** Builds the rows of one stream. Each row gets the next sequence and a time one second after the row before it. */
class RowWriter {
  private readonly rows: WorkflowEvent[] = [];

  constructor(private readonly streamId: string) {}

  /** Appends one row. A given timestamp replaces the computed time. */
  add(type: string, data: Record<string, unknown>, timestamp?: string): void {
    const sequence = this.rows.length + 1;
    this.rows.push({
      streamId: this.streamId,
      sequence,
      timestamp: timestamp ?? new Date(EPOCH_MS + sequence * 1000).toISOString(),
      type,
      schemaVersion: '1.0',
      data,
    });
  }

  /** Returns the rows in stream order. */
  list(): readonly WorkflowEvent[] {
    return [...this.rows];
  }
}

/**
 * Appends the rows of the task list. The first row is one patch with each task at `pending`.
 * Then each complete task gets one completion row, and each failed task gets one failure row.
 * A task entry that is not a record stays as given in the patch and gets no row.
 */
function addTaskRows(writer: RowWriter, tasks: unknown): void {
  const list = listOf(tasks);
  writer.add('state.patched', {
    patch: { tasks: list.map((task) => (isRecord(task) ? { ...task, status: 'pending' } : task)) },
  });
  for (const task of list) {
    if (!isRecord(task) || typeof task.id !== 'string') continue;
    if (task.status === 'complete') writer.add('task.completed', { taskId: task.id });
    if (task.status === 'failed') writer.add('task.failed', { taskId: task.id });
  }
}

/**
 * Encodes one corpus fixture.
 * The first row is the start row. A transition row follows when the fixture phase is not the initial phase.
 * Then each other top-level key gets one patch row. The task rows follow, and each `_events` entry gets one row.
 * @throws when a top-level key is a reserved field, because the fold skips a reserved path with no error.
 * @throws when an `_events` entry is not a record with a string `type`.
 */
export function encodeCorpusFixture(
  fixture: CorpusFixtureShape,
  options: CorpusEncodeOptions = {},
): EncodedCorpusFixture {
  const writer = new RowWriter(fixture.id);
  writer.add('workflow.started', { featureId: fixture.id, workflowType: fixture.workflowType });
  const initialPhase = getInitialPhase(fixture.workflowType);
  if (fixture.from !== initialPhase) {
    writer.add('workflow.transition', { featureId: fixture.id, from: initialPhase, to: fixture.from });
  }

  const ephemerals: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fixture.state)) {
    if (key.startsWith('_')) {
      ephemerals[key] = value;
      continue;
    }
    if (ROW_KEYS.has(key) || key === 'tasks') continue;
    if (isReservedField(key)) {
      throw new Error(`the corpus fixture '${fixture.id}' holds the reserved top-level key '${key}'`);
    }
    writer.add('state.patched', { patch: { [key]: value } });
  }
  if ('tasks' in fixture.state) addTaskRows(writer, fixture.state.tasks);

  const document: Record<string, unknown> = {
    ...fixture.state,
    phase: fixture.from,
    workflowType: fixture.workflowType,
  };
  const applyWriterRule = options.mergeWriterRule ?? true;
  for (const entry of listOf(fixture.state._events)) {
    if (!isRecord(entry) || typeof entry.type !== 'string') {
      throw new Error(`the corpus fixture '${fixture.id}' holds an _events entry with no string type`);
    }
    writer.add(entry.type, entryData(entry), typeof entry.timestamp === 'string' ? entry.timestamp : undefined);
    const writerPhase = writerPhaseOf(entry);
    if (applyWriterRule && writerPhase !== undefined) {
      const prior = document.mergeOrchestrator;
      document.mergeOrchestrator = { ...(isRecord(prior) ? prior : {}), phase: writerPhase };
    }
  }

  return { document, rows: writer.list(), ephemerals };
}
