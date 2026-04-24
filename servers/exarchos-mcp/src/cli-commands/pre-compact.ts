import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listStateFiles } from '../workflow/state-store.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { dispatch } from '../core/dispatch.js';
import { handleAssembleContext } from './assemble-context.js';
import type { CommandResult } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result returned from the pre-compact handler. */
export interface PreCompactResult extends CommandResult {
  readonly continue: boolean;
  readonly stopReason?: string;
}

// ─── Terminal Phases ────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);

// ─── Pre-Compact Handler ────────────────────────────────────────────────────

/**
 * Scan the state directory for active workflows, materialize a rehydration
 * snapshot per workflow by dispatching `exarchos_workflow.checkpoint`
 * (T034), and return whether compaction should proceed.
 *
 * T059 (DR-16) — replaces the prior inline sidecar writer
 * (`<featureId>.checkpoint.json`) with a dispatch to the shared composite
 * handler. The handler owns:
 *   - resetting the checkpoint counter on the state file
 *   - emitting `workflow.checkpoint` + `workflow.checkpoint_written` events
 *   - writing the rehydration projection snapshot
 *
 * `context.md` generation remains here — it is the output of
 * `assemble-context`, not of `handleCheckpoint`, and callers downstream of
 * pre-compact still rely on the file existing on disk after a compaction
 * boundary.
 *
 * Next-action derivation previously lived inline in this file; it has
 * moved to `next-actions-computer.ts` (T040) and is surfaced through the
 * envelope returned by dispatch (T041) — so pre-compact no longer needs
 * to compute it.
 */
export async function handlePreCompact(
  stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<PreCompactResult> {
  const trigger = typeof stdinData.type === 'string' ? stdinData.type : 'auto';

  // List all state files (listStateFiles handles missing directory gracefully)
  const allWorkflows = (await listStateFiles(stateDir)).valid;

  // Filter to active (non-terminal) workflows
  const activeWorkflows = allWorkflows.filter(
    (wf) => !TERMINAL_PHASES.has(wf.state.phase),
  );

  // No active workflows: allow compaction
  if (activeWorkflows.length === 0) {
    return { continue: true };
  }

  // Build a minimal DispatchContext once. `getOrCreateEventStore` caches by
  // stateDir so repeated pre-compact invocations in the same process share
  // the same handle (same pattern used by other CLI adapters).
  const eventStore = getOrCreateEventStore(stateDir);
  const ctx = {
    stateDir,
    eventStore,
    enableTelemetry: false,
  };

  // Checkpoint all active workflows in parallel — each workflow's I/O is
  // independent. Dispatch owns the snapshot write + event emission; we
  // additionally write `context.md` alongside so existing consumers can
  // read the assembled context after /clear.
  await Promise.all(
    activeWorkflows.map(async ({ featureId }) => {
      await dispatch(
        'exarchos_workflow',
        { action: 'checkpoint', featureId },
        ctx,
      );

      // Generate context.md — independent of the checkpoint snapshot. Failure
      // here is non-fatal: a missing context file is graceful degradation,
      // and the projection snapshot from dispatch is the authoritative
      // rehydration source.
      try {
        const contextResult = await handleAssembleContext({ featureId }, stateDir);
        if (contextResult.contextDocument) {
          const contextFile = path.join(stateDir, `${featureId}.context.md`);
          await fs.writeFile(contextFile, contextResult.contextDocument, 'utf-8');
        }
      } catch {
        // Graceful degradation
      }
    }),
  );

  if (trigger === 'manual') {
    return { continue: true };
  }

  return {
    continue: false,
    stopReason: `Context checkpoint saved. Type /clear to reload with fresh context.`,
  };
}
