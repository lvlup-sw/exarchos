// The event-authority corpus: one realistic event of every catalog type.
//
// Two differentials share it: the canonical workflow-state fold and the telemetry dependence of
// the secondary views. One builder keeps both on the same catalog, and a new event type joins both.
//
// The payloads come from the data schema of each type, and are never empty. A reducer arm that
// reads a field before it mutates cannot fire on an empty bag. Thus empty bags make a differential
// almost impossible to fail.

import type { z } from 'zod';
import { buildEvent } from '../../src/events/event-factory.js';
import { EVENT_DATA_SCHEMAS, EventTypes, type WorkflowEvent } from '../../src/events/schemas.js';
import { sampleEventData } from './event-payload-sample.js';

/**
 * Payloads for the catalog types that declare no data schema, so no fold arm sees an empty bag.
 * `state.patched` is the important one. Its patch bag is hash-unrecoverable by design. That is
 * why it has no schema, and why it must not fold as a no-op.
 */
export const UNSCHEMATIZED_PAYLOADS: Readonly<Record<string, Record<string, unknown>>> = {
  'state.patched': { patch: { 'oneshot.synthesisPolicy': 'always' } },
  'pr.created': { prNumber: 1, url: 'https://example.invalid/pr/1' },
  'pr.merged': { prNumber: 1, mergedAt: '2026-01-01T00:00:00.000Z' },
  'pr.commented': { prNumber: 1, body: 'sample comment' },
  'issue.created': { issueNumber: 1, url: 'https://example.invalid/issue/1' },
  'checkpoint.enforced': { reason: 'sample reason' },
  'checkpoint.state_missing': { featureId: 'feat-authority-corpus' },
  'preflight.executed': { check: 'sample check', passed: true },
  'preflight.blocked': { check: 'sample check', reason: 'sample reason' },
};

export const CORPUS_SCHEMAS: Readonly<Record<string, z.ZodType | undefined>> =
  EVENT_DATA_SCHEMAS;

/**
 * Constraints that a schema states as a refinement. JSON Schema cannot carry them, so the sampler
 * cannot see them. A workflow type must be a registered name, and a migration source path must be
 * relative to the state directory. `payloadFor` merges these values over the sampled payload.
 *
 * The validity test in the partition oracle fails when a needed row is absent. When the sampler
 * can satisfy a refinement, its row here is dead, and you can delete it.
 */
const REFINEMENT_OVERRIDES: Readonly<Record<string, Record<string, unknown>>> = {
  'workflow.started': { workflowType: 'feature' },
  'migration.legacy_jsonl_imported': { sourcePath: 'legacy/events.jsonl' },
};

/** The payload the corpus uses for a type, and where it came from. */
export interface CorpusPayload {
  readonly data: Record<string, unknown>;
  readonly source: 'schema' | 'unschematized' | 'none';
}

export function payloadFor(eventType: string): CorpusPayload {
  const sampled = sampleEventData(CORPUS_SCHEMAS[eventType]);
  if (sampled !== undefined && Object.keys(sampled).length > 0) {
    return { data: { ...sampled, ...REFINEMENT_OVERRIDES[eventType] }, source: 'schema' };
  }
  const supplied = UNSCHEMATIZED_PAYLOADS[eventType];
  if (supplied !== undefined) return { data: supplied, source: 'unschematized' };
  return { data: {}, source: 'none' };
}

export const CORPUS_PAYLOADS: ReadonlyMap<string, CorpusPayload> = new Map(
  EventTypes.map((type) => [type, payloadFor(type)] as const),
);

/**
 * One event of every catalog type, in catalog order. It is total over the catalog, so a new type
 * cannot make it vacuous. The timestamp is fixed, so the time fields of two folds come from the
 * events and not from the clock.
 *
 * Known limit: the identifiers do not correlate across events. Each payload comes from its own
 * schema, so a handler that looks up an id in state from an earlier event finds no match. Such a
 * type folds as a no-op because of the corpus, not because of the type. A consumer must name
 * these blind spots, and must not read a no-op as proof of independence.
 */
export function buildAuthorityCorpus(streamId: string): readonly WorkflowEvent[] {
  return EventTypes.map((type, index) =>
    buildEvent(streamId, index + 1, {
      type,
      data: CORPUS_PAYLOADS.get(type)?.data ?? {},
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
  );
}
