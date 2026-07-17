// ─── DR-9 (#1334): removed prune-staleness knobs — shared actionable rejection ─
//
// The debloat wave (DR-9) removed the per-phase staleness knobs from BOTH prune
// surfaces:
//   • the `prune_stale_workflows` MCP/CLI action (`thresholdMinutes`), and
//   • the `.exarchos.yml` `prune:` config block (`stale-after-days` and the
//     legacy `threshold-minutes` alias).
// Per-phase staleness has lived EXCLUSIVELY in `topology.yaml` `staleness`
// blocks since #1334 (v2.10.0-preview.1); these knobs were accepted-but-ignored
// until the wave dropped them.
//
// A legacy caller that still passes one MUST get an ACTIONABLE removal error
// that names the removal (DR-9), the deprecation lineage (#1334), and the real
// configuration surface (`topology.yaml`) — NOT a SILENT ACCEPT (the old plain
// `z.object` strip on the action schema) and NOT an OPAQUE bare
// `unrecognized_keys` (the old `.strict()` on the yaml schema). Both seams parse
// the removed key with `.passthrough().superRefine(...)` so the key stays
// VISIBLE to the refine, which emits the shared actionable message below.
//
// This module has NO imports, so importing it from `registry.ts` and
// `config/yaml-schema.ts` can never form a cycle. Keeping the message here is
// the single source of truth for BOTH seams so the guarantee can't drift.

/** Removed knob(s) on the `prune_stale_workflows` action schema. */
export const REMOVED_PRUNE_ACTION_KNOBS: ReadonlySet<string> = new Set([
  'thresholdMinutes',
]);

/** Surviving key(s) on the `prune_stale_workflows` action schema. */
export const PRUNE_ACTION_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'dryRun',
  'force',
  'includeOneShot',
  // `now` is a test-only ISO-string clock override that the handler reads and
  // validates (prune-stale-workflows.ts: `args.now`). It is intentionally kept
  // OUT of the action schema shape (no user-facing CLI flag) but MUST be a
  // known key so the passthrough+superRefine seam lets it reach the handler
  // instead of rejecting it as an unrecognized key.
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

/**
 * The actionable removal message for a removed prune knob. Names the removal
 * (DR-9), the deprecation lineage (#1334, v2.10.0-preview.1), and the real
 * configuration surface (`topology.yaml` `staleness` blocks) so a legacy caller
 * knows exactly where the capability moved.
 */
export function removedPruneKnobMessage(knob: string): string {
  return (
    `\`${knob}\` was removed (DR-9): deprecated and ignored since #1334 ` +
    `(v2.10.0-preview.1). Per-phase staleness now lives in \`topology.yaml\` ` +
    `\`staleness\` blocks — set \`expectedMaxDwellMinutes\` / ` +
    `\`signals[].thresholdMinutes\` there instead.`
  );
}

/** Generic rejection message for a genuinely-unknown (caller-typo) key. */
export function unrecognizedPruneKeyMessage(key: string): string {
  return `Unrecognized key \`${key}\``;
}
