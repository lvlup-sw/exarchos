/**
 * Run-bundle resolvability oracle.
 *
 * Every artifact digest that a ledger event references must resolve in the bundle
 * store to bytes with that hash. Every custodial settlement record must reference at
 * least one digest. The fast path of the appender replays a settled operation from its
 * claim and reads no bundle bytes. This check is the only reader that sees a deleted blob.
 *
 * - `empty` means that the sweep checked no reference. `true` reports the count it checked.
 * - A custodial settlement with zero references is a violation, per record.
 * - The sweep counts pre-custody settlements and does not check them.
 */

import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { z } from 'zod';

import type { WorkflowEvent } from '../schemas.js';
import { extractBundleRefs, settlementCustody } from './digest-references.js';
import type { BundleResolution, RunBundleStore } from './run-bundle-store.js';

/** The read seam of the sweep. `EventStore` and a fake over a map of streams both satisfy it. */
export interface BundleEventSource {
  listStreams(): string[];
  query(streamId: string): Promise<WorkflowEvent[]>;
}

/**
 * Why a reference failed. `unreadable-blob` is a store fault that is not a content
 * verdict, such as a permissions error. The sweep records it on the reference and continues.
 */
export type BundleViolationKind =
  | 'blob-missing'
  | 'digest-mismatch'
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
  /** Settlement rows from before the custody epoch. The sweep counts them and does not check them. */
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
       * The sweep timed out or threw before it finished. This arm has no counts,
       * because the sweep measured none. An empty `violations` means "nothing
       * collected", not "nothing found".
       */
      ok: false;
      incomplete: true;
      details: string;
      violations: readonly BundleViolation[];
    };

/**
 * A probe-cache key, branded so that only a content digest can look up the memo.
 * Two different blobs can share an artifact id across a crash-retry.
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
 * Sweeps every stream that the source lists and verifies that each bundle reference resolves.
 *
 * The sweep checks the abort signal before each stream, before each event, and around
 * each reference probe. Each check is the only guard for one ledger shape. The walk
 * yields to the event loop once per stream, so the timer of a caller can fire. Each
 * probe gets the signal. A stream read is a synchronous SQLite query, so the signal cannot stop it.
 *
 * The sweep probes each distinct digest once, because the answer is a property of the
 * store. A malformed entry is not a reference. An abort error propagates, and any
 * other store error becomes `unreadable-blob`. Pre-custody settlements add no denominator.
 */
export async function checkRunBundleIntegrity(
  source: BundleEventSource,
  store: RunBundleStore,
  signal?: AbortSignal,
): Promise<BundleIntegrityResult> {
  const streamIds = source.listStreams();
  const violations: BundleViolation[] = [];
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

      if (custody === 'custodial' && refs.length === 0) {
        violations.push({
          kind: 'settlement-without-references',
          streamId,
          sequence: event.sequence,
        });
      }

      for (const ref of refs) {
        abortIfRequested(signal);
        referenceCount += 1;
        const key = formatDigest(ref.digest);
        let verdict = probed.get(key);
        if (verdict === undefined) {
          try {
            verdict = await store.has(ref.digest, signal);
          } catch (error) {
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

  if (referenceCount === 0 && custodialSettlementCount === 0) {
    return { ok: 'empty', ...counts, referenceCount: 0 };
  }

  return { ok: true, ...counts };
}
