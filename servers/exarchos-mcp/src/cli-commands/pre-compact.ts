import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listStateFiles } from '../workflow/state-store.js';
import { EventStore } from '../event-store/store.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleAssembleContext } from './assemble-context.js';
import type { CommandResult } from './types.js';
import { workflowLogger } from '../logger.js';

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

  // CLI entrypoint: bootstrap own EventStore (separate process boundary).
  // Telemetry is disabled here — the hook path is latency-sensitive and the
  // composite's own logging covers the observability needs of pre-compact.
  const eventStore = new EventStore(stateDir);
  try {
    await eventStore.initialize();
  } catch (err) {
    // Non-PidLockError init failures (filesystem, permissions, etc.) leave
    // the store with `initialized=false` and `sidecarMode=false`. In that
    // state `append()` would skip the sidecar branch and write through the
    // primary path without the PID lock — exactly the multi-process race
    // the lock exists to prevent. Skip the checkpoint dispatch entirely and
    // let compaction proceed: graceful degradation > corrupted event stream.
    // PidLockError is handled internally by initialize() and never reaches
    // this catch (it transitions to sidecar mode + initialized=true).
    workflowLogger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'EventStore init failed in pre-compact — skipping checkpoint dispatch to preserve event-stream integrity',
    );
    return { continue: true };
  }
  const ctx: DispatchContext = {
    stateDir,
    eventStore,
    enableTelemetry: false,
  };

  // Checkpoint all active workflows in parallel — each workflow's I/O is
  // independent. Dispatch owns the snapshot write + event emission; we
  // additionally write `context.md` alongside so existing consumers can
  // read the assembled context after /clear.
  //
  // Per-workflow result tracking lets us fail closed when ANY checkpoint
  // dispatch reports `success: false`: dispatch can fail structurally
  // without throwing (CodeRabbit PR #1178 — duplicate of an earlier review),
  // and proceeding to `/clear` after a failed checkpoint would mean the
  // user loses context with no usable snapshot to rehydrate from.
  const checkpointResults = await Promise.all(
    activeWorkflows.map(async ({ featureId }) => {
      const result = await dispatch(
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

      return { featureId, ok: result.success === true, error: result.error };
    }),
  );

  const failed = checkpointResults.filter((r) => !r.ok);
  if (failed.length > 0) {
    const summary = failed
      .map((f) => `${f.featureId}: ${f.error?.message ?? 'unknown error'}`)
      .join('; ');
    return {
      continue: false,
      stopReason: `Checkpoint failed for ${failed.length}/${activeWorkflows.length} active workflow(s); /clear is unsafe — ${summary}`,
    };
  }

  if (trigger === 'manual') {
    return { continue: true };
  }

  return {
    continue: false,
    stopReason: `Context checkpoint saved. Type /clear to reload with fresh context.`,
  };
}
