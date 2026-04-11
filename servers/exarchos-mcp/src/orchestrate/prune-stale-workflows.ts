/**
 * Pure selection logic for stale-workflow pruning (T7).
 *
 * This file intentionally contains no IO: no FS reads, no event store,
 * no `git`/`gh` shell-outs, no `Date.now()` at module scope. Tests inject
 * a `now` Date for deterministic staleness computation. The orchestrate
 * handler (`handlePruneStaleWorkflows`, added later in T3) will live in
 * the same file and compose this function with real IO.
 */

// Terminal phases are redeclared locally (rather than imported from
// views/tools.ts where they live inside a handler scope). Values must
// match `views/tools.ts:322`; change both in lockstep.
const TERMINAL_PHASES = ['completed', 'cancelled'] as const;

// 7 days in minutes — matches the plan's v1 default threshold.
const DEFAULT_THRESHOLD_MINUTES = 10_080;

/**
 * Minimal subset of a workflow list entry needed for prune selection.
 * Mirrors the shape produced by `handleList` in `workflow/tools.ts`,
 * but only includes the fields this pure function actually reads so
 * fixtures stay lightweight.
 */
export interface WorkflowListEntry {
  featureId: string;
  workflowType: string;
  phase: string;
  stateFile: string;
  _checkpoint: {
    lastActivityTimestamp: string;
  };
}

export interface PruneConfig {
  /** Minutes of inactivity before a workflow is considered stale. Default 10080 (7 days). */
  thresholdMinutes?: number;
  /** When false, oneshot workflows are excluded from candidates. Default true. */
  includeOneShot?: boolean;
}

export interface PruneCandidate {
  featureId: string;
  workflowType: string;
  phase: string;
  /** Minutes since `_checkpoint.lastActivityTimestamp` at selection time. */
  stalenessMinutes: number;
}

export interface PruneExclusion {
  featureId: string;
  reason: 'terminal' | 'fresh' | 'oneshot-excluded';
}

export interface PruneSelection {
  candidates: PruneCandidate[];
  excluded: PruneExclusion[];
}

/**
 * Compute minutes since a checkpoint's last activity.
 *
 * Pure helper — takes `now` as a parameter rather than calling
 * `Date.now()`, so callers (and tests) can inject a deterministic clock.
 */
function minutesSince(lastActivityTimestamp: string, now: Date): number {
  const last = new Date(lastActivityTimestamp).getTime();
  if (Number.isNaN(last)) return 0;
  const diffMs = Math.max(0, now.getTime() - last);
  return Math.floor(diffMs / (60 * 1000));
}

/** True if the entry has been inactive longer than `thresholdMinutes`. */
function isBeyondThreshold(
  checkpoint: { lastActivityTimestamp: string },
  thresholdMinutes: number,
  now: Date,
): boolean {
  return minutesSince(checkpoint.lastActivityTimestamp, now) > thresholdMinutes;
}

function isTerminalPhase(phase: string): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase);
}

/**
 * Pure function: given a list of workflow entries and a config, partition
 * them into prune candidates and exclusions (with reasons).
 *
 * Exclusion precedence (highest first):
 *   1. terminal phase  → reason: 'terminal'
 *   2. oneshot filter  → reason: 'oneshot-excluded' (only when `includeOneShot === false`)
 *   3. freshness       → reason: 'fresh'
 *
 * @param entries  Workflow summaries (typically from `handleList`).
 * @param config   Threshold + oneshot toggle; all fields optional.
 * @param now      Injectable clock for deterministic tests. Defaults to `new Date()`.
 */
export function selectPruneCandidates(
  entries: WorkflowListEntry[],
  config: PruneConfig = {},
  now: Date = new Date(),
): PruneSelection {
  const thresholdMinutes = config.thresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES;
  const includeOneShot = config.includeOneShot ?? true;

  const candidates: PruneCandidate[] = [];
  const excluded: PruneExclusion[] = [];

  for (const entry of entries) {
    if (isTerminalPhase(entry.phase)) {
      excluded.push({ featureId: entry.featureId, reason: 'terminal' });
      continue;
    }

    if (!includeOneShot && entry.workflowType === 'oneshot') {
      excluded.push({ featureId: entry.featureId, reason: 'oneshot-excluded' });
      continue;
    }

    if (!isBeyondThreshold(entry._checkpoint, thresholdMinutes, now)) {
      excluded.push({ featureId: entry.featureId, reason: 'fresh' });
      continue;
    }

    candidates.push({
      featureId: entry.featureId,
      workflowType: entry.workflowType,
      phase: entry.phase,
      stalenessMinutes: minutesSince(entry._checkpoint.lastActivityTimestamp, now),
    });
  }

  return { candidates, excluded };
}
