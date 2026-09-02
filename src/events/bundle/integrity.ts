/**
 * Run-bundle resolvability oracle.
 *
 * The property: every artifact digest a ledger event references must resolve
 * in the bundle store to bytes whose hash is that digest.
 *
 * The counterexample it exists to close: the appender's operation-claim fast
 * path replays a settled operation straight from its recorded claim, returning
 * the committed result without reading a single bundle byte. A blob deleted
 * after settlement is therefore invisible to replay — the operation still
 * reports success. Nothing else in the system reads those bytes back, so if
 * this check does not name the deletion, nothing does.
 *
 * Two verdict distinctions carry the honesty of the result:
 *
 *   - EMPTY vs CLEAR. A sweep that examined no references is not a sweep that
 *     found no problems. `empty` says the denominator was zero; `true` reports
 *     the denominator it actually checked.
 *   - A settled stream with zero references is a VIOLATION, not `empty`. The
 *     cheapest way to pass a resolvability check is to reference nothing, so
 *     settlement without custody is reported rather than counted as clean.
 */

import type { WorkflowEvent } from '../schemas.js';
import { extractBundleRefs, isSettlementEvent } from './digest-references.js';
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
  | 'malformed-reference'
  | 'settled-stream-without-references';

export interface BundleViolation {
  readonly kind: BundleViolationKind;
  readonly streamId: string;
  readonly sequence: number;
  /** `algorithm:value` of the offending digest, when the violation has one. */
  readonly digest?: string;
}

export type BundleIntegrityResult =
  | { ok: 'skipped'; reason: string }
  | { ok: 'empty'; scannedStreamCount: number; referenceCount: 0 }
  | { ok: true; scannedStreamCount: number; referenceCount: number }
  | {
      ok: false;
      scannedStreamCount: number;
      referenceCount: number;
      details: string;
      violations: readonly BundleViolation[];
      /**
       * Set when the sweep did not run to completion (it timed out, or it threw
       * before it could finish). The counts on such a result are UNKNOWN rather
       * than measured, and `violations` being empty means "nothing was
       * collected" rather than "nothing was found". Without this flag a
       * hardcoded zero-count abort verdict is shape-identical to a genuine
       * zero-denominator failure, and only prose in `details` separates them.
       */
      incomplete?: true;
    };

function formatDigest(digest: { algorithm: string; value: string }): string {
  return `${digest.algorithm}:${digest.value}`;
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error('aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * Sweep every stream the source enumerates and verify each declared bundle
 * reference resolves.
 *
 * The abort signal is re-checked before each stream is fetched AND before each
 * of that stream's events is examined, so a caller's timeout actually stops the
 * sweep rather than merely discarding its result — this walks the whole ledger,
 * so an unbounded sweep would outlive the bound its caller advertised. Both
 * checks are load-bearing on their own: the per-stream one is the only guard
 * for a source with many streams and few events, and the per-event one is the
 * only guard once a single long stream is already being walked. Each is pinned
 * by a case that aborts mid-sweep and asserts how much work was left undone.
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
  const probed = new Map<string, BundleResolution>();
  let referenceCount = 0;
  let settledStreamCount = 0;

  for (const streamId of streamIds) {
    abortIfRequested(signal);
    const events = await source.query(streamId);

    let streamReferenceCount = 0;
    let settledAt: number | undefined;

    for (const event of events) {
      abortIfRequested(signal);

      if (settledAt === undefined && isSettlementEvent(event)) {
        settledAt = event.sequence;
      }

      const { refs, malformed } = extractBundleRefs(event);
      for (let i = 0; i < malformed; i += 1) {
        violations.push({
          kind: 'malformed-reference',
          streamId,
          sequence: event.sequence,
        });
      }

      for (const ref of refs) {
        // A reference the oracle cannot parse was already counted as a
        // violation above; only parsed references enter the denominator, so
        // the count always means "references actually probed".
        referenceCount += 1;
        streamReferenceCount += 1;
        const key = formatDigest(ref.digest);
        let verdict = probed.get(key);
        if (verdict === undefined) {
          verdict = await store.has(ref.digest);
          probed.set(key, verdict);
        }
        if (verdict === 'missing') {
          violations.push({
            kind: 'blob-missing',
            streamId,
            sequence: event.sequence,
            digest: key,
          });
        } else if (verdict === 'mismatch') {
          violations.push({
            kind: 'digest-mismatch',
            streamId,
            sequence: event.sequence,
            digest: key,
          });
        }
      }
    }

    if (settledAt !== undefined) {
      settledStreamCount += 1;
      if (streamReferenceCount === 0) {
        violations.push({
          kind: 'settled-stream-without-references',
          streamId,
          sequence: settledAt,
        });
      }
    }
  }

  if (violations.length > 0) {
    return {
      ok: false,
      scannedStreamCount: streamIds.length,
      referenceCount,
      details: `${violations.length} run-bundle violation(s) across ${referenceCount} reference(s) in ${streamIds.length} stream(s)`,
      violations,
    };
  }

  // Nothing referenced bytes AND nothing settled: the sweep ran but had no
  // denominator, which is a different statement from "every reference
  // resolved" and is reported as such.
  if (referenceCount === 0 && settledStreamCount === 0) {
    return { ok: 'empty', scannedStreamCount: streamIds.length, referenceCount: 0 };
  }

  return { ok: true, scannedStreamCount: streamIds.length, referenceCount };
}
