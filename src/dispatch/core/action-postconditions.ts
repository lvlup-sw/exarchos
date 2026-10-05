/**
 * Post-dispatch observation of declared action postconditions. An action that `ensures` a
 * durable fact promises that the fact is observable after the handler returns.
 *
 * An `event-append` ensure needs a committed row of the named type on this operation. A
 * `durable-evidence` ensure needs a committed evidence row of the matching kind. An in-memory
 * witness or a declaration is not observation, so neither satisfies an ensure.
 *
 * The verdict is `satisfied` or `violated`. A success return with an unobserved applicable
 * ensure is a contract violation.
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
 * The store slice that an event-append ensure needs. `EventStore.query` satisfies it, and the
 * checker never writes.
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
   * The outcome that selects the ensures. Success observes `success` and `always`. Failure
   * observes `failure` and `always`. The default is success.
   */
  readonly outcome?: PostconditionOutcome;
  /**
   * In-memory witnesses offered as if they were observation. They are not.
   * Accepted so a caller cannot satisfy an ensure by handing a branded
   * `replayedEvidence` value across the seam.
   */
  readonly witnesses?: readonly unknown[];
  /**
   * The blob source for artifact-backed evidence. A row that names blobs satisfies an ensure
   * only when each blob resolves. Without a resolver, a row that names blobs does not count.
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

/** Refuses a witness as a named step. A witness is never observation, so the result is always `false`. */
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

/**
 * Finds an evidence row that satisfies a `durable-evidence` ensure. A row with no blobs
 * satisfies it. A row with blobs satisfies it only when each blob resolves. A miss, a tampered
 * byte, and a malformed reference all fail. Each reference is probed, so the result names each unresolved blob.
 */
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
        held = false;
        unresolvedArtifacts.push(reference);
      }
    }
    if (held) return { satisfied: true, unresolvedArtifacts: [] };
  }
  return { satisfied: false, unresolvedArtifacts };
}

/**
 * Observes the declared ensures against the store and the persisted-evidence reader. Each
 * applicable ensure is observed or reported missing. A witness never satisfies an ensure.
 */
export async function observeActionPostconditions(
  input: ObserveActionPostconditionsInput,
): Promise<ActionPostconditionObservation> {
  for (const witness of input.witnesses ?? []) {
    if (witnessCannotSatisfy(witness)) {
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
