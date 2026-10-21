/**
 * Post-dispatch observation of declared action postconditions. An action that `ensures` a
 * durable fact promises that the fact is observable after the handler returns.
 *
 * An `event-append` ensure needs a committed row of the named type on this operation. A
 * `durable-evidence` ensure needs a committed evidence row of the matching kind. An in-memory
 * witness or a declaration is not observation, so neither satisfies an ensure.
 *
 * A replay of a keyed append appends nothing and returns the stored row of an earlier operation.
 * That stored row satisfies an `event-append` ensure of its type when the store shows it.
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
 * checker never writes. The sequence and the idempotency key identify the stored row of a replay.
 */
export interface PostconditionStore {
  query(
    streamId: string,
    filters?: { type?: string | undefined; operationId?: string | undefined },
  ): Promise<
    readonly {
      readonly type: string;
      readonly operationId?: string | undefined;
      readonly sequence?: number;
      readonly idempotencyKey?: string | undefined;
    }[]
  >;
}

/** The acknowledgement of one stored row, in the shape of `toEventAck`. */
interface RowAcknowledgement {
  readonly streamId: string;
  readonly sequence: number;
  readonly type: string;
}

/** The row that a reply acknowledges, or undefined when the reply is not an event acknowledgement. */
function rowAcknowledgement(reply: unknown): RowAcknowledgement | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined;
  const streamId: unknown = Reflect.get(reply, 'streamId');
  const sequence: unknown = Reflect.get(reply, 'sequence');
  const type: unknown = Reflect.get(reply, 'type');
  if (typeof streamId !== 'string' || typeof sequence !== 'number' || typeof type !== 'string') return undefined;
  return { streamId, sequence, type };
}

/**
 * The event type of the stored row that a reply replays, or undefined when the reply replays no stored row.
 * A keyed append that finds its key appends nothing and returns the stored row, so the reply acknowledges that row.
 * The store must hold the row on the stream at the acknowledged sequence, with the acknowledged type and an idempotency key.
 * The store is the observation. The acknowledgement only names the row.
 *
 * Limit: no declaration names the idempotency key of its emission, so the check does not bind the key of the row to the call.
 * A stored keyed row of the acknowledged type passes, also when the key belongs to another call, such as another task.
 * The handler that builds the reply chooses the row.
 */
export async function replayedRowType(
  store: PostconditionStore,
  streamId: string,
  reply: unknown,
): Promise<string | undefined> {
  const acknowledged = rowAcknowledgement(reply);
  if (acknowledged === undefined || acknowledged.streamId !== streamId) return undefined;
  const rows = await store.query(streamId, { type: acknowledged.type });
  const stored = rows.find(
    (row) =>
      row.sequence === acknowledged.sequence &&
      row.type === acknowledged.type &&
      row.idempotencyKey !== undefined &&
      row.idempotencyKey.length > 0,
  );
  return stored === undefined ? undefined : stored.type;
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
  /**
   * The reply data of the handler. When it acknowledges a stored keyed row, {@link replayedRowType}
   * reads that row from the store, and the row satisfies an `event-append` ensure of its type.
   * The check does not bind the key of the row to this call. {@link replayedRowType} states the limit.
   */
  readonly reply?: unknown;
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
 * A stored keyed row that the reply acknowledges satisfies an `event-append` ensure of its type.
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
  let replayed: Promise<string | undefined> | undefined;
  for (const postcondition of applicableEnsures(input.ensures, input.outcome ?? 'success')) {
    if (postcondition.source === 'event-append') {
      const observed = await eventAppendObserved(
        input.store,
        input.streamId,
        input.operationId,
        postcondition.event,
      );
      if (observed) continue;
      replayed ??= replayedRowType(input.store, input.streamId, input.reply);
      if ((await replayed) !== postcondition.event) missing.push(postcondition);
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
