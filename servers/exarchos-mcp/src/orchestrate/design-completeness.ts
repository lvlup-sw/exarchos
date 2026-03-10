// ─── Design Completeness Gate ────────────────────────────────────────────────
//
// Orchestrates design document completeness checks at the ideate→plan boundary
// by calling the pure TypeScript handleDesignCompleteness function and emitting
// gate.executed events for IdeateReadinessView and CodeQualityView integration.
//
// This gate is ADVISORY — failures inform but do not block phase transitions.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';
import { handleDesignCompleteness as runDesignCompleteness } from './pure/design-completeness.js';

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleDesignCompleteness(
  args: { featureId: string; stateFile?: string; designPath?: string },
  stateDir: string,
): Promise<ToolResult> {
  // 1. Validate input
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const streamId = args.featureId;
  const stateFile = args.stateFile ?? `${stateDir}/${streamId}.json`;

  // 2. Call pure TypeScript implementation
  const parsed = runDesignCompleteness({
    stateFile,
    designFile: args.designPath,
    docsDir: 'docs/designs',
  });

  // 3. Emit gate.executed event
  try {
    const store = getOrCreateEventStore(stateDir);
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
    data: parsed,
  };
}
