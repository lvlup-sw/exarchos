// ─── Diff-Hygiene Gate ───────────────────────────────────────────────────────
//
// One quality gate over one branch diff, driven by a RULE PACK.
//
// It replaces three actions that were the same action three times: identical
// argument shape, identical base-branch resolution, identical `getDiff` call,
// identical fire-and-forget append at layer 'quality', and a body that differed
// only in which pure checker read the diff and how that checker's result was
// rendered. Three copies of one control flow is three places for the next
// correction to be applied twice and missed once — which is how they came to
// carry three near-identical inconclusive paths.
//
// THE PACK IS DATA. A rule is `{ id, dimension, scan }`: a durable gate name, the
// convergence dimension its verdict folds into, and a pure `(diff) => verdict`.
// Adding one is appending a record to `DIFF_HYGIENE_RULES`; nothing below reads a
// rule id, so no branch has to learn about it. `scanDiffHygiene` takes the pack
// as a parameter precisely so a test can hand it a rule this module has never
// seen and watch it come out the other end scored and recorded.
//
// EACH RULE KEEPS ITS OWN DURABLE ROW. The gate name on the row is the rule id,
// so `.exarchos.yml`'s per-gate severity keys and the per-dimension convergence
// read continue to resolve exactly as they did — consolidating the ACTION does
// not consolidate the record. The three rules therefore append three rows per
// call, the same three a caller used to get from three invocations.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

import { EnvelopeSchema } from '../../contract/schemas/envelope.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { queryRuntimeMetrics } from '../../projections/telemetry/telemetry-queries.js';
import type { RuntimeMetrics } from '../../projections/telemetry/telemetry-queries.js';
import { BASE_BRANCH_UNRESOLVED, resolveDiffBase } from '../../vcs/resolve-base-branch.js';
import { checkContextEconomy } from '../pure/context-economy.js';
import { checkOperationalResilience } from '../pure/operational-resilience.js';
import { checkWorkflowDeterminism } from '../pure/workflow-determinism.js';
import { emitGateEvent, getDiff } from './gate-utils.js';

// ─── The rule contract ─────────────────────────────────────────────────────

/** What a rule concludes about the diff it was handed. */
export interface DiffHygieneVerdict {
  readonly passed: boolean;
  readonly findingCount: number;
  /** The rule's own rendered findings, verbatim on the aggregate report. */
  readonly report: string;
}

/**
 * One member of the pack.
 *
 * `id` is load-bearing twice over: it is the gate name on the durable row AND
 * the `.exarchos.yml` key an operator writes to change this rule's severity.
 * Renaming one is a contract change, not a refactor.
 */
export interface DiffHygieneRule {
  readonly id: string;
  /** The convergence dimension this rule's verdict folds into. */
  readonly dimension: string;
  readonly scan: (diff: string) => DiffHygieneVerdict;
}

/** A rule's verdict, tagged with the rule that produced it. */
export interface DiffHygieneRuleResult extends DiffHygieneVerdict {
  readonly id: string;
  readonly dimension: string;
}

/** The whole pack's verdict over one diff. */
export interface DiffHygieneScan {
  /** True when EVERY rule passed — one dissenting rule fails the gate. */
  readonly passed: boolean;
  /** The union of the rules' finding counts. */
  readonly findingCount: number;
  readonly report: string;
  readonly rules: readonly DiffHygieneRuleResult[];
}

// ─── The rules ─────────────────────────────────────────────────────────────
//
// Each adapter renders its checker's result into the report that checker's gate
// produced before the consolidation, character for character. The rendering is
// part of the behaviour a consumer reads, so it moved rather than being
// re-invented in a house style.

/** Complexity that costs an LLM reader context: file length, breadth, generated bulk. */
function scanContextEconomy(diff: string): DiffHygieneVerdict {
  const result = checkContextEconomy(diff);
  const findingCount = result.findings.length;

  const lines: string[] = [];
  if (findingCount > 0) {
    for (const finding of result.findings) {
      lines.push(`- **${finding.severity}**: ${finding.message}`);
    }
    lines.push('');
    lines.push(`Result: FINDINGS (${findingCount} findings detected)`);
  } else {
    lines.push(`Result: PASS (${result.checksPassed}/${result.checksRun} checks passed)`);
  }

  return { passed: result.pass, findingCount, report: lines.join('\n') };
}

/** Error-handling anti-patterns: empty catches, swallowed errors, stray logging, unbounded retries. */
function scanOperationalResilience(diff: string): DiffHygieneVerdict {
  const result = checkOperationalResilience(diff);
  const findingCount = result.findingCount;

  const lines: string[] = [];
  if (findingCount > 0) {
    for (const finding of result.findings) {
      lines.push(`- **${finding.severity}**: ${finding.message}`);
    }
    lines.push('');
    lines.push(`Result: FINDINGS (${findingCount} findings detected)`);
  } else {
    lines.push('Result: PASS (all operational resilience checks passed)');
  }

  return { passed: result.pass, findingCount, report: lines.join('\n') };
}

/** Test hygiene: focus/skip modifiers, unmocked clocks and randomness, debug artifacts. */
function scanWorkflowDeterminism(diff: string): DiffHygieneVerdict {
  const result = checkWorkflowDeterminism({ diffContent: diff });
  return {
    passed: result.status === 'pass',
    findingCount: result.findingCount,
    report: result.report,
  };
}

/**
 * The pack. Order is the report's order and the append order; nothing else
 * depends on it.
 */
