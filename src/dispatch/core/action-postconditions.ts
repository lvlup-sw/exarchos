/**
 * Post-dispatch observation of declared action postconditions.
 *
 * An action that `ensures` a durable fact has promised that the fact is
 * observable after the handler returns. This module reads that promise back
 * and asks two authorities what actually landed:
 *
 *   - the event store, for `event-append` ensures — a committed row on this
 *     operation, of the named type;
 *   - the persisted-evidence reader, for `durable-evidence` ensures — a
 *     committed `admission.evidence-recorded` row whose evidence kind matches.
 *
 * A branded in-memory witness is not either of those. The witness constructor
 * performs no I/O and consults nothing; passing one here cannot discharge an
 * ensure. A declaration is likewise not observation: `ensures: declared(...)`
 * names the debt, it does not pay it.
 *
 * This checker reports `satisfied` or `violated`. It does not invent a third
 * or fourth status, and it does not block the dispatch return — wiring the
 * verdict onto success is a separate concern. The subject set is the
 * success-path ensures (`when: success` and `when: always`). Failure-path
 * observation of `failure` and `always` is a later check.
 */

import type { ActionPostcondition, DeclaredSet } from '../../registry/action-contract.js';
import {
  readPersistedEvidence,
  type PersistedEvidenceSource,
} from '../../workflow/admission/evidence-reader.js';

export type PostconditionObservationStatus = 'satisfied' | 'violated';

/**
 * The store slice an event-append ensure needs. `EventStore.query` satisfies
 * this structurally — the checker never writes.
 */
export interface PostconditionStore {
  query(
    streamId: string,
    filters?: { type?: string; operationId?: string },
  ): Promise<readonly { readonly type: string; readonly operationId?: string }[]>;
}

export interface ObserveActionPostconditionsInput {
  readonly ensures: DeclaredSet<ActionPostcondition>;
  readonly store: PostconditionStore;
  readonly evidence: PersistedEvidenceSource;
  readonly streamId: string;
  readonly operationId: string;
  /**
   * In-memory witnesses offered as if they were observation. They are not.
   * Accepted so a caller cannot satisfy an ensure by handing a branded
   * `replayedEvidence` value across the seam.
   */
  readonly witnesses?: readonly unknown[];
}

export interface ActionPostconditionObservation {
  readonly status: PostconditionObservationStatus;
  readonly missing: readonly ActionPostcondition[];
}

function successPathEnsures(
  ensures: DeclaredSet<ActionPostcondition>,
): readonly ActionPostcondition[] {
  if (ensures.kind === 'none') return [];
  return ensures.values.filter((item) => item.when === 'success' || item.when === 'always');
}

function witnessCannotSatisfy(_witness: unknown): false {
  return false;
}

async function eventAppendObserved(
  store: PostconditionStore,
  streamId: string,
  operationId: string,
  event: string,
): Promise<boolean> {
  const rows = await store.query(streamId, { type: event, operationId });
  return rows.some((row) => row.type === event && row.operationId === operationId);
}

async function durableEvidenceObserved(
  evidence: PersistedEvidenceSource,
  streamId: string,
  operationId: string,
  evidenceType: string,
): Promise<boolean> {
  const rows = await readPersistedEvidence(evidence, { streamId, operationId, evidenceType });
  return rows.length > 0;
}

/**
 * Observe declared ensures against the store and the persisted-evidence reader.
 *
 * Pure in the verdict: every declared success-path ensure is either observed
 * or reported missing. Witnesses are consulted only to refuse them.
 */
export async function observeActionPostconditions(
  input: ObserveActionPostconditionsInput,
): Promise<ActionPostconditionObservation> {
  for (const witness of input.witnesses ?? []) {
    if (witnessCannotSatisfy(witness)) {
      // Unreachable: a witness is never observation. Kept so the refuse
      // is a named step, not an implicit skip of the argument.
    }
  }

  const missing: ActionPostcondition[] = [];
  for (const postcondition of successPathEnsures(input.ensures)) {
    const observed =
      postcondition.source === 'event-append'
        ? await eventAppendObserved(
            input.store,
            input.streamId,
            input.operationId,
            postcondition.event,
          )
        : await durableEvidenceObserved(
            input.evidence,
            input.streamId,
            input.operationId,
            postcondition.evidenceType,
          );
    if (!observed) missing.push(postcondition);
  }

  return missing.length === 0
    ? { status: 'satisfied', missing: [] }
    : { status: 'violated', missing };
}
