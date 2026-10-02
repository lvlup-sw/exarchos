// Packaged action and CLI proof: the pure coverage engine and its ratchet.
//
// This module derives the coverage denominators from the live registries. It counts the covered
// items of each dimension against an exercise ledger, and compares the result with a checked-in
// baseline. The process test spawns the shipped binary and drives real CLI calls to produce the
// ledger. This module does no spawning and no I/O, so the unit test and the process test share it.
//
// Each denominator comes from an authoritative source at call time. Thus an action that is
// registered but never exercised through the compiled process drops coverage and fails the ratchet.
//
// It lives under `__tests__/` because it is test infrastructure, not a production import target.
// `tools/audit/gates/check-module-intent.mjs` treats `__tests__/` as test scope.

import {
  TOOL_REGISTRY,
  type CompositeTool,
} from '../../../../../src/registry.js';
import { deriveMetaModel } from '../../../../../src/contract/compiler/meta-model.js';
import {
  FAILURE_LAYERS,
  STABLE_ERROR_REGISTRY,
  exitCodeForError,
  type FailureLayer,
  type ContractExitCode,
} from '../../../../../src/contract/error-families.js';
import { EFFECT_OWNERSHIP } from '../../../../../src/architecture/effect-ledger.js';

/** The six coverage dimensions the packaged proof measures. */
export const COVERAGE_DIMENSIONS = [
  'actions',
  'presentationAliases',
  'hostCommands',
  'errorFamilies',
  'effectFamilies',
  'cancellationPaths',
] as const;

export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

/** A per-dimension set of item identifiers (denominator OR exercised subset). */
export type DimensionSets = Readonly<Record<CoverageDimension, readonly string[]>>;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(byString);

/** Composite-tool → its CLI command name (`exarchos_workflow` → `wf`). */
export function toolCliName(tool: CompositeTool): string {
  return tool.cli?.alias ?? tool.name.replace(/^exarchos_/, '');
}

/**
 * One action's CLI coordinates, derived from the live registry. `actionCliName`
 * is the exact subcommand the compiled binary registers (`cli.alias ?? name`),
 * so the driver can invoke `<toolCliName> <actionCliName>` without guessing.
 */
export interface PackagedActionPlan {
  readonly actionId: string;
  readonly toolName: string;
  readonly toolCliName: string;
  readonly actionCliName: string;
  /** The presentation alias, when the action declares one (else `null`). */
  readonly alias: string | null;
  /** The top-level promotion name, when the action declares one (else `null`). */
  readonly topLevel: string | null;
  readonly cancellable: boolean;
}

/**
 * Derive the per-action CLI plan from the live registry. This is the single
 * source both the denominators and the compiled-process driver read from, so
 * the two can never drift.
 */
export function derivePackagedCliPlan(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): readonly PackagedActionPlan[] {
  const toolCliByName = new Map<string, string>();
  for (const tool of registry) toolCliByName.set(tool.name, toolCliName(tool));

  const meta = deriveMetaModel(registry);
  const plan = meta.actions.map((a): PackagedActionPlan => {
    const cliName = toolCliByName.get(a.tool) ?? a.tool.replace(/^exarchos_/, '');
    return {
      actionId: a.actionId,
      toolName: a.tool,
      toolCliName: cliName,
      actionCliName: a.policy.presentation.cliAlias ?? a.action,
      alias: a.policy.presentation.cliAlias,
      topLevel: a.policy.presentation.topLevel,
      cancellable: a.policy.cancellation.cancellable,
    };
  });
  return [...plan].sort((x, y) => byString(x.actionId, y.actionId));
}

/** A stable identifier for a presentation alias (`<actionId>::<alias>`). */
export function aliasId(actionId: string, alias: string): string {
  return `${actionId}::${alias}`;
}

/** The distinct effect classes declared in the effect-ownership ledger. */
export function deriveEffectFamilies(): string[] {
  return sortedUnique(EFFECT_OWNERSHIP.map((r) => r.effectClass));
}

