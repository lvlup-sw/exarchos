/**
 * Run-bundle resolvability oracle.
 *
 * The property: every artifact digest a ledger event references must resolve
 * in the bundle store to bytes whose hash is that digest, and every settlement
 * record written under the custody contract must reference at least one.
 *
 * The counterexample it exists to close: the appender's operation-claim fast
 * path replays a settled operation straight from its recorded claim, returning
 * the committed result without reading a single bundle byte. A blob deleted
 * after settlement is therefore invisible to replay — the operation still
 * reports success. Nothing else in the system reads those bytes back, so if
 * this check does not name the deletion, nothing does.
 *
 * Three verdict distinctions carry the honesty of the result:
 *
 *   - EMPTY vs CLEAR. A sweep that examined no references is not a sweep that
 *     found no problems. `empty` says the denominator was zero; `true` reports
 *     the denominator it actually checked.
 *   - A custodial settlement with zero references is a VIOLATION, not `empty`.
 *     The cheapest way to pass a resolvability check is to reference nothing,
 *     so settlement without custody is reported rather than counted as clean.
 *     The rule is evaluated per settlement record: one referenced settlement
 *     cannot answer for a later one that referenced nothing.
 *   - PRE-CUSTODY settlements are counted, not condemned. A settlement row
 *     whose payload version predates the custody epoch settled without a
 *     bundle by contract, and the sweep reports how many such rows it saw so
 *     "nothing to check" and "everything predates custody" stay distinct.
 */

import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { z } from 'zod';

import type { WorkflowEvent } from '../schemas.js';
import { extractBundleRefs, settlementCustody } from './digest-references.js';
import type { BundleResolution, RunBundleStore } from './run-bundle-store.js';

/**
 * Read seam the sweep needs. `EventStore` satisfies this structurally, and so
 * does a fake built over a plain map of streams, which keeps the verdict logic
 * testable without a substrate.
 */
export interface BundleEventSource {
  listStreams(): string[];
  query(streamId: string): Promise<WorkflowEvent[]>;
}

export type BundleViolationKind =
  | 'blob-missing'
  | 'digest-mismatch'
  /**
   * The store could not answer for the blob for a reason that is not a content
   * verdict — a permissions error, an unreadable directory. Named on the
   * reference it was probing for and the sweep continues, so one environment
   * fault does not erase every violation already collected or masquerade as a
   * sweep that ran out of time.
   */
  | 'unreadable-blob'
  | 'malformed-reference'
  | 'settlement-without-references';

export interface BundleViolation {
  readonly kind: BundleViolationKind;
  readonly streamId: string;
  readonly sequence: number;
  /** `algorithm:value` of the offending digest, when the violation has one. */
  readonly digest?: string;
  /** The fault the store raised, for `unreadable-blob`. */
  readonly detail?: string;
}

/** The counts a sweep that ran to completion can honestly report. */
interface SweepCounts {
  readonly scannedStreamCount: number;
  readonly referenceCount: number;
  /** Settlement rows written before the custody epoch; seen, exempt, not checked. */
  readonly preCustodySettlementCount: number;
}

export type BundleIntegrityResult =
  | { ok: 'skipped'; reason: string }
  | ({ ok: 'empty'; referenceCount: 0 } & SweepCounts)
  | ({ ok: true } & SweepCounts)
  | ({
      ok: false;
      incomplete?: undefined;
      details: string;
      violations: readonly [BundleViolation, ...BundleViolation[]];
    } & SweepCounts)
  | {
      /**
       * The sweep did not run to completion: it timed out, or it threw before
       * it could finish. There are no counts on this arm because none were
       * measured — a shape that could carry zeroes here would let an aborted
       * sweep read as a completed sweep of nothing. `violations` holds what was
       * collected before the interruption, which may be empty and means
       * "nothing collected", never "nothing found".
       */
      ok: false;
      incomplete: true;
      details: string;
      violations: readonly BundleViolation[];
    };

/**
 * A probe-cache key. Branded so the memo can only be consulted with the thing
 * it answers about — the content digest — and never with an artifact id,
 * which two different blobs may legitimately share across a crash-retry.
 */
const DigestKeySchema = z.string().brand<'BundleDigestKey'>();
type DigestKey = z.infer<typeof DigestKeySchema>;

