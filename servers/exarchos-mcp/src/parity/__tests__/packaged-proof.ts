// ─── Packaged action + CLI proof: coverage engine + ratchet (P05-02) ─────────
//
// PROGRAM-05, ART-004 / ART-005 / ART-014. This is the PURE half of the
// "packaged action and CLI proof": it derives the coverage DENOMINATORS from
// the LIVE registries (never a hand-maintained list), computes covered/total
// per dimension against an exercise ledger, and applies a non-regression
// ratchet against a checked-in baseline.
//
// The exercise ledger is produced by the COMPILED-PROCESS half — the process
// test spawns the shipped binary (`scripts/build-binary.ts` output) and drives
// real CLI invocations, recording which denominator items the binary genuinely
// exercised. Keeping this module pure (no spawning, no I/O) makes the
// denominator derivation + coverage math + ratchet logic unit-testable in
// isolation, and lets the SAME logic gate both the fast unit test and the
// compiled-process test.
//
// ── Why the denominators are LIVE, not a static list ─────────────────────────
// The whole point of ART-004/005 is that coverage is measured against the live
// registry: an action that is REGISTERED but never exercised through the
// compiled process must drop coverage below 100% and trip the ratchet. So every
// denominator here is derived at call time from an authoritative source:
//   • actions              — the compiled contract's action set
//                            (`deriveMetaModel().actions`, the compiler's
//                            registry-derived front-end; cross-checked against
//                            `compile().proofFixtures` by the unit test).
//   • presentation aliases — actions whose `presentation.cliAlias` is set.
//   • host commands        — the composite-tool CLI names + top-level promotions.
//   • error families       — `FAILURE_LAYERS` (P03-02), each mapping to a stable
//                            CLI exit code via `exitCodeForError`.
//   • effect families      — the distinct effect classes in `EFFECT_OWNERSHIP`
//                            (P04-01: filesystem / process / network).
//   • cancellation paths   — actions whose `cancellation.cancellable` is set.
//
// This module lives under `__tests__/` because it is test/gate infrastructure,
// never a production import target (refgraph classifies `__tests__/**` as test
// scope — see `scripts/check-module-intent.mjs`).
// ────────────────────────────────────────────────────────────────────────────

import {
  TOOL_REGISTRY,
  type CompositeTool,
} from '../../registry.js';
import { deriveMetaModel } from '../../contract/compiler/meta-model.js';
import {
  FAILURE_LAYERS,
  STABLE_ERROR_REGISTRY,
  exitCodeForError,
  type FailureLayer,
  type ContractExitCode,
} from '../../contract/error-families.js';
import { EFFECT_OWNERSHIP } from '../../architecture/effect-ledger.js';

// ─── Dimensions ──────────────────────────────────────────────────────────────

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

// ─── Denominator derivation (live) ───────────────────────────────────────────

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
 * Derive every dimension's DENOMINATOR from the live registries. Passing a
 * synthetic registry (a seeded/extra action) grows the denominator — that is
 * the exit-proof that coverage is measured against the live surface, not a
 * frozen list.
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

// ─── Error-family / exit-code helpers (through the compiled process) ─────────

/**
 * Classify an observed error code onto its failure LAYER. A code in the stable
 * registry uses its declared layer; an unregistered code is attributed to the
 * `handler` layer — exactly mirroring `exitCodeForError`'s conservative
 * HANDLER_ERROR fallback, so the family attribution and the exit code agree.
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

// ─── Coverage computation ────────────────────────────────────────────────────

export interface DimensionCoverage {
  readonly dimension: CoverageDimension;
  readonly total: number;
  readonly covered: number;
  /** covered / total, in [0,1]; `1` when the denominator is empty. */
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

// ─── The non-regression ratchet ──────────────────────────────────────────────

export interface DimensionBaseline {
  readonly total: number;
  readonly covered: number;
  readonly missing: readonly string[];
}

export interface CoverageBaseline {
  /** Free-form provenance note (e.g. how the baseline was captured). */
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
 * Compare a fresh coverage report against the checked-in baseline. A regression
 * is either:
 *
 *   • `new-gap`       — a denominator item is UNCOVERED now that was not an
 *                       accepted gap in the baseline. This is the load-bearing
 *                       guarantee: adding a registered action (or presentation
 *                       alias, host command, …) without exercising it through
 *                       the compiled process surfaces it as a NEW missing item
 *                       and FAILS the ratchet. It also catches de-exercising a
 *                       previously-covered item.
 *   • `coverage-drop` — the covered COUNT fell by more than the denominator
 *                       shrank, i.e. a covered item stopped being covered for a
 *                       reason the missing-set diff did not already name.
 *
 * Removing a registered item (the denominator shrinks) is NOT a regression:
 * accepted-gap items that vanish simply drop out, and the coverage-drop guard
 * is slack-adjusted by the shrink amount.
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

    // Slack the covered floor by however much the denominator legitimately
    // shrank, so deleting a covered item is not miscounted as a regression.
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

// ─── Baseline parsing (fail-closed) ──────────────────────────────────────────

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