/**
 * Derives the denominator of every dimension from the live registries. The sources are the
 * compiled action set, the CLI aliases, the host commands, `FAILURE_LAYERS`, the effect classes of
 * `EFFECT_OWNERSHIP`, and the cancellable actions. A synthetic registry with an extra action
 * grows the denominator. This proves that coverage follows the live surface, not a frozen list.
 */
export function derivePackagedDenominators(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): DimensionSets {
  const plan = derivePackagedCliPlan(registry);

  const actions = sortedUnique(plan.map((p) => p.actionId));

  const presentationAliases = sortedUnique(
    plan.filter((p) => p.alias !== null).map((p) => aliasId(p.actionId, p.alias as string)),
  );

  const hostCommands = sortedUnique([
    ...registry.map((t) => toolCliName(t)),
    ...plan.filter((p) => p.topLevel !== null).map((p) => p.topLevel as string),
  ]);

  const errorFamilies = sortedUnique([...FAILURE_LAYERS]);

  const effectFamilies = deriveEffectFamilies();

  const cancellationPaths = sortedUnique(
    plan.filter((p) => p.cancellable).map((p) => p.actionId),
  );

  return {
    actions,
    presentationAliases,
    hostCommands,
    errorFamilies,
    effectFamilies,
    cancellationPaths,
  };
}

/**
 * Maps an observed error code to its failure layer. A code in the stable registry uses its
 * declared layer. An unregistered code maps to `handler`, the same fallback that
 * `exitCodeForError` uses, so the family and the exit code agree.
 */
export function classifyErrorLayer(code: string): FailureLayer {
  if (code in STABLE_ERROR_REGISTRY) {
    return STABLE_ERROR_REGISTRY[code as keyof typeof STABLE_ERROR_REGISTRY].layer;
  }
  return 'handler';
}

/** The stable CLI exit code a compiled process MUST emit for an error code. */
export function expectedExitForCode(code: string | undefined): ContractExitCode {
  return exitCodeForError(code);
}

export interface DimensionCoverage {
  readonly dimension: CoverageDimension;
  readonly total: number;
  readonly covered: number;
  /** covered / total, in [0,1]. The value is `1` when the denominator is empty. */
  readonly ratio: number;
  /** Denominator items with no exercise evidence, sorted. */
  readonly missing: readonly string[];
}

export interface CoverageReport {
  readonly dimensions: readonly DimensionCoverage[];
}

/**
 * Intersect the exercise ledger with the live denominators to compute per-
 * dimension coverage. Ledger items that are NOT in the denominator are ignored
 * (an exercised item can only count toward a registered denominator), so a
 * stale ledger entry can never inflate coverage past 100%.
 */
export function computeCoverage(
  denominators: DimensionSets,
  exercised: DimensionSets,
): CoverageReport {
  const dimensions = COVERAGE_DIMENSIONS.map((dimension): DimensionCoverage => {
    const denom = denominators[dimension];
    const exercisedSet = new Set(exercised[dimension]);
    const missing = denom.filter((item) => !exercisedSet.has(item)).sort(byString);
    const covered = denom.length - missing.length;
    const total = denom.length;
    return {
      dimension,
      total,
      covered,
      ratio: total === 0 ? 1 : covered / total,
      missing,
    };
  });
  return { dimensions };
}

/** Look up one dimension's coverage in a report. */
export function coverageFor(
  report: CoverageReport,
  dimension: CoverageDimension,
): DimensionCoverage {
  const found = report.dimensions.find((d) => d.dimension === dimension);
  if (found === undefined) {
    throw new Error(`coverage report is missing dimension '${dimension}'`);
  }
  return found;
}

export interface DimensionBaseline {
  readonly total: number;
  readonly covered: number;
  readonly missing: readonly string[];
}

export interface CoverageBaseline {
  /** Free-form provenance note, such as how the team captured the baseline. */
  readonly note?: string;
  readonly dimensions: Readonly<Record<CoverageDimension, DimensionBaseline>>;
}

