/**
 * Read-side upgrades of rehydration documents from v:1, v:2 and v:3 to v:4.
 *
 * Writers emit the latest version. Only the read entry point,
 * `loadRehydrationDocument` in `serialize.ts`, routes older snapshots through
 * these pure helpers.
 *
 * The v:1 to v:2 step fails open. A v:1 handoff entry without a usable
 * `eventRef.sequence` raises `HandoffEntryUpgradeError`. The document upgrade
 * drops that entry and appends a degraded blocker, so a consumer can report the
 * loss instead of a clean state.
 *
 * An envelope of no known version raises `InvalidEnvelopeError` in the read entry
 * point, never a silent empty document.
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
 * Upgrade failure of one handoff entry. The document upgrade catches it, so one
 * bad entry does not break the rest of the envelope.
 */
export class HandoffEntryUpgradeError extends Error {
  constructor(reason: string) {
    super(`v1 handoff entry upgrade failed: ${reason}`);
    this.name = 'HandoffEntryUpgradeError';
  }
}

/**
 * Envelope failure: the input has none of the `v: 1` to `v: 4` shapes.
 * `loadRehydrationDocument` raises it, so callers see typed corruption.
 */
export class InvalidEnvelopeError extends Error {
  constructor(zodError: z.ZodError) {
    super(
      `Rehydration envelope has none of v:1 / v:2 / v:3 / v:4 shape: ${zodError.message}`,
    );
    this.name = 'InvalidEnvelopeError';
  }
}

import type { RehydrationDocumentSchemaV1 } from './schema.js';
/** The v:1 envelope type. `schema.ts` does not export it, because writers must not build v:1. */
type RehydrationDocumentV1 = z.infer<typeof RehydrationDocumentSchemaV1>;

/**
 * Upgrade one v:1 handoff entry to v:2.
 *
 *   - Drops `eventRef.id`, because v:2 strict mode rejects it.
 *   - Requires `eventRef.sequence`, and throws when it is missing.
 *   - Copies `context`, `nextSteps` and `suggestions` unchanged.
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
 * Each handoff entry that throws `HandoffEntryUpgradeError` is dropped, and a
 * degraded blocker is appended. Other errors propagate. The function builds the
 * v:2 envelope field by field, not with a spread, so no v:1 field leaks into
 * the strict v:2 envelope.
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
 * Upgrade a v:2 rehydration document to v:3.
 *
 *   - Drops `behavioralGuidance`, which the v:3 `StableSectionsSchema` does not hold.
 *   - Sets `phasePlaybook` to `null`. The handler composes it, and no event fold sets it.
 *
 * All other fields stay unchanged.
 */
export function upgradeRehydrationDocumentV2toV3(
  doc: RehydrationDocumentV2,
): RehydrationDocumentV3 {
  const { behavioralGuidance: _drop, ...rest } = doc;
  return {
    ...rest,
    v: 3,
    phasePlaybook: null,
  };
}

/**
 * Upgrade a v:3 rehydration document to v:4.
 *
 * It renames two `taskProgress[].status` values to the canonical `TaskSchema`
 * words: `'completed'` becomes `'complete'`, and `'assigned'` becomes `'in_progress'`.
 * All other fields stay unchanged. The shape does not change, because `status`
 * is a `z.string()`. The version bump tells a reader that v:4 status values
 * compare directly with the canonical `tasks[].status`.
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
 * Upgrade a rehydration document of any version to v:4, one step at a time
 * through the chain v:1, v:2, v:3, v:4. A v:4 document returns unchanged.
 * Only `loadRehydrationDocument` in `serialize.ts` calls this.
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
  return doc;
}
