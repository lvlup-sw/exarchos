// RESERVED(issue: #1713, owner: exarchos, expires: 2026-10-31) — pre-existing dead; computeRunbookAutoEmits, test-only caller — dead or wiring gap; delete-or-wire tracked in #1713 (DR-7 module-intent gate)

import { findActionInRegistry } from '../registry.js';
import type { RunbookDefinition } from './types.js';

/**
 * Computes the deduplicated, sorted union of autoEmits event names
 * across all non-native steps in a runbook.
 *
 * Native steps (tool starts with 'native:') are skipped because they
 * are Claude Code native tools, not MCP tool calls.
 */
export function computeRunbookAutoEmits(runbook: RunbookDefinition): readonly string[] {
  const events = new Set<string>();
  for (const step of runbook.steps) {
    if (step.tool.startsWith('native:') || step.tool === 'none') continue;
    const action = findActionInRegistry(step.tool, step.action);
    if (action?.autoEmits) {
      for (const emission of action.autoEmits) {
        events.add(emission.event);
      }
    }
  }
  return [...events].sort();
}
