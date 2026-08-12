/**
 * Description token-budget audit (issue #1321, research R-E).
 *
 * MCP tool/action descriptions are a *token budget*: they cost every agent
 * on every `tools/list` call, before any work happens. The Trevin
 * agent-native-CLI evaluation (`docs/research/2026-05-08-trevin-agent-native-cli-evaluation.md`,
 * §R-E) treats this as a first-class budget — Cloudflare's Code Mode serves
 * 3,000+ operations in <1,000 tokens via aggressive collapsing, and "most MCP
 * servers burn 1,000 tokens on a single tool's description". Exarchos already
 * collapses to 4 visible composite tools (INV-5d) with per-action `describe`,
 * but nothing stops the composite-tool blurbs, slim registrations, or per-
 * action descriptions from drifting back to bloat. This module is the
 * mechanical guard: it audits each description against a documented per-kind
 * budget and reports the offenders, mirroring the `assertRuntimeTokenCoverage`
 * pre-flight pattern in the skills renderer (R-E step 2).
 *
 * Designed to be a thin library that the `npm run desc:budget-guard` CLI
 * wrapper (`description-budget-cli.ts`) and the co-located vitest both call —
 * single source of truth for the budgets and the estimate.
 */
import type { CompositeTool } from '../registry.js';

/**
 * How a composite tool's full description is rendered.
 *
 * The registry's own `buildToolDescription` is what this measures in practice,
 * but it arrives as a port rather than an import: this module is conformance
 * code and must not reach into the tree it inspects. The composition root binds
 * the real builder.
 */
export type ToolDescriptionBuilder = (
  tool: CompositeTool,
  slim: boolean,
) => string;

/**
 * What a single audited description is. Each composite tool contributes
 * several measured strings; each registered action contributes one.
 *
 *   - `tool.base` — the standalone composite-tool blurb (`tool.description`),
 *     shown when an agent reads the tool without its action signatures.
 *   - `tool.slim` — the one-line `slimDescription` used in slim MCP
 *     registration (this IS the `tools/list` line every agent pays for when
 *     slim registration is enabled).
 *   - `action` — a single action's `describe` string. R-E's named unit.
 *   - `tool.full` — the non-slim `tools/list` description produced by
 *     `buildToolDescription` (base + every action signature). This is
 *     *derived* (it concatenates all action descriptions), so it is measured
 *     and reported for visibility but is NOT budget-enforced — the meaningful,
 *     individually-fixable units are `tool.base` / `tool.slim` / `action`.
 */
export type DescriptionKind = 'tool.full' | 'tool.base' | 'tool.slim' | 'action';

export interface DescriptionEntry {
  /** Audit kind — selects the applicable budget (and whether it's enforced). */
  readonly kind: DescriptionKind;
  /** Stable identifier: tool name, or `${tool}.${action}` for an action. */
  readonly name: string;
  /** Raw character length of the description string. */
  readonly chars: number;
  /** Estimated token count (see {@link estimateTokens}). */
  readonly tokens: number;
  /** The applicable budget for this kind (undefined ⇒ measured-only). */
  readonly budget: number | undefined;
  /** True when `tokens > budget` for an *enforced* kind. */
  readonly overBudget: boolean;
}

export interface BudgetReport {
  /** Every measured description, sorted by token count descending. */
  readonly entries: readonly DescriptionEntry[];
  /** The subset of `entries` that exceeds an enforced budget. */
  readonly offenders: readonly DescriptionEntry[];
  /** True when there are no offenders (the guard passes). */
  readonly pass: boolean;
}

/**
 * Per-kind token budgets (issue #1321, research R-E).
 *
 * RATIONALE for the chosen ceilings — R-E names "~200 tokens per action" as
 * the eventual target, but the live surface already has three gate
 * descriptions over 200 (`mutation-adequacy` ≈265, `check_mock_boundary`
 * ≈252, `check_test_adequacy` ≈205 tokens — intentionally rich gate
 * semantics, NOT to be mass-rewritten in this task). Per the ratchet
 * convention used elsewhere in the repo (skills:guard, coverage thresholds),
 * the budget is set at a *defensible ceiling that is green today* so the guard
 * lands as a regression preventer, then ratchets down toward R-E's 200:
 *
 *   - `action`    → 280. Green today (worst is ~265); ~6% headroom over the
 *                   worst offender catches real new bloat while leaving the
 *                   three intentional gate descriptions in bounds. Ratchet
 *                   target: 200 (R-E).
 *   - `tool.slim` → 300. Green today (worst is `exarchos_orchestrate` ≈282);
 *                   this string is the literal slim `tools/list` line every
 *                   agent pays for, so it earns a tight-but-green ceiling.
 *   - `tool.base` → 60.  The base blurbs are tiny today (worst ≈29); a low
 *                   ceiling is cheap insurance against a one-liner ballooning.
 *
 * `tool.full` has no budget: it is the derived base+all-signatures string
 * (orchestrate's is ~4,500 tokens because it folds 108 action signatures),
 * which cannot be reduced without collapsing actions — out of scope for a
 * description guard. It is measured and surfaced for visibility only.
 */
