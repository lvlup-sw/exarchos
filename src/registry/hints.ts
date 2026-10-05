/**
 * The hint blocks that an action descriptor can declare: CLI presentation (`cli`), dispatch
 * behavior (`dispatch`) and the response cost (`economy`). No hint changes what the action does.
 */
import type { ToolAction } from './types.js';

export interface CliActionHints {
  readonly alias?: string;
  readonly group?: string;
  readonly examples?: readonly string[];
  readonly flags?: Readonly<Record<string, {
    readonly alias?: string;
    readonly description?: string;
  }>>;
  readonly format?: 'table' | 'json' | 'tree';
  /**
   * A top-level CLI command name for this action, in addition to `<tool> <action>`.
   * For `'ps'`, the CLI registers `exarchos ps` next to `exarchos view ps`, with the same flags and
   * dispatch path. A name that collides with a top-level command fails in `buildCli`.
   */
  readonly topLevel?: string;
}

export interface CliToolHints {
  readonly alias?: string;
  readonly group?: string;
}

/**
 * Dispatch metadata at the action-descriptor level, not under `cli`. The CLI and MCP facades share
 * one dispatch path, so metadata that steers it belongs to neither facade.
 */
export interface DispatchHints {
  /**
   * An advisory marker for a long-running action that gains from Tasks-augmented dispatch.
   * `describe` shows it. The binding opt-in gate is in `dispatch()`, and clients can ignore this marker.
   */
  readonly taskSuitable?: boolean;
  /** The suggested TTL in ms for Tasks-augmented dispatch, as a default for clients that opt in. */
  readonly taskTtlSuggestionMs?: number;
}

/**
 * Response-economy metadata at the action-descriptor level, so the CLI and MCP facades share one
 * ceiling. The dispatch-core seam enforces it through {@link resolveEconomyBudget}.
 * - `budgetTokens`: the response ceiling in estimated output tokens.
 * - `compactByDefault`: an advisory marker for a compact default rendering.
 * - `summarize`: the reducer for an over-budget response. Without it, the seam uses a generic fallback.
 */
export interface EconomyHints {
  readonly budgetTokens?: number;
  readonly compactByDefault?: boolean;
  readonly summarize?: (data: unknown) => unknown;
}

/**
 * The registry-wide default response budget in estimated output tokens. A declared
 * `economy.budgetTokens` takes precedence. The value comes from a measured audit of response sizes.
 */
export const DEFAULT_ECONOMY_BUDGET_TOKENS = 2000;

/**
 * The budget for `describe` on workflow, orchestrate and view, which returns full per-action schemas.
 * The detail actions declare higher budgets, not exemptions. Each budget sits between typical use and
 * the measured worst case, so a normal call is not capped and an extreme dump is summarized.
 */
export const DESCRIBE_ECONOMY_BUDGET_TOKENS = 8000;

/**
 * The budget for event `describe`. It is above {@link DESCRIBE_ECONOMY_BUDGET_TOKENS}, because its
 * `emissionGuide` parameter adds the full event catalog to the action schemas.
 */
export const EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS = 12000;

/** The budget for `runbook`, which returns a resolved runbook with step schemas. */
export const RUNBOOK_ECONOMY_BUDGET_TOKENS = 4000;

/**
 * Resolves an action's response budget: the declared `economy.budgetTokens`, or else
 * {@link DEFAULT_ECONOMY_BUDGET_TOKENS}. The dispatch seam fails open on a budget that is not a
 * positive finite number. A broken budget must not stop an action from answering.
 */
export function resolveEconomyBudget(action: Pick<ToolAction, 'economy'>): number {
  const declared = action.economy?.budgetTokens;
  return declared !== undefined ? declared : DEFAULT_ECONOMY_BUDGET_TOKENS;
}
