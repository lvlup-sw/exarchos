/** Validates the ledger identity inside the transaction that commits a final lifecycle trail. */
import type { DecideOnceStoredEvent, DecideOnceStreamSnapshot } from '../../events/atomic-appender.js';
import { migrateEvents } from '../../events/event-migration.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { foldGuardInput } from '../../projections/guard-input/fold.js';
import { readPhaseAttemptId } from '../phase-attempt-id.js';

/** The row kinds that change workflow phase identity. Saga rows do not change this identity. */
const PHASE_ROW_TYPES: ReadonlySet<string> = new Set(['workflow.started', 'workflow.transition', 'workflow.cancel', 'workflow.cleanup']);

/** A final trail no longer matches its source or admission. */
export class FinalizationChanged extends Error {}

/** The transaction cannot replay the current workflow. */
export class FinalizationReplayFailed extends Error {}

/** The source identity captured before lifecycle side effects. */
export interface FinalizationSource {
  readonly from: string;
  readonly foldAttemptId: string | undefined;
  readonly phaseSequence: number;
}

/** Returns the highest phase-row sequence without counting saga or evidence rows. */
export function highestPhaseRowSequence(rows: readonly WorkflowEvent[]): number {
  return rows.reduce((highest, row) => PHASE_ROW_TYPES.has(row.type) ? Math.max(highest, row.sequence) : highest, 0);
}

/** Converts migrated stored rows without assuming optional event fields exist. */
function workflowEventOf(stored: DecideOnceStoredEvent): WorkflowEvent {
  return {
    streamId: stored.streamId,
    sequence: stored.sequence,
    type: stored.type,
    timestamp: stored.timestamp,
    schemaVersion: typeof stored.schemaVersion === 'string' ? stored.schemaVersion : '1.0',
    ...(stored.data === undefined ? {} : { data: stored.data }),
  };
}

/** Replays a transaction snapshot and rejects a changed phase, attempt or phase-row sequence. */
export function validateFinalization(snapshot: DecideOnceStreamSnapshot, source: FinalizationSource): Readonly<Record<string, unknown>> {
  let rows: WorkflowEvent[];
  let input: Readonly<Record<string, unknown>>;
  try {
    rows = migrateEvents(snapshot.events).map(workflowEventOf);
    if (!rows.some((row) => row.type === 'workflow.started')) throw new Error('The workflow start row is absent');
    input = foldGuardInput(rows);
  } catch (error) {
    throw new FinalizationReplayFailed(error instanceof Error ? error.message : String(error));
  }
  if (input.phase !== source.from || readPhaseAttemptId(input) !== source.foldAttemptId || highestPhaseRowSequence(rows) !== source.phaseSequence) {
    throw new FinalizationChanged('The workflow source changed before finalization');
  }
  return input;
}