export const DESCRIPTION_BUDGETS: Readonly<Record<DescriptionKind, number | undefined>> = Object.freeze({
  'action': 280,
  'tool.slim': 300,
  'tool.base': 60,
  'tool.full': undefined,
});

/** R-E's eventual target for a single action description, in tokens. The
 *  `action` budget ratchets down toward this as descriptions are trimmed. */
export const ACTION_BUDGET_RATCHET_TARGET = 200;

/**
 * Deterministic, dependency-free token estimate: ~4 characters per token.
 *
 * This is the standard rule-of-thumb for English/JSON text against the
 * Claude/GPT BPE tokenizers and is intentionally cheap — R-E calls for "a
 * simple, deterministic token estimate", and pulling a real tokenizer in
 * would add a heavy dependency for a CI guard that only needs to catch
 * order-of-magnitude drift. `Math.ceil` so a non-empty string never estimates
 * to 0 tokens.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Measure every description a single composite tool contributes. */
function measureTool(
  tool: CompositeTool,
  buildToolDescription: ToolDescriptionBuilder,
): DescriptionEntry[] {
  const out: DescriptionEntry[] = [];

  const push = (kind: DescriptionKind, name: string, text: string): void => {
    const tokens = estimateTokens(text);
    const budget = DESCRIPTION_BUDGETS[kind];
    out.push({
      kind,
      name,
      chars: text.length,
      tokens,
      budget,
      overBudget: budget !== undefined && tokens > budget,
    });
  };

  push('tool.full', tool.name, buildToolDescription(tool, false));
  push('tool.base', tool.name, tool.description);
  if (tool.slimDescription !== undefined) {
    push('tool.slim', tool.name, tool.slimDescription);
  }
  for (const action of tool.actions) {
    push('action', `${tool.name}.${action.name}`, action.description);
  }

  return out;
}

/**
 * Audit a set of composite tools against {@link DESCRIPTION_BUDGETS}.
 *
 * The `tools` parameter is the seam the co-located test uses to plant an
 * over-budget description without mutating the real registry; the composition
 * root supplies the live registry and its description builder.
 */
export function auditDescriptionBudgets(
  tools: readonly CompositeTool[],
  buildToolDescription: ToolDescriptionBuilder,
): BudgetReport {
  const entries = tools
    .flatMap((tool) => measureTool(tool, buildToolDescription))
    .sort((a, b) => b.tokens - a.tokens);
  const offenders = entries.filter((e) => e.overBudget);
  return { entries, offenders, pass: offenders.length === 0 };
}

/**
 * Render a human/agent-readable report of the worst offenders. Always shows
 * the top `topN` measured descriptions (so the report is useful even when
 * green), then — if any — the offenders with their budget overage.
 */
export function formatBudgetReport(report: BudgetReport, topN = 15): string {
  const lines: string[] = [];
  const fmtRow = (e: DescriptionEntry): string => {
    const budget = e.budget === undefined ? '   —' : String(e.budget).padStart(4);
    const flag = e.overBudget ? '  ⛔ OVER' : '';
    return `  ${String(e.tokens).padStart(5)} tok  (budget ${budget})  ${e.kind.padEnd(10)}  ${e.name}${flag}`;
  };

  lines.push(`description-budget: top ${Math.min(topN, report.entries.length)} by estimated tokens (chars/4):`);
  for (const e of report.entries.slice(0, topN)) {
    lines.push(fmtRow(e));
  }

  if (report.offenders.length > 0) {
    lines.push('');
    lines.push(`description-budget: ${report.offenders.length} description(s) OVER budget (#1321, R-E):`);
    for (const e of report.offenders) {
      lines.push(fmtRow(e));
    }
    lines.push('');
    lines.push(
      'Trim the offending description(s) or, if the budget itself needs to move, ' +
        'adjust DESCRIPTION_BUDGETS in description-budget.ts with rationale. ' +
        `Per-action ratchet target is ${ACTION_BUDGET_RATCHET_TARGET} tokens (R-E).`,
    );
  } else {
    lines.push('');
    lines.push('description-budget: all enforced descriptions within budget (clean).');
  }

  return lines.join('\n');
}
