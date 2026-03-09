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
    if (step.tool.startsWith('native:')) continue;
    const action = findActionInRegistry(step.tool, step.action);
    if (action?.autoEmits) {
      for (const emission of action.autoEmits) {
        events.add(emission.event);
      }
    }
  }
  return [...events].sort();
}
