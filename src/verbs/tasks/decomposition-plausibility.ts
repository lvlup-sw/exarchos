/**
 * Plausibility signals for a task decomposition, on top of the structural gate in `task-decomposition.ts`.
 * Each signal is a pure predicate: breadth, behavior count, historical size, risk uniformity, and boundary uniformity.
 * An implausible decomposition returns a structured challenge, not a hard failure.
 * Only a recorded, non-empty override rationale suppresses a challenge. The result keeps each suppressed challenge in `overridden`, with its rationale.
 */

import type { RiskTier } from '../../workflow/verification-policy.js';

/** The calibrated plausibility signals this module evaluates. */
export type PlausibilitySignal =
  | 'breadth'
  | 'behavior-count'
  | 'historical-size'
  | 'risk-uniformity'
  | 'boundary-uniformity';

const TASK_SCOPED_SIGNALS: readonly PlausibilitySignal[] = [
  'breadth',
  'behavior-count',
  'historical-size',
];

const PLAN_SCOPED_SIGNALS: readonly PlausibilitySignal[] = [
  'risk-uniformity',
  'boundary-uniformity',
];

const ALL_SIGNALS: readonly PlausibilitySignal[] = [
  ...TASK_SCOPED_SIGNALS,
  ...PLAN_SCOPED_SIGNALS,
];

/** Per-signal override rationales, keyed by signal. */
export type OverrideMap = Readonly<Partial<Record<PlausibilitySignal, string>>>;

/**
 * Calibrated thresholds for the plausibility signals. A caller can pass numbers for its repository.
 * `DEFAULT_PLAUSIBILITY_BASELINE` applies when the caller passes none.
 */
export interface PlausibilityBaseline {
  /** The largest number of distinct directories that one task can span with no challenge. */
  readonly maxBreadth: number;
  /** The largest number of distinct behaviors that one task can claim with no challenge. */
  readonly maxBehaviorCount: number;
  /** Max declared file count for a single task (historical-size outlier bound). */
  readonly maxFileCount: number;
  /** The minimum number of tasks at which an all-`low` risk stamp or an all-`false` boundary stamp causes a challenge. */
  readonly uniformityMinTasks: number;
}

export const DEFAULT_PLAUSIBILITY_BASELINE: PlausibilityBaseline = Object.freeze({
  maxBreadth: 4,
  maxBehaviorCount: 8,
  maxFileCount: 12,
  uniformityMinTasks: 10,
});

/** A single task's plausibility-relevant inputs, already extracted from markdown. */
export interface PlausibilityTaskInput {
  readonly id: string;
  /** Declared file targets (allowlisted paths). */
  readonly files: readonly string[];
  /** Count of distinct behaviors the task claims to deliver. */
  readonly behaviorCount: number;
  /** Stamped verification-ladder tier, if the task declares one. */
  readonly riskTier?: RiskTier;
  /** Stamped boundary-touching flag, if the task declares one. */
  readonly boundaryTouching?: boolean;
  /** Per-signal, task-scoped override rationales. */
  readonly overrides?: OverrideMap;
}

/** A structured plausibility challenge the caller can act on. */
export interface PlausibilityChallenge {
  readonly signal: PlausibilitySignal;
  readonly scope: 'task' | 'plan';
  /** Present when `scope === 'task'`. */
  readonly taskId?: string;
  /** The observed value that tripped the signal. */
  readonly observed: number;
  /** The baseline threshold the observed value exceeded. */
  readonly threshold: number;
  readonly message: string;
}

/** A challenge that was suppressed by a recorded, non-empty override rationale. */
export interface OverriddenChallenge extends PlausibilityChallenge {
  readonly overrideRationale: string;
}

/** The full structured result of a plausibility assessment. */
export interface PlausibilityAssessment {
  /** True iff at least one active (non-overridden) challenge exists. */
  readonly challenged: boolean;
  /** Active challenges — those NOT suppressed by an override rationale. */
  readonly challenges: readonly PlausibilityChallenge[];
  /** Challenges suppressed by a recorded override rationale (auditable). */
  readonly overridden: readonly OverriddenChallenge[];
}

export interface PlausibilityOptions {
  readonly baseline?: PlausibilityBaseline;
  /** Plan-level override rationales for plan-scoped signals. */
  readonly planOverrides?: OverrideMap;
}

