// ─── Sync Now Handler ────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import type { ToolResult } from '../format.js';
import { Outbox } from './outbox.js';
import type { EventSender } from './types.js';

// ─── Stream Discovery ───────────────────────────────────────────────────────

async function discoverOutboxStreams(stateDir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(stateDir);
    return files
      .filter((f) => f.endsWith('.outbox.json'))
      .map((f) => f.replace('.outbox.json', ''));
  } catch {
    return [];
  }
}

// ─── handleSyncNow ──────────────────────────────────────────────────────────

/**
 * Discovers all outbox streams in stateDir and drains pending entries.
 * When no sender is provided (local mode), skips the drain entirely so
 * pending entries are preserved. When a sender IS provided, drains
 * pending entries through it.
 */
export async function handleSyncNow(
  stateDir: string,
  outbox?: Outbox,
  sender?: EventSender,
): Promise<ToolResult> {
  try {
    const streamIds = await discoverOutboxStreams(stateDir);

    if (streamIds.length === 0) {
      return {
        success: true,
        data: {
          streams: 0,
          message: 'No outbox streams found; no remote configured',
        },
      };
    }

    // Local mode: no sender available, skip drain to preserve pending entries
    if (!sender) {
      return {
        success: true,
        data: {
          streams: streamIds.length,
          message: `Local mode: ${streamIds.length} stream(s) with pending entries (drain skipped)`,
        },
      };
    }

    // Remote/dual mode: drain pending entries through the sender
    const effectiveOutbox = outbox ?? new Outbox(stateDir);
    const results: Array<{ streamId: string; sent: number; failed: number }> = [];

    for (const streamId of streamIds) {
      const result = await effectiveOutbox.drain(sender, streamId);
      results.push({ streamId, ...result });
    }

    return {
      success: true,
      data: {
        streams: streamIds.length,
        results,
        message: `Drained ${streamIds.length} stream(s)`,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'SYNC_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
