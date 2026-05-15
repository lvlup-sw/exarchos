/**
 * Read-side v:1 → v:2 rehydration upgrade — T3 (#1246-readside-migration, DR-18).
 *
 * Pure migration helpers that consume T1's frozen v:1 schema exports
 * (`HandoffEntrySchemaV1`, `RehydrationDocumentSchemaV1`) and produce v:2
 * shapes that pass `RehydrationDocumentSchema` strict-mode validation. The
 * write path NEVER calls these — writers always emit v:2. Only the read
 * entry point (`loadRehydrationDocument` in `serialize.ts`) routes legacy
 * snapshots through here.
 *
 * Fail-open contract (DR-18):
 *   - Per-entry: a v:1 handoff entry without a usable `eventRef.sequence`
 *     (pre-#1230 advisory-absent case) raises `HandoffEntryUpgradeError`.
 *     The caller drops the entry and appends a degraded blocker.
 *   - Per-document: every entry can fail without tearing down the envelope.
 *     `latestHandoff` becomes `undefined`; bad `recentHandoffs` are skipped;
 *     a structured blocker records each drop so the rehydration consumer can
 *     surface the degradation rather than treating it as a clean state.
 *
 * The envelope-level routing (neither v:1 nor v:2) raises
 * `InvalidEnvelopeError` from the read entry point — corruption surfaces as
 * a typed throw, never as a silent empty document.
 */
import { z } from 'zod';
import type {
  HandoffEntryV1,
  HandoffEntryV2,
  RehydrationDocument,
  RehydrationDocumentV2,
  RehydrationDocumentV3,
  RehydrationDocumentV4,
} from './schema.js';

/**
 * Per-entry upgrade failure. Caught at the document scope so a single bad
 * entry does not poison the rest of the envelope (DR-18 fail-open).
 */
export class HandoffEntryUpgradeError extends Error {
  constructor(reason: string) {
    super(`v1 handoff entry upgrade failed: ${reason}`);
    this.name = 'HandoffEntryUpgradeError';
  }
}

/**
 * Envelope-routing failure: the input has none of `v: 1` / `v: 2` / `v: 3` /
 * `v: 4`. Raised by `loadRehydrationDocument` so callers see typed
 * corruption, not a silently-substituted empty doc.
 */
export class InvalidEnvelopeError extends Error {
  constructor(zodError: z.ZodError) {
    super(
      `Rehydration envelope has none of v:1 / v:2 / v:3 / v:4 shape: ${zodError.message}`,
    );
    this.name = 'InvalidEnvelopeError';
  }
}

/**
 * Inferred type of the v:1 envelope. Not exported from `schema.ts` (writers
 * MUST NOT construct v:1) but inferable locally for migration plumbing.
 */
import type { RehydrationDocumentSchemaV1 } from './schema.js';
type RehydrationDocumentV1 = z.infer<typeof RehydrationDocumentSchemaV1>;

/**
 * Upgrade a single v:1 handoff entry to v:2.
 *
 * Behavior:
 *   - Drops `eventRef.id` unconditionally (v:2 strict mode rejects it).
 *   - Promotes `eventRef.sequence` to required; throws if missing.
 *   - Carries `context`, `nextSteps`, `suggestions` through verbatim.
 */
export function upgradeHandoffEntryV1toV2(entry: HandoffEntryV1): HandoffEntryV2 {
  if (typeof entry.eventRef.sequence !== 'number') {
    throw new HandoffEntryUpgradeError('missing usable sequence');
  }
  const upgraded: HandoffEntryV2 = {
    eventRef: {
      sequence: entry.eventRef.sequence,
      timestamp: entry.eventRef.timestamp,
    },
  };
  if (entry.context !== undefined) upgraded.context = entry.context;
  if (entry.nextSteps !== undefined) upgraded.nextSteps = entry.nextSteps;
  if (entry.suggestions !== undefined) upgraded.suggestions = entry.suggestions;
  return upgraded;
}

/**
 * Degraded-blocker shape used when a per-entry upgrade fails. Conforms to
 * the volatile `BlockerEntrySchema` record-shape branch, so the v:2 schema
 * accepts the upgraded document.
 */
function degradedBlocker(scope: string, error: Error): Record<string, unknown> {
  return {
    source: 'rehydration.upgrade-v1-to-v2',
    kind: 'degraded',
    scope,
    reason: `${scope} upgrade failed`,
    error: error.message,
  };
}

/**
 * Upgrade a parsed v:1 rehydration document to v:2.
 *
 * Per-entry fail-open: each handoff entry that throws
 * `HandoffEntryUpgradeError` is dropped and a degraded blocker is appended.
 * The doc-level call never throws on entry failures — only on truly broken
 * envelopes (which the v:1 schema parse would have already rejected upstream).
 */
