// ─── The event-authority corpus: one realistic event of every catalog type ───
//
// Shared by the two differentials that both need the same population — the
// canonical workflow-state fold, and the secondary-view telemetry dependence.
// One builder, so neither can drift into measuring a different catalog than the
// other, and so a new event type joins both without anyone editing either.
//
// The payloads are GENERATED from each type's own data schema, never empty. A
// corpus of empty bags makes a differential nearly unfalsifiable: a reducer arm
// that reads a field before it mutates cannot fire on an empty bag, so most
// types fold to a no-op for a reason that has nothing to do with their
// classification.

import type { z } from 'zod';
import { buildEvent } from '../../src/events/event-factory.js';
import { EVENT_DATA_SCHEMAS, EventTypes, type WorkflowEvent } from '../../src/events/schemas.js';
import { sampleEventData } from './event-payload-sample.js';

/**
 * Payloads for the catalog types that declare no data schema, so the corpus has
 * no empty-bag holes for a fold arm to hide behind. `state.patched` is the one
 * that matters — its patch bag is hash-unrecoverable by construction, which is
 * exactly why it has no schema and exactly why it must not fold as a no-op.
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
 * Constraints a schema states as a refinement, which JSON Schema cannot carry
 * and the sampler therefore cannot see: a workflow type must be a registered
 * name, and a migration source path must be state-dir relative. These are
 * merged over the sampled payload; the validity assertion in the partition
 * oracle is what keeps this table honest, because a refinement the sampler can
 * suddenly satisfy makes its row here dead cover the next reader should delete.
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
 * One event of every catalog type, in catalog order. Total over the catalog by
 * construction, so it cannot go vacuous when a type is added.
 *
 * The timestamp is fixed so two folds compare a state whose time fields came
 * from the events rather than from the clock.
 *
 * KNOWN LIMIT, and it bounds every claim made over this corpus: the identifiers
 * across events do not CORRELATE. Each payload is sampled from its own schema in
 * isolation, so a handler that resolves an id against state an earlier event
 * would have built finds no match and returns the state unchanged. Such a type
 * folds as a no-op here for a reason that is about the corpus, not about the
 * type. Consumers that care must name their blind spots rather than read
 * independence as proof.
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