/**
 * The directory of a file path: the text before the last separator, or `.` for a bare file name.
 * The function converts `\` to `/` first, so a Windows path and a POSIX path give the same directory.
 */
function directoryOf(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const idx = normalised.lastIndexOf('/');
  return idx === -1 ? '.' : normalised.slice(0, idx);
}

/**
 * Breadth: the number of distinct directories that the files of a task span. The function skips an empty path.
 */
export function computeBreadth(files: readonly string[]): number {
  const dirs = new Set<string>();
  for (const file of files) {
    if (file.length === 0) continue;
    dirs.add(directoryOf(file));
  }
  return dirs.size;
}

/**
 * A `Method_Scenario_Outcome` test identifier: three PascalCase segments joined by underscores.
 * Each distinct identifier is one claimed behavior.
 */
const BEHAVIOR_TOKEN = /[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+/g;

/**
 * Behavior count: the number of distinct behavior tokens in a task block.
 * The function dedups, because one behavior name often occurs in a `[RED]` step and again in a checklist.
 */
export function countBehaviors(block: string): number {
  const seen = new Set<string>();
  const matches = block.match(BEHAVIOR_TOKEN);
  if (matches) {
    for (const m of matches) seen.add(m);
  }
  return seen.size;
}

/**
 * Matches the same `**Boundary Touching:** <bool>` spellings as `parse-task-stamps.ts`.
 * `(?![\w-])` makes a malformed suffix fail to match, where `\b` misclassifies it.
 */
const BOUNDARY_STAMP = /boundary\s*touching\*{0,2}\s*:\s*\*{0,2}\s*(true|false)(?![\w-])/i;

/**
 * Reads the `**Boundary Touching:**` stamp of a task block.
 * It returns `undefined` when the block has no well-formed stamp, so the uniformity signal can require a stamp on each task.
 */
export function extractBoundaryTouching(block: string): boolean | undefined {
  const match = BOUNDARY_STAMP.exec(block);
  if (!match || match[1] === undefined) return undefined;
  return match[1].toLowerCase() === 'true';
}

/**
 * An override line: `**Plausibility Override:** <signal>: <rationale>`.
 * A line with an empty rationale does not match, so it cannot suppress a challenge.
 */
const OVERRIDE_LINE =
  /^\s*\*{0,2}\s*plausibility\s+override\s*\*{0,2}\s*:\s*\*{0,2}\s*([a-z-]+)\s*[:\-–—]\s*(\S.*?)\s*$/i;

function isPlausibilitySignal(value: string): value is PlausibilitySignal {
  return (ALL_SIGNALS as readonly string[]).includes(value);
}

/**
 * Parses the override lines of a markdown span into a map from signal to rationale.
 * The function ignores an unknown signal and an empty rationale. For one signal, the last line wins.
 */
export function parseOverrides(text: string): OverrideMap {
  const overrides: Partial<Record<PlausibilitySignal, string>> = {};
  for (const line of text.split('\n')) {
    const match = OVERRIDE_LINE.exec(line);
    if (!match) continue;
    const rawSignal = (match[1] ?? '').toLowerCase();
    const rationale = (match[2] ?? '').trim();
    if (rationale.length === 0) continue;
    if (!isPlausibilitySignal(rawSignal)) continue;
    overrides[rawSignal] = rationale;
  }
  return overrides;
}

/** A deterministic sample of historical per-task sizes to calibrate against. */
export interface HistoricalSizeSample {
  readonly fileCounts: readonly number[];
  readonly behaviorCounts: readonly number[];
}

/**
 * The nearest-rank percentile of a numeric sample, with `p` in [0,1].
 * It returns 0 for an empty sample.
 */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? 0;
}

/**
 * Derives a baseline from a historical size sample, with no git access at check time.
 * The file-count bound and the behavior-count bound are each the 90th-percentile size times `slack`, with `DEFAULT_PLAUSIBILITY_BASELINE` as the floor.
 * The floor stops a sample of small tasks from making a threshold too strict. `overrides` win over the derived values.
 */
