/**
 * CLI / `exarchos_view` facade over the effective invariant catalog (DR-7).
 *
 * This is the NOW facade (INV-5c): the `exarchos_view invariants_effective`
 * action and the CLI `--json` form both route here. It does NOT recompute the
 * catalog — it delegates to the single core function
 * `resolveEffectiveCatalog` and surfaces its output verbatim, so the CLI
 * payload is byte-identical to any other facade's (INV-2).
 *
 * SEAM (#1275): expose this same payload as
 * resources/exarchos-invariants/effective when MCP Resources land. The
 * Resource read handler will call `resolveEffectiveCatalog` with the same
 * ctx and return the same `{ entries, warnings }` shape this facade returns —
 * do NOT register any `resources/*` today.
 */
import type { ToolResult } from '../format.js';
import { loadExarchosConfig } from '../config/load-exarchos-config.js';
import {
  resolveEffectiveCatalog,
  type ResolveEffectiveCatalogResult,
} from '../architecture/resolve-effective-catalog.js';

/** Args accepted by the effective-catalog view facade (DR-7). */
export interface ViewInvariantsEffectiveArgs {
  /**
   * Repository root used to (a) load `.exarchos.yml` and (b) resolve the
   * built-in dev catalog path. Defaults to `process.cwd()` so the CLI and
   * MCP arms behave the same when omitted.
   */
  repoRoot?: string;
  /** SDLC phase to project for. */
  phase: string;
  /** Workflow kind to project for. */
  workflowType: string;
  /** Files the current task touches (delegate-phase narrowing). */
  touchedFiles?: string[];
}

/**
 * Resolve + return the effective invariant catalog for the given context.
 *
 * Loads `.exarchos.yml` (catalog registrations, overrides) from the
 * repo root, then delegates the merge/override/project pipeline to
 * `resolveEffectiveCatalog`. The returned `data` is exactly the core fn's
 * `{ entries, warnings }` result — the facade adds no fields, so every
 * surface (CLI `--json`, MCP action, future Resource) sees the same payload.
 */
export async function handleViewInvariantsEffective(
  args: ViewInvariantsEffectiveArgs,
): Promise<ToolResult> {
  try {
    const repoRoot = args.repoRoot ?? process.cwd();

    // Load `.exarchos.yml` so the dev gate, user `catalogs`, and `overrides`
    // flow into the core fn. `loadExarchosConfig` returns null when no config
    // file exists — the core fn treats an undefined config as default-disabled.
    const loaded = loadExarchosConfig(repoRoot);
    const config = loaded?.config;

    const result: ResolveEffectiveCatalogResult = resolveEffectiveCatalog({
      repoRoot,
      config,
      phase: args.phase,
      workflowType: args.workflowType,
      touchedFiles: args.touchedFiles,
    });

    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
