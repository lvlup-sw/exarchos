/**
 * Bindings lifted from `registry` — the composite-tool registry.
 *
 * `registry.ts` is a DR-1 declaration STORE, so this module must not import a
 * contract module (`contract/declaration.ts`, `contract/declaration-seam.ts`).
 * See `./README.md`.
 */
import { TOOL_REGISTRY, buildToolDescription } from '../../registry.js';
import type { CompositeTool } from '../../registry.js';
import {
  auditDescriptionBudgets,
  type BudgetReport,
  type ToolDescriptionBuilder,
} from '../description-budget.js';

/** The live composite-tool registry — the description budget's real subject. */
export const LIVE_TOOLS: readonly CompositeTool[] = TOOL_REGISTRY;

/** The registry's own description renderer, as a port. */
export const BUILD_TOOL_DESCRIPTION: ToolDescriptionBuilder = buildToolDescription;

/** Audit the live registry against the description budgets. */
export function auditLiveDescriptionBudgets(): BudgetReport {
  return auditDescriptionBudgets(LIVE_TOOLS, BUILD_TOOL_DESCRIPTION);
}