export function deriveBaseline(
  sample: HistoricalSizeSample,
  overrides: Partial<PlausibilityBaseline> = {},
  slack = 2,
): PlausibilityBaseline {
  const floor = DEFAULT_PLAUSIBILITY_BASELINE;
  const maxFileCount = Math.max(
    floor.maxFileCount,
    Math.ceil(percentile(sample.fileCounts, 0.9) * slack),
  );
  const maxBehaviorCount = Math.max(
    floor.maxBehaviorCount,
    Math.ceil(percentile(sample.behaviorCounts, 0.9) * slack),
  );
  return {
    maxBreadth: overrides.maxBreadth ?? floor.maxBreadth,
    maxBehaviorCount: overrides.maxBehaviorCount ?? maxBehaviorCount,
    maxFileCount: overrides.maxFileCount ?? maxFileCount,
    uniformityMinTasks: overrides.uniformityMinTasks ?? floor.uniformityMinTasks,
  };
}

/**
 * Assesses a decomposition for plausibility from the inputs that `extractPlausibilityInputs` extracts.
 * The plan-level uniformity signals apply only when the task count reaches `uniformityMinTasks`.
 */
export function assessDecompositionPlausibility(
  tasks: readonly PlausibilityTaskInput[],
  options: PlausibilityOptions = {},
): PlausibilityAssessment {
  const baseline = options.baseline ?? DEFAULT_PLAUSIBILITY_BASELINE;
  const planOverrides = options.planOverrides ?? {};

  const active: PlausibilityChallenge[] = [];
  const overridden: OverriddenChallenge[] = [];

  const record = (challenge: PlausibilityChallenge, rationale: string | undefined): void => {
    const trimmed = rationale?.trim();
    if (trimmed && trimmed.length > 0) {
      overridden.push({ ...challenge, overrideRationale: trimmed });
    } else {
      active.push(challenge);
    }
  };

  for (const task of tasks) {
    const overrides = task.overrides ?? {};

    const breadth = computeBreadth(task.files);
    if (breadth > baseline.maxBreadth) {
      record(
        {
          signal: 'breadth',
          scope: 'task',
          taskId: task.id,
          observed: breadth,
          threshold: baseline.maxBreadth,
          message:
            `Task ${task.id} spans ${breadth} distinct modules ` +
            `(baseline ${baseline.maxBreadth}); consider splitting it along module lines.`,
        },
        overrides['breadth'],
      );
    }

    if (task.behaviorCount > baseline.maxBehaviorCount) {
      record(
        {
          signal: 'behavior-count',
          scope: 'task',
          taskId: task.id,
          observed: task.behaviorCount,
          threshold: baseline.maxBehaviorCount,
          message:
            `Task ${task.id} claims ${task.behaviorCount} distinct behaviors ` +
            `(baseline ${baseline.maxBehaviorCount}); a task this broad is likely under-decomposed.`,
        },
        overrides['behavior-count'],
      );
    }

    if (task.files.length > baseline.maxFileCount) {
      record(
        {
          signal: 'historical-size',
          scope: 'task',
          taskId: task.id,
          observed: task.files.length,
          threshold: baseline.maxFileCount,
          message:
            `Task ${task.id} declares ${task.files.length} files ` +
            `(baseline ${baseline.maxFileCount}); this is far larger than a historical task.`,
        },
        overrides['historical-size'],
      );
    }
  }

  if (tasks.length >= baseline.uniformityMinTasks) {
    const stampedTiers = tasks
      .map((t) => t.riskTier)
      .filter((t): t is RiskTier => t !== undefined);
    if (
      stampedTiers.length === tasks.length &&
      new Set(stampedTiers).size === 1 &&
      stampedTiers[0] === 'low'
    ) {
      record(
        {
          signal: 'risk-uniformity',
          scope: 'plan',
          observed: tasks.length,
          threshold: baseline.uniformityMinTasks,
          message:
            `All ${tasks.length} tasks are stamped riskTier 'low'; a blanket ` +
            `low-risk stamp across a large task set is implausible — re-triage the high-blast tasks.`,
        },
        planOverrides['risk-uniformity'],
      );
    }

    const boundaries = tasks.map((t) => t.boundaryTouching);
    if (boundaries.every((b) => b === false)) {
      record(
        {
          signal: 'boundary-uniformity',
          scope: 'plan',
          observed: tasks.length,
          threshold: baseline.uniformityMinTasks,
          message:
            `All ${tasks.length} tasks declare boundaryTouching=false; a blanket ` +
            `"no task touches a boundary" claim across a large task set is implausible.`,
        },
        planOverrides['boundary-uniformity'],
      );
    }
  }

  return {
    challenged: active.length > 0,
    challenges: active,
    overridden,
  };
}
