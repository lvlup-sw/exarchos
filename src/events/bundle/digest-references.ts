/**
 * The ledger side of run-bundle custody: how an appended event names bytes
 * that live in the bundle store, and how a reader recovers those names.
 *
 * The reference is carried in its OWN event-data field rather than reusing an
 * admission evidence subject. Those subjects carry a digest of a canonicalised
 * descriptor, not of bytes anyone promised to persist, so keying the extractor
 * off them would report a missing blob for every digest that was never a
 * bundle in the first place. A dedicated field means a reference exists only
 * where a writer deliberately put one, and its absence is silence rather than
 * a false accusation.
 */

import { z } from 'zod';
import {
  ArtifactIdSchema,
  ContentDigestV1Schema,
} from '../../workflow/admission/types.js';
import type { EventType, WorkflowEvent } from '../schemas.js';

/**
 * One (artifact identity, content digest) pair. `.strict()` so an extra key
 * reads as a malformed reference rather than being silently dropped — a
 * reference the oracle cannot fully understand must not be counted as one it
 * verified.
 */
export const BundleRefV1Schema = z
  .object({
    artifactId: ArtifactIdSchema,
    digest: ContentDigestV1Schema,
  })
  .strict()
  .readonly();

export type BundleRefV1 = z.infer<typeof BundleRefV1Schema>;

/**
 * The event-data key that carries bundle references. The settlement record's
 * data schema declares its field under this constant (a computed key), and
 * the oracle reads under it, so a rename cannot leave the reader looking at a
 * field nobody writes any more — the two would fail to compile apart.
 */
export const BUNDLE_REF_FIELD = 'bundleRefs';

/**
 * A settlement endpoint: an event type whose rows record that an operation
 * settled, together with the payload schema version from which such a row is
 * required to carry a bundle reference.
 *
 * The version is the custody EPOCH. A settlement row written before custody
 * existed carries the payload version its producer stamped at the time, and
 * that row is a record of an operation that settled without a bundle — not a
 * lost one. The row itself says which contract it was written under, so the
 * oracle needs no backfill, no clock, and no per-install migration to tell
 * the two apart. Everything from the epoch on must reference bytes.
 */
export interface SettlementEndpoint {
  readonly type: EventType;
  readonly custodyFromSchemaVersion: string;
}

/**
 * The bounded executor's operation record. The producer stamps this type and
 * this version on every row it commits, importing them from here, so the
 * writer, the schema and the oracle cannot name three different things.
 */
export const INTENT_EXECUTED_SETTLEMENT = {
  type: 'orchestrate.intent_executed',
  custodyFromSchemaVersion: '1.1',
} as const satisfies SettlementEndpoint;

/**
 * The settlement endpoints this oracle keys its "a settled operation must
 * reference bytes" assertion on. Membership is DATA, not a schema change: the
 * names here are already-registered event types, so extending the set is a
 * one-line edit rather than a change to what the store will accept. The next
 * entry is the semantic `execution.settled` kind, when its emitter exists.
 *
 * A custodial settlement carrying zero references is reported as a violation
 * rather than skipped, because the degenerate way to pass a resolvability
 * check is to reference nothing at all.
 */
export const SETTLEMENT_ENDPOINTS: readonly SettlementEndpoint[] = [INTENT_EXECUTED_SETTLEMENT];

/** The settlement event types, for readers that key on the name alone. */
export const SETTLED_EVENT_TYPES: readonly EventType[] = SETTLEMENT_ENDPOINTS.map(
  (endpoint) => endpoint.type,
);

/**
 * How a settlement row stands to custody.
 *
 *   - `not-a-settlement`: the type is not an endpoint.
 *   - `pre-custody`: an endpoint row whose payload version predates the epoch;
 *     it settled without a bundle and is exempt from the reference rule.
 *   - `custodial`: an endpoint row written under the custody contract; it
 *     must reference bytes.
 *
 * Versions are `major.minor` strings compared numerically per part, which is
 * the shape every producer in this tree stamps. A version the comparison
 * cannot read is treated as custodial, so an unparseable stamp cannot be a
 * way to opt a settlement out of the rule.
 */
export type SettlementCustody = 'not-a-settlement' | 'pre-custody' | 'custodial';

export function settlementCustody(event: WorkflowEvent): SettlementCustody {
  const endpoint = SETTLEMENT_ENDPOINTS.find((candidate) => candidate.type === event.type);
  if (endpoint === undefined) return 'not-a-settlement';
  return compareVersions(event.schemaVersion, endpoint.custodyFromSchemaVersion) < 0
    ? 'pre-custody'
    : 'custodial';
}

/** Negative when `left` sorts before `right`; unreadable input sorts as newest. */
function compareVersions(left: string, right: string): number {
  const parse = (version: string): readonly number[] | undefined => {
    const parts = version.split('.').map((part) => Number(part));
    return parts.length > 0 && parts.every((part) => Number.isInteger(part) && part >= 0)
      ? parts
      : undefined;
  };
  const a = parse(left);
  const b = parse(right);
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export interface ExtractedBundleRefs {
  readonly refs: readonly BundleRefV1[];
  /**
   * Entries present under the reference field that did not parse. Counted
   * rather than dropped: an unreadable reference is a defect the oracle must
   * name, not an absence it may treat as a clean event.
   */
  readonly malformed: number;
}

/**
 * Recover the bundle references an event declares.
 *
 * Reads the dedicated field only. Absence is silence: a missing (or null)
 * field yields zero references and zero malformed entries, because an event
 * that never claimed to carry bundle bytes is not evidence of a broken bundle.
 * An empty array is the same silence, deliberately declared.
 *
 * A present-but-non-array value is NOT silence — a writer reached for the
 * custody field and produced something no reader can follow, so it is counted
 * as one malformed reference rather than dropped.
 */
export function extractBundleRefs(event: WorkflowEvent): ExtractedBundleRefs {
  const raw = event.data?.[BUNDLE_REF_FIELD];
  if (raw === undefined || raw === null) return { refs: [], malformed: 0 };
  // A non-array under the field is itself one malformed reference: a writer
  // meant to declare custody and produced something unreadable.
  if (!Array.isArray(raw)) return { refs: [], malformed: 1 };

  const refs: BundleRefV1[] = [];
  let malformed = 0;
  for (const entry of raw) {
    const parsed = BundleRefV1Schema.safeParse(entry);
    if (parsed.success) {
      refs.push(parsed.data);
    } else {
      malformed += 1;
    }
  }
  return { refs, malformed };
}
