// ─── Prepare Review Orchestrate Handler ──────────────────────────────────────
//
// Serves the quality check catalog as structured data so that any LLM agent on
// any MCP platform can receive the catalog, execute checks (greps, structural
// analysis), and feed findings back to check_review_verdict.
// ──────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import { QUALITY_CHECK_CATALOG } from '../review/check-catalog.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PrepareReviewArgs {
  readonly featureId: string;
  readonly scope?: string;
  readonly dimensions?: readonly string[];
}

// ─── Finding Format Schema ──────────────────────────────────────────────────

const FINDING_FORMAT = `interface PluginFinding {
  source: string;        // "catalog" | "axiom" | "impeccable" | custom
  severity: "HIGH" | "MEDIUM" | "LOW";
  dimension?: string;    // e.g., "error-handling", "DIM-1"
  file?: string;
  line?: number;
  message: string;
}`;

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePrepareReview(
  args: PrepareReviewArgs,
  _stateDir: string,
): Promise<ToolResult> {
  // 1. Validate required fields
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  // 2. Filter catalog by dimensions if requested
  let dimensions = QUALITY_CHECK_CATALOG.dimensions;
  if (args.dimensions?.length) {
    const validIds = new Set(QUALITY_CHECK_CATALOG.dimensions.map((d) => d.id));
    const invalid = args.dimensions.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Unknown dimension(s): ${invalid.join(', ')}. Valid: ${[...validIds].join(', ')}`,
        },
      };
    }
    const requested = new Set(args.dimensions);
    dimensions = QUALITY_CHECK_CATALOG.dimensions.filter((d) => requested.has(d.id));
  }

  // 3. Plugin status defaults — in a full integration, this would read .exarchos.yml
  // via loadProjectConfig(). For now, default both to enabled since config loading
  // requires a project root which may not be available in all contexts.
  const pluginStatus = {
    axiom: {
      enabled: true,
      hint: 'Install with: claude plugin install axiom@lvlup-sw',
    },
    impeccable: {
      enabled: true,
      hint: 'Install with: claude plugin install impeccable@impeccable',
    },
  };

  return {
    success: true,
    data: {
      catalog: {
        version: QUALITY_CHECK_CATALOG.version,
        dimensions,
      },
      findingFormat: FINDING_FORMAT,
      pluginStatus,
    },
  };
}