export function upgradeRehydrationDocumentV1toV2(
  v1doc: RehydrationDocumentV1,
): RehydrationDocumentV2 {
  const blockers = [...v1doc.blockers];

  let latestHandoff: HandoffEntryV2 | undefined;
  if (v1doc.latestHandoff) {
    try {
      latestHandoff = upgradeHandoffEntryV1toV2(v1doc.latestHandoff);
    } catch (err) {
      if (err instanceof HandoffEntryUpgradeError) {
        blockers.push(degradedBlocker('latestHandoff', err));
      } else {
        throw err;
      }
    }
  }

  const recentHandoffs: HandoffEntryV2[] = [];
  for (const entry of v1doc.recentHandoffs ?? []) {
    try {
      recentHandoffs.push(upgradeHandoffEntryV1toV2(entry));
    } catch (err) {
      if (err instanceof HandoffEntryUpgradeError) {
        blockers.push(degradedBlocker('recentHandoffs entry', err));
      } else {
        throw err;
      }
    }
  }

  // Reconstruct the envelope explicitly rather than spreading: spreading
  // would carry the v:1 `v: 1` literal through and the strict v:2 envelope
  // schema would reject it. Spreading also makes it easy to accidentally
  // leak v:1-shaped fields if T1's schema gains optional fields later.
  const v2doc: RehydrationDocumentV2 = {
    v: 2,
    projectionSequence: v1doc.projectionSequence,
    behavioralGuidance: v1doc.behavioralGuidance,
    workflowState: v1doc.workflowState,
    taskProgress: v1doc.taskProgress,
    decisions: v1doc.decisions,
    artifacts: v1doc.artifacts,
    blockers,
    recentHandoffs,
  };
  if (v1doc.nextAction !== undefined) v2doc.nextAction = v1doc.nextAction;
  if (latestHandoff !== undefined) v2doc.latestHandoff = latestHandoff;

  return v2doc;
}

/**
 * Upgrade a v:2 rehydration document to v:3 (T-02, rehydration-machinery-refactor).
 *
 * Pure field drop:
 *   - `behavioralGuidance` is removed — it was vestigial in v:2 and is no
 *     longer part of v:3 StableSectionsSchema.
 *   - `phasePlaybook` is seeded `null` — it is composed at handler time
 *     (T-20), not folded from events.
 *
 * All other fields (`workflowState`, `projectionSequence`, and every volatile
 * section) are preserved verbatim.
 */
export function upgradeRehydrationDocumentV2toV3(
  doc: RehydrationDocumentV2,
): RehydrationDocumentV3 {
  // Destructure to drop behavioralGuidance; spread the rest verbatim.
  const { behavioralGuidance: _drop, ...rest } = doc;
  return {
    ...rest,
    v: 3,
    phasePlaybook: null,
  };
}

/**
 * Upgrade a v:3 rehydration document to v:4 (#1359 / PR4 T12,
 * projection-drift fix).
 *
 * Pure vocabulary rename on `taskProgress[].status`:
 *   - `'completed' → 'complete'`     (canonical TaskSchema vocabulary)
 *   - `'assigned'  → 'in_progress'`  (canonical TaskSchema vocabulary)
 *
 * All other v:3 fields (`workflowState`, `projectionSequence`, every other
 * volatile section, `phasePlaybook`) are preserved verbatim. The schema
 * widens `status` to `z.string()` so the structural shape is unchanged —
 * the version bump exists to signal that a v:3 reader cannot reliably
 * substring-compare against canonical `tasks[].status` whereas a v:4
 * reader can.
 */
export function upgradeRehydrationDocumentV3toV4(
  doc: RehydrationDocumentV3,
): RehydrationDocumentV4 {
  const renameStatus = (raw: string): string => {
    if (raw === 'completed') return 'complete';
    if (raw === 'assigned') return 'in_progress';
    return raw;
  };
  return {
    ...doc,
    v: 4,
    taskProgress: doc.taskProgress.map((entry) => ({
      ...entry,
      status: renameStatus(entry.status),
    })),
  };
}

/**
 * Upgrade any versioned rehydration document to the latest (v:4) shape.
 *
 * Routes through the version chain:
 *   v:1 → v:2  (upgradeRehydrationDocumentV1toV2)
 *   v:2 → v:3  (upgradeRehydrationDocumentV2toV3)
 *   v:3 → v:4  (upgradeRehydrationDocumentV3toV4, #1359 / PR4)
 *
 * Returns a `RehydrationDocumentV4`. Only the read entry point
 * (`loadRehydrationDocument` in `serialize.ts`) should call this; writers
 * always emit v:4 directly.
 */
export function upgradeRehydrationDocument(
  doc: RehydrationDocumentV1 | RehydrationDocumentV2 | RehydrationDocument,
): RehydrationDocumentV4 {
  if (doc.v === 1) {
    return upgradeRehydrationDocumentV3toV4(
      upgradeRehydrationDocumentV2toV3(upgradeRehydrationDocumentV1toV2(doc)),
    );
  }
  if (doc.v === 2) {
    return upgradeRehydrationDocumentV3toV4(
      upgradeRehydrationDocumentV2toV3(doc),
    );
  }
  if (doc.v === 3) {
    return upgradeRehydrationDocumentV3toV4(doc);
  }
  // v:4 — already at latest.
  return doc;
}
