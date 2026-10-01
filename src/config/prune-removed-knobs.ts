/**
 * Shared rejection messages for the prune staleness knobs that are removed.
 * The `prune_stale_workflows` action and the `.exarchos.yml` `prune:` block both reject them.
 * Per-phase staleness lives only in the `staleness` blocks of `topology.yaml`.
 *
 * A caller that passes a removed knob gets an actionable error that names `topology.yaml`.
 * Both schemas use `.passthrough().superRefine(...)`, so the removed key stays visible to the refinement.
 * This module has no imports, so `lifecycle-ops.ts` and `yaml-schema.ts` can import it without a cycle.
 */

/** Removed knob(s) on the `prune_stale_workflows` action schema. */
export const REMOVED_PRUNE_ACTION_KNOBS: ReadonlySet<string> = new Set([
  'thresholdMinutes',
]);

/** Surviving key(s) on the `prune_stale_workflows` action schema. */
export const PRUNE_ACTION_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'dryRun',
  'force',
  'includeOneShot',
  /**
   * Test-only clock override (an ISO string) that the handler reads.
   * It is not in the schema shape, so it has no CLI flag. It is a known key, so the refinement lets it reach the handler.
   */
  'now',
]);

/** Removed knob(s) on the `.exarchos.yml` `prune:` config block. */
export const REMOVED_PRUNE_CONFIG_KNOBS: ReadonlySet<string> = new Set([
  'stale-after-days',
  'threshold-minutes',
  'thresholdMinutes',
]);

/** Surviving key(s) on the `.exarchos.yml` `prune:` config block. */
export const PRUNE_CONFIG_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'max-batch-size',
  'phase-exclusions',
  'malformed-handling',
  'require-dry-run',
]);

/** Removal message for a removed prune knob. It tells the caller to use the `staleness` blocks of `topology.yaml`. */
export function removedPruneKnobMessage(knob: string): string {
  return (
    `\`${knob}\` was removed (DR-9): deprecated and ignored since #1334 ` +
    `(v2.10.0-preview.1). Per-phase staleness now lives in \`topology.yaml\` ` +
    `\`staleness\` blocks — set \`expectedMaxDwellMinutes\` / ` +
    `\`signals[].thresholdMinutes\` there instead.`
  );
}

/** Rejection message for an unknown key, such as a typo. */
export function unrecognizedPruneKeyMessage(key: string): string {
  return `Unrecognized key \`${key}\``;
}
