// ─── Presentation and behavior hints an action may declare ──────────────────
//
// These blocks hang off an action descriptor and describe how it should be
// surfaced (`cli`), how it should be dispatched (`dispatch`), and what it may
// cost to answer (`economy`). None of them changes what the action does.

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
   * Hoist this action to a TOP-LEVEL CLI command in addition to its
   * `<tool> <action>` subcommand form. When set to (say) `'ps'`, the CLI
   * adapter registers `exarchos ps` alongside `exarchos view ps`; both forms
   * dispatch through the same code path and derive their flags from the same
   * Zod schema, so there is no second parser to keep in step. A `topLevel`
   * name that collides with an existing top-level command fails at
   * registration (build time) rather than at runtime — see the hoist loop in
   * `adapters/cli.ts`.
   */
  readonly topLevel?: string;
}

export interface CliToolHints {
  readonly alias?: string;
  readonly group?: string;
}

/**
 * Action-descriptor-level dispatch metadata.
 *
 * Lives at the action-descriptor level (sibling to `cli`, `gate`,
 * `autoEmits`) — NOT under `cli.` — because the Tasks dispatch core is shared
 * between the CLI and MCP facades: both front-ends are clients of one
 * dispatch path, so metadata that steers it cannot sit under either one's
 * namespace. Annotating under `cli.` would imply this is CLI-presentation
 * metadata; it isn't. It is action-behavior metadata: "this action is
 * long-running and benefits from Tasks-augmented dispatch."
 *
 * The block is intentionally extensible — a future `streaming: true` marker,
 * for example, belongs here too. Hence the name `dispatch` (not `tasks`,
 * which would be too narrow).
 */
export interface DispatchHints {
  /**
   * Advisory marker: this action is long-running and benefits from
   * Tasks-augmented dispatch. Surfaced via `exarchos_view describe` so
   * clients can enumerate. The actual opt-in gate remains
   * `taskAugmented && ctx.taskStore && taskCapabilityGate` at
   * core/dispatch.ts:927-954. Clients are not required to honor this
   * marker; the gate is binding.
   */
  readonly taskSuitable?: boolean;
  /**
   * Suggested TTL for Tasks-augmented dispatch, in ms. Surfaced
   * alongside `taskSuitable` so clients have a sensible default to
   * thread when they opt in.
   */
  readonly taskTtlSuggestionMs?: number;
}

/**
 * Action-descriptor-level response-economy metadata.
 *
 * Lives at the action-descriptor level — sibling to `cli`, `gate`,
 * `autoEmits`, `dispatch` — for the same reason given on
 * {@link DispatchHints}: a response budget is shared by both facades, so it
 * cannot live under either one's namespace. A token budget is not
 * presentation, it is a property of what the action emits, so the CLI and MCP
 * surfaces inherit the same ceiling from one declaration.
 *
 * - `budgetTokens` — the per-action response ceiling in estimated output
 *   tokens. Resolves via {@link resolveEconomyBudget}: declared value wins
 *   over {@link DEFAULT_ECONOMY_BUDGET_TOKENS}, so every action resolves a
 *   concrete number.
 * - `compactByDefault` — advisory marker that this action's presentation
 *   should default to its compact rendering.
 * - `summarize` — optional per-action reducer applied on overflow (else a
 *   generic capped fallback). Declared here so schemas stay honest.
 *
 * Enforcement lives at the dispatch-core measurement seam; this block is the
 * declaration, that seam is the guard. They agree by construction because
 * both read {@link resolveEconomyBudget}.
 */
export interface EconomyHints {
  readonly budgetTokens?: number;
  readonly compactByDefault?: boolean;
  readonly summarize?: (data: unknown) => unknown;
}

/**
 * Registry-wide default response budget in estimated output tokens. An
 * action's declared `economy.budgetTokens` wins over this default; every
 * action therefore resolves to a concrete number via
 * {@link resolveEconomyBudget}. The initial value came from a measured audit
 * of tool response sizes; the qualityHints 25,600-token threshold remains the
 * last-resort catastrophic backstop. Tune after dogfooding.
 */
export const DEFAULT_ECONOMY_BUDGET_TOKENS = 2000;

// Verbose-by-design response budgets. These actions are the intentional detail
// paths, so they declare explicit higher budgets rather than exemptions —
// everything still resolves a number. Values are grounded in measured
// worst-case outputs: a `describe` of the ten largest orchestrate actions runs
// ~21k tokens (full input + output JSON schemas per action), the event
// `describe` emission catalog ~3.5k tokens on top of action schemas, and the
// largest resolved runbook ~2k tokens. Budgets sit between typical usage and
// the worst case so a normal detail call is uncapped while an extreme dump is
// summarized by the dispatch-core seam. Tune after dogfooding.

/** `describe` (workflow / orchestrate / view) — full per-action schemas. */
export const DESCRIBE_ECONOMY_BUDGET_TOKENS = 8000;

/**
 * Event `describe` — sized above {@link DESCRIBE_ECONOMY_BUDGET_TOKENS}
 * because it carries the additional `emissionGuide` param path (the full
 * event catalog grouped by source) on top of action schemas. The
 * `emissionGuide` is a *param* of the one `describe` action, not a separate
 * action, so its budget rides that single descriptor.
 */
export const EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS = 12000;

/** `runbook` — a resolved runbook with step schemas. */
export const RUNBOOK_ECONOMY_BUDGET_TOKENS = 4000;

/**
 * Resolve an action's effective response budget: its declared
 * `economy.budgetTokens` when present, else {@link DEFAULT_ECONOMY_BUDGET_TOKENS}.
 * Always returns a number so callers (the dispatch-core seam, `describe`
 * surfacing) never branch on "declared vs default". The returned value's
 * validity (finite, positive) is pinned at build time by the registry
 * budget-snapshot test; the runtime seam fails OPEN on a non-finite or
 * non-positive budget, because a broken budget must not stop an action from
 * answering.
 */
export function resolveEconomyBudget(action: Pick<ToolAction, 'economy'>): number {
  const declared = action.economy?.budgetTokens;
  return declared !== undefined ? declared : DEFAULT_ECONOMY_BUDGET_TOKENS;
}
