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
 * or fourth status. Dispatch wires the verdict after effects land: a success
 * return is a contract violation when an applicable ensure cannot be observed.
 * The subject set follows the outcome — success reads `success` and `always`;
 * failure reads `failure` and `always`.
 */

import type { ActionPostcondition, DeclaredSet } from '../../registry/action-contract.js';
import type { EvidenceArtifactResolver } from '../../workflow/admission/evidence-artifact.js';
import {
  readPersistedEvidence,
  type PersistedEvidenceSource,
} from '../../workflow/admission/evidence-reader.js';
import type { EvidenceArtifactReferenceV1 } from '../../workflow/admission/types.js';

export type PostconditionObservationStatus = 'satisfied' | 'violated';
export type PostconditionOutcome = 'success' | 'failure';

/**
 * The store slice an event-append ensure needs. `EventStore.query` satisfies
 * this structurally — the checker never writes.
 */
export interface PostconditionStore {
  query(
    streamId: string,
    filters?: { type?: string | undefined; operationId?: string | undefined },
  ): Promise<readonly { readonly type: string; readonly operationId?: string | undefined }[]>;
}

export interface ObserveActionPostconditionsInput {
  readonly ensures: DeclaredSet<ActionPostcondition>;
  readonly store: PostconditionStore;
  readonly evidence: PersistedEvidenceSource;
  readonly streamId: string;
  readonly operationId: string;
  /**
   * Which ensure `when` values apply. Success observes `success` and
   * `always`; failure observes `failure` and `always`. Omitted means the
   * success subject set, which is the path that cannot return success
   * when an applicable ensure is missing.
   */
  readonly outcome?: PostconditionOutcome;
  /**
   * In-memory witnesses offered as if they were observation. They are not.
   * Accepted so a caller cannot satisfy an ensure by handing a branded
   * `replayedEvidence` value across the seam.
   */
  readonly witnesses?: readonly unknown[];
  /**
   * The blob source behind artifact-backed evidence. A row that names blobs
   * pays an ensure only if every one of them resolves — byte length,
   * canonical envelope, subject digest. Optional at the type level because a
   * caller with no state directory has no store to offer; a row naming blobs
   * when no resolver was supplied does NOT count, which is the fail-closed
   * direction.
   */
  readonly artifactResolver?: EvidenceArtifactResolver;
}

export interface ActionPostconditionObservation {
  readonly status: PostconditionObservationStatus;
  readonly missing: readonly ActionPostcondition[];
  /**
   * Artifact references a durable-evidence row named that did not resolve.
   * Present only when the violation traces to an unresolved blob, so a
   * caller can name the blob rather than only the ensure it broke.
   */
  readonly unresolvedArtifacts?: readonly EvidenceArtifactReferenceV1[];
}

/**
 * The ensures that apply to one dispatch outcome. Reasoned abstention
 * (`kind: 'none'`) contributes nothing — there is no append to observe.
 */
export function applicableEnsures(
  ensures: DeclaredSet<ActionPostcondition>,
  outcome: PostconditionOutcome,
): readonly ActionPostcondition[] {
  if (ensures.kind === 'none') return [];
  const matched = outcome === 'success' ? 'success' : 'failure';
  return ensures.values.filter((item) => item.when === matched || item.when === 'always');
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

interface DurableEvidenceObservation {
  readonly satisfied: boolean;
  /** References from rows that named a blob and did not get one back. */
  readonly unresolvedArtifacts: readonly EvidenceArtifactReferenceV1[];
}

async function durableEvidenceObserved(
  evidence: PersistedEvidenceSource,
  streamId: string,
  operationId: string,
  evidenceType: string,
  resolver: EvidenceArtifactResolver | undefined,
): Promise<DurableEvidenceObservation> {
  const rows = await readPersistedEvidence(evidence, { streamId, operationId, evidenceType });
  const unresolvedArtifacts: EvidenceArtifactReferenceV1[] = [];
  for (const row of rows) {
    if (row.artifactRefs.length === 0) {
      return { satisfied: true, unresolvedArtifacts: [] };
    }
    if (resolver === undefined) continue;
    let held = true;
    for (const reference of row.artifactRefs) {
      try {
        await resolver.resolve(reference);
      } catch {
        // A blob that will not resolve is a blob that is not there. The row
        // named it, so the row is not evidence -- a miss, a tampered byte
        // and a malformed reference are one answer here on purpose. Every
        // reference on the row is still probed, so the violation names each
        // missing blob rather than only the first one met.
        held = false;
        unresolvedArtifacts.push(reference);
      }
    }
    if (held) return { satisfied: true, unresolvedArtifacts: [] };
  }
  return { satisfied: false, unresolvedArtifacts };
}

/**
 * Observe declared ensures against the store and the persisted-evidence reader.
 *
 * Pure in the verdict: every applicable ensure is either observed or
 * reported missing. Witnesses are consulted only to refuse them.
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
  const unresolvedArtifacts: EvidenceArtifactReferenceV1[] = [];
  for (const postcondition of applicableEnsures(input.ensures, input.outcome ?? 'success')) {
    if (postcondition.source === 'event-append') {
      const observed = await eventAppendObserved(
        input.store,
        input.streamId,
        input.operationId,
        postcondition.event,
      );
      if (!observed) missing.push(postcondition);
      continue;
    }
    const observation = await durableEvidenceObserved(
      input.evidence,
      input.streamId,
      input.operationId,
      postcondition.evidenceType,
      input.artifactResolver,
    );
    if (!observation.satisfied) {
      missing.push(postcondition);
      unresolvedArtifacts.push(...observation.unresolvedArtifacts);
    }
  }

  return missing.length === 0
    ? { status: 'satisfied', missing: [] }
    : {
        status: 'violated',
        missing,
        ...(unresolvedArtifacts.length === 0 ? {} : { unresolvedArtifacts }),
      };
}
