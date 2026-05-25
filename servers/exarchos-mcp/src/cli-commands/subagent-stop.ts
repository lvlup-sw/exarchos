// ─── SubagentStop Observer ──────────────────────────────────────────────────
//
// #1476: the hook layer is observe-only (see
// docs/adrs/2026-05-24-hook-layer-observe-only.md). This handler is fired by
// the `SubagentStop` hook in hooks/hooks.json when an exarchos-implementer /
// exarchos-fixer subagent finishes. It observes — it never blocks or gates.
//
// Today the observer simply acknowledges the lifecycle signal. It is the
// landing point for future provenance/telemetry capture on subagent
// completion; it must remain non-blocking (no GATE_FAILED, no non-zero exit
// driven by policy) so that retiring the enforcement hooks is not silently
// re-introduced here.

import type { CommandResult } from './types.js';

/**
 * Observe a subagent-stop lifecycle event.
 *
 * Expected stdin shape (best-effort — all fields optional):
 * ```json
 * {
 *   "hook_event_name": "SubagentStop",
 *   "subagent_type": "exarchos-implementer",
 *   "cwd": "/path/to/worktree"
 * }
 * ```
 *
 * Returns a non-blocking acknowledgement. Never returns an `error` for
 * policy reasons — observers report, they do not enforce.
 */
export async function handleSubagentStop(
  input: Record<string, unknown>,
): Promise<CommandResult> {
  const subagentType =
    typeof input.subagent_type === 'string' ? input.subagent_type : 'unknown';
  return { observed: true, subagentType };
}
