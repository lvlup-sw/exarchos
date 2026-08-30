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
import type { WorkflowEvent } from '../schemas.js';

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
 * The event-data key that carries bundle references. Writers and the oracle
 * both import this rather than spelling the string, so a rename cannot leave
 * the reader looking at a field nobody writes any more.
 */
export const BUNDLE_REF_FIELD = 'bundleRefs';

/**
 * The settlement endpoints this oracle keys its "a settled stream must
 * reference bytes" assertion on. Membership is DATA, not a schema change: the
 * names here are already-registered event types, so extending the set is a
 * one-line edit rather than a change to what the store will accept.
 *
 * A settled stream carrying zero references is reported as a violation rather
 * than skipped, because the degenerate way to pass a resolvability check is to
 * reference nothing at all.
 */
export const SETTLED_EVENT_TYPES: readonly string[] = [
  'orchestrate.intent_executed',
];

/** Whether `event` is one of the settlement endpoints named above. */
export function isSettlementEvent(event: WorkflowEvent): boolean {
  return SETTLED_EVENT_TYPES.includes(event.type);
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
