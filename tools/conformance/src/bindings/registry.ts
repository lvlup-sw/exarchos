/**
 * Bindings from `registry`, the composite-tool registry.
 *
 * `registry.ts` is a declaration store. A file that imports a store must not also
 * import a contract module, so this module does not import `contract/declaration.ts`
 * or `contract/declaration-seam.ts`.
 */
import { TOOL_REGISTRY, buildToolDescription } from '../../../../src/registry.js';
import type { CompositeTool } from '../../../../src/registry.js';
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
