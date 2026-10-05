/**
 * CLI and `exarchos_view invariants_effective` facade over the effective invariant catalog.
 * It does not recompute the catalog. It calls `resolveEffectiveCatalog` and returns that output unchanged, so every facade returns the same payload.
 * An MCP Resource at `resources/exarchos-invariants/effective` can later return the same payload. No `resources/*` handler is registered.
 */
import type { ToolResult } from '../../format.js';
import { loadExarchosConfig } from '../../config/load-exarchos-config.js';
import {
  resolveEffectiveCatalog,
  type ResolveEffectiveCatalogResult,
} from '../../architecture/resolve-effective-catalog.js';

/** Args accepted by the effective-catalog view facade. */
export interface ViewInvariantsEffectiveArgs {
  /**
   * Repository root for loading `.exarchos.yml` and for resolving the built-in dev catalog path.
   * Defaults to `process.cwd()`, so the CLI and MCP arms behave the same when it is absent.
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
 * Resolves the effective invariant catalog for the given context.
 * It loads `.exarchos.yml` from the repo root and passes the config to `resolveEffectiveCatalog`.
 * With no config file, the config is `undefined`, and the core function uses its defaults.
 * The returned `data` is the `{ entries, warnings }` result of the core function, with no added fields.
 */
export async function handleViewInvariantsEffective(
  args: ViewInvariantsEffectiveArgs,
): Promise<ToolResult> {
  try {
    const repoRoot = args.repoRoot ?? process.cwd();

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
