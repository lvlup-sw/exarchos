// ─── Sync Now Handler ────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import type { ToolResult } from '../format.js';
import { Outbox } from './outbox.js';
import type { EventSender, AppendEventsResponse, ExarchosEventDto } from './types.js';

// ─── No-Op Event Sender ─────────────────────────────────────────────────────

/** A no-op sender used when no remote is configured. Logs but does not send. */
const noopSender: EventSender = {
  async appendEvents(
    _streamId: string,
    _events: ExarchosEventDto[],
  ): Promise<AppendEventsResponse> {
    // No remote configured; events marked confirmed locally (no actual send)
    return { accepted: 0, streamVersion: 0 };
  },
};

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
 * Since no remote client is configured yet, uses a no-op sender that
 * marks entries as confirmed locally without actually sending.
 */
export async function handleSyncNow(stateDir: string): Promise<ToolResult> {
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

    const outbox = new Outbox(stateDir);
    const results: Array<{ streamId: string; sent: number; failed: number }> = [];

    for (const streamId of streamIds) {
      const result = await outbox.drain(noopSender, streamId);
      results.push({ streamId, ...result });
    }

    return {
      success: true,
      data: {
        streams: streamIds.length,
        results,
        message: `Drained ${streamIds.length} stream(s); no remote configured`,
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