function formatDigest(digest: { algorithm: string; value: string }): DigestKey {
  return DigestKeySchema.parse(`${digest.algorithm}:${digest.value}`);
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error('aborted');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Sweep every stream the source enumerates and verify each declared bundle
 * reference resolves.
 *
 * The abort signal is re-checked before each stream is fetched, before each
 * of that stream's events is examined, AND around each reference probe, so a
 * caller's timeout actually stops the sweep rather than merely discarding its
 * result — this walks the whole ledger, so an unbounded sweep would outlive
 * the bound its caller advertised. All three checks are load-bearing on their
 * own: the per-stream one is the only guard for a source with many streams and
 * few events, the per-event one is the only guard once a single long stream is
 * already being walked, and the per-reference one is the only guard inside a
 * single event that declares many distinct digests. Each is pinned by a case
 * that aborts mid-sweep and asserts how much work was left undone.
 *
 * Reading the flag is not enough on its own. A caller's timeout is a timer,
 * and a timer only fires when the event loop gets a turn; a ledger with many
 * streams and no references never awaits anything that yields, so the flag
 * would be read a million times and never be set. The walk therefore yields
 * to the event loop once per stream, which is what lets the bound bind on
 * every ledger shape rather than only on one blocked in a blob read.
 *
 * The signal is also handed to each probe, so a file read that is still
 * pending when the caller cancels is itself abandoned rather than merely
 * having its verdict discarded. Stream reads are not cancellable: the source
 * is a synchronous SQLite query that has either returned or not started, so
 * the between-streams check is the bound on that side.
 */
export async function checkRunBundleIntegrity(
  source: BundleEventSource,
  store: RunBundleStore,
  signal?: AbortSignal,
): Promise<BundleIntegrityResult> {
  const streamIds = source.listStreams();
  const violations: BundleViolation[] = [];
  // One probe per distinct digest. `has` re-reads and re-hashes the blob, and
  // the question it answers — "do the persisted bytes hash to this digest" — is
  // a property of the store, not of the referencing event, so a second read
  // within one sweep cannot answer differently. Each reference still gets its
  // own violation attributed to its own stream and sequence.
  const probed = new Map<DigestKey, BundleResolution | { readonly unreadable: string }>();
  let referenceCount = 0;
  let custodialSettlementCount = 0;
  let preCustodySettlementCount = 0;

  for (const streamId of streamIds) {
    abortIfRequested(signal);
    await yieldToEventLoop();
    abortIfRequested(signal);
    const events = await source.query(streamId);

    for (const event of events) {
      abortIfRequested(signal);

      const custody = settlementCustody(event);
      if (custody === 'pre-custody') preCustodySettlementCount += 1;
      if (custody === 'custodial') custodialSettlementCount += 1;

      const { refs, malformed } = extractBundleRefs(event);
      for (let i = 0; i < malformed; i += 1) {
        violations.push({
          kind: 'malformed-reference',
          streamId,
          sequence: event.sequence,
        });
      }

      // Per record, not per stream: a settlement that references nothing is a
      // custody gap on that record whatever its neighbours carry. A malformed
      // entry does not count as a reference — it is named above, and the
      // record that carried only malformed entries still settled with nothing
      // a reader can follow.
      if (custody === 'custodial' && refs.length === 0) {
        violations.push({
          kind: 'settlement-without-references',
          streamId,
          sequence: event.sequence,
        });
      }

      for (const ref of refs) {
        // The per-event check above cannot stop a walk that is already inside
        // one event: a single event may declare many distinct digests, and
        // each probe yields to the event loop, so the signal is re-checked
        // before every reference and again after its probe resolves.
        abortIfRequested(signal);
        // A reference the oracle cannot parse was already counted as a
        // violation above; only parsed references enter the denominator, so
        // the count always means "references actually probed".
        referenceCount += 1;
        const key = formatDigest(ref.digest);
        let verdict = probed.get(key);
        if (verdict === undefined) {
          try {
            verdict = await store.has(ref.digest, signal);
          } catch (error) {
            // Cancellation is the caller's exception, not a verdict. Anything
            // else is an environment fault on THIS blob: recorded against the
            // reference and the sweep goes on, so the rest of the ledger still
            // gets checked and the fault is reported as a fault.
            if (isAbortError(error)) throw error;
            verdict = { unreadable: error instanceof Error ? error.message : String(error) };
          }
          abortIfRequested(signal);
          probed.set(key, verdict);
        }
        if (verdict === 'missing') {
          violations.push({ kind: 'blob-missing', streamId, sequence: event.sequence, digest: key });
        } else if (verdict === 'mismatch') {
          violations.push({ kind: 'digest-mismatch', streamId, sequence: event.sequence, digest: key });
        } else if (verdict !== 'ok') {
          violations.push({
            kind: 'unreadable-blob',
            streamId,
            sequence: event.sequence,
            digest: key,
            detail: verdict.unreadable,
          });
        }
      }
    }
  }

  const counts: SweepCounts = {
    scannedStreamCount: streamIds.length,
    referenceCount,
    preCustodySettlementCount,
  };

  const [first, ...rest] = violations;
  if (first !== undefined) {
    return {
      ok: false,
      ...counts,
      details: `${violations.length} run-bundle violation(s) across ${referenceCount} reference(s) in ${streamIds.length} stream(s)`,
      violations: [first, ...rest],
    };
  }

  // Nothing referenced bytes AND nothing settled under custody: the sweep ran
  // but had no denominator, which is a different statement from "every
  // reference resolved" and is reported as such. Pre-custody settlements do
  // not make a denominator — they are exempt by contract, and their count is
  // carried so a reader can see why a ledger full of settlements checked out
  // as empty.
  if (referenceCount === 0 && custodialSettlementCount === 0) {
    return { ok: 'empty', ...counts, referenceCount: 0 };
  }

  return { ok: true, ...counts };
}