export const DIFF_HYGIENE_RULES: readonly DiffHygieneRule[] = Object.freeze([
  { id: 'context-economy', dimension: 'D3', scan: scanContextEconomy },
  { id: 'operational-resilience', dimension: 'D4', scan: scanOperationalResilience },
  { id: 'workflow-determinism', dimension: 'D5', scan: scanWorkflowDeterminism },
]);

// ─── Scoring ───────────────────────────────────────────────────────────────

/**
 * Run a pack over a diff.
 *
 * Pure, and pack-parameterised so the "a rule is addable without touching
 * control flow" claim is testable rather than asserted: a caller can pass a pack
 * this module does not ship and the aggregate must account for it.
 */
export function scanDiffHygiene(
  diff: string,
  rules: readonly DiffHygieneRule[] = DIFF_HYGIENE_RULES,
): DiffHygieneScan {
  const results: DiffHygieneRuleResult[] = rules.map((rule) => ({
    id: rule.id,
    dimension: rule.dimension,
    ...rule.scan(diff),
  }));

  return {
    passed: results.every((result) => result.passed),
    findingCount: results.reduce((total, result) => total + result.findingCount, 0),
    report: results.map((result) => `### ${result.id}\n\n${result.report}`).join('\n\n'),
    rules: results,
  };
}

// ─── Response contract ─────────────────────────────────────────────────────

const DiffHygieneRuleResultSchema = z
  .object({
    id: z.string().min(1),
    dimension: z.string().min(1),
    passed: z.boolean(),
    findingCount: z.number().int().nonnegative(),
    report: z.string(),
  })
  .passthrough();

/**
 * The success payload.
 *
 * `rules` is empty on the inconclusive carrier — nothing was scored — and the
 * skip markers ride alongside it through the passthrough, which is also how the
 * telemetry snapshot travels.
 */
export const DiffHygieneData = z
  .object({
    passed: z.boolean(),
    findingCount: z.number().int().nonnegative(),
    report: z.string(),
    rules: z.array(DiffHygieneRuleResultSchema),
  })
  .passthrough();

export const DiffHygieneOutputSchema = EnvelopeSchema(DiffHygieneData);

// ─── Handler ───────────────────────────────────────────────────────────────

interface DiffHygieneArgs {
  readonly featureId: string;
  readonly repoRoot?: string;
  readonly baseBranch?: string;
}

interface DiffHygieneResult extends DiffHygieneScan {
  readonly runtimeMetrics?: RuntimeMetrics;
  /** Present only on the inconclusive carrier below. */
  readonly skipped?: true;
  readonly discriminant?: string;
  readonly reason?: string;
}

const GATE_LAYER = 'quality';
const GATE_PHASE = 'review';

/**
 * The single append site. Both the scored path and the unscoped path reach the
 * durable log through here, so the two can never drift into disagreeing about
 * what a row for this gate looks like.
 *
 * Fire-and-forget, matching what the three gates did before the fold: a store
 * that will not take the row must not turn an advisory verdict into an error.
 */
async function emitRuleRow(
  store: EventStore,
  featureId: string,
  rule: { readonly id: string; readonly dimension: string },
  passed: boolean,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await emitGateEvent(store, featureId, rule.id, GATE_LAYER, passed ? 'pass' : 'fail', {
      dimension: rule.dimension,
      phase: GATE_PHASE,
      ...details,
    });
  } catch { /* fire-and-forget */ }
}

export async function handleDiffHygiene(
  args: DiffHygieneArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const repoRoot = args.repoRoot || process.cwd();

  // A diff needs two ends. Without a detected default branch this gate has one,
  // and the honest report is that it could not scope its subject — an advisory
  // carrier that normalizes to indeterminate, never a diff against a branch the
  // repository may not have and never a silent pass.
  const base = await resolveDiffBase(repoRoot, args.baseBranch);
  if (base.kind === 'unresolved') {
    // Indeterminate is a VERDICT, so it is recorded like one. This action
    // declares `gate.executed` unconditionally; returning success without it
    // would leave the declaration and the handler saying different things, and
    // it would leave the durable log unable to tell "could not be scoped" from
    // "never invoked". Every rule gets its row — an operator reading one
    // dimension must not find silence where the others found an explanation.
    // The rows are fail-closed and carry the skip markers, so no reader mistakes
    // one for a gate that ran.
    for (const rule of DIFF_HYGIENE_RULES) {
      await emitRuleRow(eventStore, args.featureId, rule, false, {
        findingCount: 0,
        skipped: true,
        discriminant: BASE_BRANCH_UNRESOLVED,
        reason: base.reason,
      });
    }

    const inconclusive: DiffHygieneResult = {
      passed: false,
      findingCount: 0,
      report: base.reason,
      rules: [],
      skipped: true,
      discriminant: BASE_BRANCH_UNRESOLVED,
      reason: base.reason,
    };
    return { success: true, data: inconclusive };
  }

  // Fail-closed if git is unavailable: an unreadable diff is not an empty one.
  const diff = getDiff(repoRoot, base.branch);
  if (diff === null) {
    return {
      success: false,
      error: { code: 'DIFF_ERROR', message: `Failed to get diff from git in ${repoRoot}` },
    };
  }

  const scan = scanDiffHygiene(diff);
  for (const rule of scan.rules) {
    await emitRuleRow(eventStore, args.featureId, rule, rule.passed, {
      findingCount: rule.findingCount,
    });
  }

  // Graceful degradation on failure: the telemetry snapshot annotates the
  // verdict, it does not decide it.
  const runtimeMetrics = await queryRuntimeMetrics(eventStore, stateDir);

  const result: DiffHygieneResult = { ...scan, runtimeMetrics };
  return { success: true, data: result };
}
