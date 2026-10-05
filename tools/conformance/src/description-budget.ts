/**
 * Description token-budget audit. Each MCP tool and action description costs every agent on every
 * `tools/list` call. This guard audits each description against a per-kind budget and reports the
 * offenders. So the composite-tool blurbs, slim registrations and action descriptions cannot grow
 * back to bloat without a failure.
 *
 * The `npm run desc:budget-guard` wrapper (`description-budget-cli.ts`) and the vitest both call
 * this library, so the budgets and the estimate have one source.
 */
import type { CompositeTool } from '../../../src/registry.js';

/**
 * Renders the full description of a composite tool. The composition root binds the real
 * `buildToolDescription` of the registry. It arrives as a port, because conformance code must not
 * reach into the tree that it inspects.
 */
export type ToolDescriptionBuilder = (
  tool: CompositeTool,
  slim: boolean,
) => string;

/**
 * The kind of one audited description. Each composite tool gives several strings, and each action
 * gives one. `tool.base` is the standalone blurb (`tool.description`). `tool.slim` is the
 * `slimDescription` line of slim MCP registration. `action` is the description of one action.
 *
 * `tool.full` is the non-slim `tools/list` text from `buildToolDescription`: the base plus every
 * action signature. It is derived, so the audit measures it but enforces no budget on it.
 */
export type DescriptionKind = 'tool.full' | 'tool.base' | 'tool.slim' | 'action';

export interface DescriptionEntry {
  /** The audit kind. It selects the budget, and tells if the audit enforces that budget. */
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
 * Per-kind token budgets. Each ceiling passes on the live surface today, so the guard prevents
 * regressions, and the `action` budget goes down toward {@link ACTION_BUDGET_RATCHET_TARGET}.
 * `action` is 280, because some gate descriptions carry rich semantics above 200 tokens.
 * `tool.slim` is 300, because each agent pays for this `tools/list` line. `tool.base` is 60, a
 * low ceiling for a one-line blurb. `tool.full` has no budget: only fewer actions can reduce it.
 */
export const DESCRIPTION_BUDGETS: Readonly<Record<DescriptionKind, number | undefined>> = Object.freeze({
  'action': 280,
  'tool.slim': 300,
  'tool.base': 60,
  'tool.full': undefined,
});

/** The eventual target for one action description, in tokens. The `action` budget goes down toward it. */
export const ACTION_BUDGET_RATCHET_TARGET = 200;

/**
 * A deterministic token estimate with no dependency: about 4 characters per token. The guard only
 * catches order-of-magnitude drift, so it needs no real tokenizer. `Math.ceil` keeps the estimate
 * of a non-empty string above 0 tokens.
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
 * Audits a set of composite tools against {@link DESCRIPTION_BUDGETS}. A test passes `tools` to
 * plant an over-budget description with no change to the real registry. The composition root
 * supplies the live registry and its description builder.
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
