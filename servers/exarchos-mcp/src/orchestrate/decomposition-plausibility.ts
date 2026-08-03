// ─── Decomposition & Risk Plausibility Signals (P02-06) ─────────────────────
//
// `check_task_decomposition` (see `task-decomposition.ts`) validates task
// STRUCTURE (description / files / tests), the dependency DAG, and parallel
// safety. It historically accepted whatever risk tier and boundary stamps a
// planner declared — a plan where every one of 48 tasks is stamped
// `riskTier: low` / `boundaryTouching: false`, or a single "task" whose file
// set dwarfs every historical task, sailed through silently.
//
// This module adds calibrated PLAUSIBILITY signals on top of the structural
// gate. Each signal is a pure, independently-testable predicate:
//
//   • breadth            — how many distinct modules/directories a task spans
//   • behavior-count     — how many distinct behaviors a task claims
//   • historical-size    — declared file count vs a calibrated baseline
//   • risk-uniformity    — a blanket-low risk stamp across a large task set
//   • boundary-uniformity— a blanket "touches no boundary" claim across a set
//
// The output is a STRUCTURED CHALLENGE (typed findings the caller can act on),
// NOT a hard unconditional failure: the intent (exit criterion 9) is that an
// implausible decomposition triggers a challenge rather than silent
// acceptance. An author can suppress a specific challenge only by supplying a
// recorded, non-empty override rationale — a missing or empty rationale never
// suppresses. Suppressed challenges are retained in `overridden` (with their
// rationale) so the override is auditable rather than invisible.
// ────────────────────────────────────────────────────────────────────────────

import type { RiskTier } from '../workflow/verification-policy.js';

// ─── Types ───────────────────────────────────────────────────────────────

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
 * Calibrated thresholds for the plausibility signals. Injectable so callers
 * can supply repo-specific numbers; `DEFAULT_PLAUSIBILITY_BASELINE` is the
 * sane default used when none is supplied. Deterministic by construction — no
 * git-history shell-out at check time (see `deriveBaseline`).
 */
export interface PlausibilityBaseline {
  /** Max distinct modules/directories a single task should span. */
  readonly maxBreadth: number;
  /** Max distinct behaviors a single task should claim. */
  readonly maxBehaviorCount: number;
  /** Max declared file count for a single task (historical-size outlier bound). */
  readonly maxFileCount: number;
  /**
   * Minimum task-set size at which uniform risk/boundary stamps become
   * implausible enough to challenge. Below this, uniformity is unremarkable
   * (a 3-task plan legitimately can be all-low).
   */
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

// ─── Pure Signal Primitives ──────────────────────────────────────────────

/**
 * Directory ("module") a file path belongs to — everything up to the last
 * path separator. `src/a/x.ts` → `src/a`; a bare `x.ts` → `.`. Both `/` and
 * `\` are treated as separators so Windows-authored paths collapse identically.
 */
function directoryOf(path: string): string {
  // Normalise `\` → `/` first so a Windows-authored `src\a\x.ts` and a
  // POSIX `src/a/y.ts` collapse to the same directory string.
  const normalised = path.replace(/\\/g, '/');
  const idx = normalised.lastIndexOf('/');
  return idx === -1 ? '.' : normalised.slice(0, idx);
}

/**
 * Breadth: the number of DISTINCT directories a task's files span. Two files
 * in the same directory count once; a task scattered across many directories
 * is broad (and, past the baseline, implausibly so).
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
 * A `Method_Scenario_Outcome` test identifier — the codebase's canonical
 * behavior token (PascalCase segments joined by underscores). Each DISTINCT
 * identifier is one claimed behavior.
 */
const BEHAVIOR_TOKEN = /[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+/g;

/**
 * Behavior count: the number of DISTINCT behavior tokens a task block claims.
 * Distinct (deduplicated) because the same behavior name typically appears
 * twice — once in a `[RED]` step and again in a verification checklist — and
 * that repetition is not two behaviors.
 */
export function countBehaviors(block: string): number {
  const seen = new Set<string>();
  const matches = block.match(BEHAVIOR_TOKEN);
  if (matches) {
    for (const m of matches) seen.add(m);
  }
  return seen.size;
}

// Stamp regexes mirror the sibling DISPATCH parser (`parse-task-stamps.ts`)
// and the structural gate (`task-decomposition.ts`) so all three read the same
// `**Risk Tier:** <tier>` / `**Boundary Touching:** <bool>` spellings. `(?![\w-])`
// (not `\b`) makes a malformed suffix (`low-priority`) fall through rather than
// silently misclassify.
const BOUNDARY_STAMP = /boundary\s*touching\*{0,2}\s*:\s*\*{0,2}\s*(true|false)(?![\w-])/i;

/**
 * Extract a task block's `**Boundary Touching:**` stamp, if present. Returns
 * `undefined` when the block carries no (well-formed) stamp — distinct from an
 * explicit `false`, so the uniformity signal can require ALL tasks to be
 * stamped before it fires.
 */
export function extractBoundaryTouching(block: string): boolean | undefined {
  const match = BOUNDARY_STAMP.exec(block);
  if (!match || match[1] === undefined) return undefined;
  return match[1].toLowerCase() === 'true';
}

// Override line: `**Plausibility Override:** <signal>: <rationale>`. The signal
// must be one of the known signals; the rationale is the remainder and must be
// non-empty (a bare `signal:` with nothing after does NOT match, so an empty
// rationale can never suppress).
const OVERRIDE_LINE =
  /^\s*\*{0,2}\s*plausibility\s+override\s*\*{0,2}\s*:\s*\*{0,2}\s*([a-z-]+)\s*[:\-–—]\s*(\S.*?)\s*$/i;

function isPlausibilitySignal(value: string): value is PlausibilitySignal {
  return (ALL_SIGNALS as readonly string[]).includes(value);
}

/**
 * Parse `**Plausibility Override:** <signal>: <rationale>` lines out of a
 * markdown span into a signal→rationale map. Unknown signal names and
 * empty rationales are ignored. Later lines win over earlier ones for the
 * same signal.
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

// ─── Baseline Derivation ─────────────────────────────────────────────────

/** A deterministic sample of historical per-task sizes to calibrate against. */
export interface HistoricalSizeSample {
  readonly fileCounts: readonly number[];
  readonly behaviorCounts: readonly number[];
}

/**
 * Nearest-rank percentile of a numeric sample. Deterministic; `p` in [0,1].
 * Returns 0 for an empty sample.
 */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? 0;
}

/**
 * Derive a calibrated baseline DETERMINISTICALLY from a historical size
 * sample. An outlier bound is set at the sample's 90th-percentile size scaled
 * by `slack` (default 2), floored at the `DEFAULT_PLAUSIBILITY_BASELINE`
 * constants so a sample of uniformly tiny tasks cannot produce an
 * implausibly-strict threshold. `overrides` win over the derived values.
 *
 * This is the injectable, deterministic alternative to shelling out to git
 * history at check time: a caller computes the sample once (however it likes)
 * and threads the result in.
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

// ─── Assessment ──────────────────────────────────────────────────────────

/**
 * Assess a decomposition for plausibility. Pure and deterministic: operates on
 * already-extracted structured inputs (see `extractPlausibilityInputs` in
 * `task-decomposition.ts` for the markdown bridge). Returns typed challenges;
 * never throws and never hard-fails.
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

  // ── Per-task signals ──
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

  // ── Plan-level uniformity signals ──
  // Only meaningful once the set is large enough that some variance is expected.
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
