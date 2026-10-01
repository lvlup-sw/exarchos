/**
 * The ledger side of run-bundle custody: how an event names bytes in the bundle
 * store, and how a reader recovers those names.
 *
 * A reference has its OWN event-data field. An admission evidence subject digests a
 * canonical descriptor, not persisted bytes, so it is not a bundle reference. A
 * reference exists only where a writer put one.
 */

import { z } from 'zod';
import {
  ArtifactIdSchema,
  ContentDigestV1Schema,
} from '../../workflow/admission/types.js';
import type { EventType, WorkflowEvent } from '../schemas.js';

/**
 * One (artifact identity, content digest) pair. With `.strict()`, an extra key makes
 * the reference malformed, so the oracle never counts a partly read reference as verified.
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
 * The event-data key that carries bundle references. The settlement data schema and
 * the oracle both use this constant, so the writer and the reader cannot name different fields.
 */
export const BUNDLE_REF_FIELD = 'bundleRefs';

/**
 * An event type that records a settled operation, and the custody EPOCH: the first
 * payload version that must carry a bundle reference. A row from before the epoch
 * settled without a bundle. The row version alone tells the two apart.
 */
export interface SettlementEndpoint {
  readonly type: EventType;
  readonly custodyFromSchemaVersion: string;
}

/**
 * The operation record of the bounded executor. The producer imports this type and
 * version, so the writer, the schema, and the oracle agree.
 */
export const INTENT_EXECUTED_SETTLEMENT = Object.freeze({
  type: 'orchestrate.intent_executed',
  custodyFromSchemaVersion: '1.1',
}) satisfies SettlementEndpoint;

/**
 * The settlement record of the semantic plane. `settle` imports this type and version.
 * The record is custodial from its first version, so no row is pre-custody.
 */
export const EXECUTION_SETTLED_SETTLEMENT = Object.freeze({
  type: 'execution.settled',
  custodyFromSchemaVersion: '1.0',
}) satisfies SettlementEndpoint;

/**
 * The endpoints where a settled operation must reference bytes. Each entry is a
 * registered event type, so the list is data and not a schema change.
 *
 * A custodial settlement with zero references is a violation. Add an endpoint only
 * after its emitter writes bytes. Otherwise the first record of the emitter fails.
 */
export const SETTLEMENT_ENDPOINTS: readonly SettlementEndpoint[] = [
  INTENT_EXECUTED_SETTLEMENT,
  EXECUTION_SETTLED_SETTLEMENT,
];

/** The settlement event types, for readers that key on the name alone. */
export const SETTLED_EVENT_TYPES: readonly EventType[] = SETTLEMENT_ENDPOINTS.map(
  (endpoint) => endpoint.type,
);

/**
 * How a settlement row stands to custody.
 *
 * - `not-a-settlement`: the type is not an endpoint.
 * - `pre-custody`: the payload version is before the epoch. The row is exempt.
 * - `custodial`: the row must reference bytes. An unreadable version is custodial.
 */
export type SettlementCustody = 'not-a-settlement' | 'pre-custody' | 'custodial';

export function settlementCustody(event: WorkflowEvent): SettlementCustody {
  const endpoint = SETTLEMENT_ENDPOINTS.find((candidate) => candidate.type === event.type);
  if (endpoint === undefined) return 'not-a-settlement';
  return compareVersions(event.schemaVersion, endpoint.custodyFromSchemaVersion) < 0
    ? 'pre-custody'
    : 'custodial';
}

/**
 * A version component is a run of decimal digits and nothing else. The check reads
 * the text, because `Number()` turns an empty, signed, hex, or exponent component into
 * a small integer that sorts before the epoch.
 */
const DECIMAL_COMPONENT = /^\d+$/;

/** Negative when `left` sorts before `right`. Unreadable input sorts as newest. */
function compareVersions(left: string, right: string): number {
  const parse = (version: string): readonly number[] | undefined => {
    const parts = version.split('.');
    return parts.every((part) => DECIMAL_COMPONENT.test(part))
      ? parts.map((part) => Number(part))
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
  /** Entries under the reference field that did not parse. The oracle names each one as a defect. */
  readonly malformed: number;
}

/**
 * Recovers the bundle references that an event declares in the dedicated field.
 * A missing, null, or empty field gives zero references and zero malformed entries.
 * A value that is not an array counts as one malformed reference.
 */
export function extractBundleRefs(event: WorkflowEvent): ExtractedBundleRefs {
  const raw = event.data?.[BUNDLE_REF_FIELD];
  if (raw === undefined || raw === null) return { refs: [], malformed: 0 };
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