export type RegressionKind = 'new-gap' | 'coverage-drop';

export interface RatchetRegression {
  readonly dimension: CoverageDimension;
  readonly kind: RegressionKind;
  readonly detail: string;
}

export interface RatchetResult {
  readonly ok: boolean;
  readonly regressions: readonly RatchetRegression[];
}

/**
 * Compares a fresh coverage report with the checked-in baseline. It reports two kinds of
 * regression:
 *
 * - `new-gap`: a denominator item is uncovered and is not an accepted gap in the baseline. Thus a
 *   new registered item that the compiled process does not exercise fails the ratchet.
 * - `coverage-drop`: the covered count fell by more than the denominator shrank.
 *
 * Removal of a registered item is not a regression. The covered floor drops by the amount that
 * the denominator shrank, so the deletion of a covered item does not count.
 */
export function checkRatchet(
  report: CoverageReport,
  baseline: CoverageBaseline,
): RatchetResult {
  const regressions: RatchetRegression[] = [];

  for (const current of report.dimensions) {
    const base = baseline.dimensions[current.dimension];
    const baselineMissing = new Set(base.missing);

    const newGaps = current.missing.filter((item) => !baselineMissing.has(item));
    if (newGaps.length > 0) {
      regressions.push({
        dimension: current.dimension,
        kind: 'new-gap',
        detail:
          `${newGaps.length} newly-uncovered ${current.dimension} item(s) not in the ` +
          `baseline accepted-gap set: ${newGaps.slice(0, 8).join(', ')}` +
          (newGaps.length > 8 ? ', …' : ''),
      });
    }

    const shrink = Math.max(0, base.total - current.total);
    if (current.covered < base.covered - shrink) {
      regressions.push({
        dimension: current.dimension,
        kind: 'coverage-drop',
        detail:
          `covered fell to ${current.covered} from baseline ${base.covered} ` +
          `(denominator ${current.total} vs baseline ${base.total})`,
      });
    }
  }

  return { ok: regressions.length === 0, regressions };
}

/** Project a coverage report into the baseline shape (for regeneration). */
export function reportToBaseline(report: CoverageReport, note?: string): CoverageBaseline {
  const dimensions = {} as Record<CoverageDimension, DimensionBaseline>;
  for (const d of report.dimensions) {
    dimensions[d.dimension] = { total: d.total, covered: d.covered, missing: [...d.missing] };
  }
  return note === undefined ? { dimensions } : { note, dimensions };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isDimensionBaseline(value: unknown): value is DimensionBaseline {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.total === 'number' &&
    typeof v.covered === 'number' &&
    isStringArray(v.missing)
  );
}

/**
 * Parse + validate untrusted JSON into a {@link CoverageBaseline}. Throws with a
 * named cause when a dimension is missing or malformed — the ratchet must never
 * pass on a partial/garbled baseline (fail-closed).
 */
export function parseCoverageBaseline(value: unknown): CoverageBaseline {
  if (value === null || typeof value !== 'object') {
    throw new Error('coverage baseline must be a JSON object');
  }
  const root = value as Record<string, unknown>;
  const dims = root.dimensions;
  if (dims === null || typeof dims !== 'object') {
    throw new Error("coverage baseline is missing a 'dimensions' object");
  }
  const dimsRecord = dims as Record<string, unknown>;
  const dimensions = {} as Record<CoverageDimension, DimensionBaseline>;
  for (const dimension of COVERAGE_DIMENSIONS) {
    const entry = dimsRecord[dimension];
    if (!isDimensionBaseline(entry)) {
      throw new Error(`coverage baseline dimension '${dimension}' is missing or malformed`);
    }
    dimensions[dimension] = {
      total: entry.total,
      covered: entry.covered,
      missing: [...entry.missing].sort(byString),
    };
  }
  const note = typeof root.note === 'string' ? root.note : undefined;
  return note === undefined ? { dimensions } : { note, dimensions };
}
