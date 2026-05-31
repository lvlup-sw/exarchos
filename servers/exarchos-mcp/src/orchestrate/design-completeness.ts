// ─── Design Completeness Gate ────────────────────────────────────────────────
//
// Orchestrates design document completeness checks at the ideate→plan boundary
// by calling the pure TypeScript handleDesignCompleteness function and emitting
// gate.executed events for IdeateReadinessView and CodeQualityView integration.
//
// This gate is ADVISORY — failures inform but do not block phase transitions.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent } from './gate-utils.js';
import { handleDesignCompleteness as runDesignCompleteness } from './pure/design-completeness.js';
import { resolveWorkflowState } from './resolve-state.js';

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleDesignCompleteness(
  args: { featureId: string; stateFile?: string; designPath?: string },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // 1. Validate input
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const streamId = args.featureId;
  // Canonical workflow-state filename convention: `${featureId}.state.json`
  // (matches storage/lifecycle.ts and the assemble-context state-file consumer).
  const stateFile = args.stateFile ?? `${stateDir}/${streamId}.state.json`;

  // Resolve `artifacts.design` via the canonical resolver (file → event-store
  // fallback). INV-1: the event store is the sole source of truth; the
  // `.state.json` file is a derived stamp that may be absent for MCP-only
  // workflows. We feed the resolved design path into the pure checker so it
  // never has to re-read the (possibly missing) state file itself.
  let designPathFromState: string | null = null;
  const resolved = await resolveWorkflowState({
    stateFile,
    featureId: streamId,
    eventStore,
  });
  if ('error' in resolved) {
    // A resolver error here means state could not be read from EITHER source:
    // resolveWorkflowState only reaches the event store (and can return
    // EVENT_STORE_ERROR) after the state file proved unusable. Propagate the
    // underlying error so an infrastructure failure surfaces its real cause
    // instead of being silently flattened to designPathFromState=null — which
    // the pure checker would otherwise report as the misleading advisory
    // finding "artifacts.design is empty or missing".
    return resolved.error;
  }
  const artifacts = resolved.state.artifacts;
  if (artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
    const design = (artifacts as Record<string, unknown>).design;
    designPathFromState = typeof design === 'string' && design.length > 0 ? design : null;
  }

  // 2. Evaluate the markdown design document. The YAML gate-sidecar layer
  // (#1298) was abandoned in #1494 — SQLite is the authoritative structured
  // record, so markdown parsing is the permanent authoring-gate path. The
  // `designPath` arg (sidecar override) is preserved as `designFile`.
  let parsed;
  try {
    parsed = runDesignCompleteness({
      stateFile,
      designFile: args.designPath,
      docsDir: 'docs/designs',
      designPathFromState,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'DESIGN_CHECK_ERROR', message: `Design completeness check failed: ${message}` },
    };
  }

  // 3. Emit gate.executed event
  try {
    const store = eventStore;
    await emitGateEvent(store, streamId, 'design-completeness', 'design', parsed.passed, {
      dimension: 'D1',
      phase: 'ideate',
      advisory: true,
      findings: [...parsed.findings],
      checkCount: parsed.checkCount,
      passCount: parsed.passCount,
      failCount: parsed.failCount,
    });
  } catch {
    // Fire-and-forget: event emission failure must not break the gate check
  }

  // 4. Return result
  return {
    success: true,
    data: { ...parsed },
  };
}
