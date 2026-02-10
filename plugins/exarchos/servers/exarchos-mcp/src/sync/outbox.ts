import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { OutboxEntry, EventSender } from './types.js';

// ─── Stream ID Validation ────────────────────────────────────────────────────

const SAFE_STREAM_ID = /^[A-Za-z0-9._-]+$/;

// ─── Outbox ──────────────────────────────────────────────────────────────────

export class Outbox {
  constructor(private readonly stateDir: string) {}

  // ─── File Path ──────────────────────────────────────────────────────────

  private getFilePath(streamId: string): string {
    if (!SAFE_STREAM_ID.test(streamId)) {
      throw new Error(`Invalid streamId: ${streamId}`);
    }
    return path.join(this.stateDir, `${streamId}.outbox.json`);
  }

  // ─── Add Entry ──────────────────────────────────────────────────────────

  async addEntry(
    streamId: string,
    event: WorkflowEvent,
  ): Promise<OutboxEntry> {
    const entry: OutboxEntry = {
      id: crypto.randomUUID(),
      streamId,
      event,
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString(),
    };

    const entries = await this.loadEntries(streamId);
    entries.push(entry);
    await this.saveEntries(streamId, entries);

    return entry;
  }

  // ─── Load Entries ───────────────────────────────────────────────────────

  async loadEntries(streamId: string): Promise<OutboxEntry[]> {
    const filePath = this.getFilePath(streamId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (!content.trim()) {
        return [];
      }
      return JSON.parse(content) as OutboxEntry[];
    } catch {
      return [];
    }
  }

  // ─── Update Entry ──────────────────────────────────────────────────────

  async updateEntry(
    streamId: string,
    entryId: string,
    updates: Partial<OutboxEntry>,
  ): Promise<void> {
    const entries = await this.loadEntries(streamId);
    const index = entries.findIndex((e) => e.id === entryId);
    if (index >= 0) {
      entries[index] = { ...entries[index], ...updates };
      await this.saveEntries(streamId, entries);
    }
  }

  // ─── Remove Entry ─────────────────────────────────────────────────────

  async removeEntry(streamId: string, entryId: string): Promise<void> {
    const entries = await this.loadEntries(streamId);
    const filtered = entries.filter((e) => e.id !== entryId);
    await this.saveEntries(streamId, filtered);
  }

  // ─── Drain (send pending entries) ──────────────────────────────────────

  async drain(
    client: EventSender,
    streamId: string,
    batchSize: number = 50,
  ): Promise<{ sent: number; failed: number }> {
    const entries = await this.loadEntries(streamId);
    const pending = entries
      .filter((e) => e.status === 'pending')
      .filter((e) => {
        if (!e.nextRetryAt) return true;
        return new Date(e.nextRetryAt) <= new Date();
      })
      .slice(0, batchSize);

    let sent = 0;
    let failed = 0;

    for (const entry of pending) {
      try {
        await client.appendEvents(streamId, [
          {
            streamId: entry.event.streamId,
            sequence: entry.event.sequence,
            timestamp: entry.event.timestamp,
            type: entry.event.type,
            correlationId: entry.event.correlationId,
            causationId: entry.event.causationId,
            agentId: entry.event.agentId,
            agentRole: entry.event.agentRole,
            source: entry.event.source,
            schemaVersion: entry.event.schemaVersion,
            data: entry.event.data,
          },
        ]);

        await this.updateEntry(streamId, entry.id, {
          status: 'confirmed',
          attempts: entry.attempts + 1,
          lastAttemptAt: new Date().toISOString(),
        });
        sent++;
      } catch (err) {
        const attempts = entry.attempts + 1;
        const maxRetries = 10;

        if (attempts >= maxRetries) {
          await this.markDeadLetter(
            streamId,
            entry.id,
            err instanceof Error ? err.message : String(err),
          );
        } else {
          await this.updateEntry(streamId, entry.id, {
            attempts,
            lastAttemptAt: new Date().toISOString(),
            nextRetryAt: this.calculateNextRetry(attempts),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        failed++;
      }
    }

    return { sent, failed };
  }

  // ─── Retry Backoff ─────────────────────────────────────────────────────

  calculateNextRetry(attempts: number): string {
    const delayMs = Math.min(Math.pow(2, attempts - 1) * 1000, 60_000);
    return new Date(Date.now() + delayMs).toISOString();
  }

  // ─── Dead Letter ───────────────────────────────────────────────────────

  async markDeadLetter(
    streamId: string,
    entryId: string,
    error: string,
  ): Promise<void> {
    await this.updateEntry(streamId, entryId, {
      status: 'dead-letter',
      error,
      lastAttemptAt: new Date().toISOString(),
    });
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────

  async cleanup(
    streamId: string,
    maxAge: number = 86400000,
  ): Promise<number> {
    const entries = await this.loadEntries(streamId);
    const now = Date.now();
    let removed = 0;

    const filtered = entries.filter((entry) => {
      if (entry.status === 'confirmed') {
        const age = now - new Date(entry.lastAttemptAt || entry.createdAt).getTime();
        if (age > maxAge) {
          removed++;
          return false;
        }
      }
      // Preserve dead-letter entries
      return true;
    });

    if (removed > 0) {
      await this.saveEntries(streamId, filtered);
    }

    return removed;
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  private async saveEntries(
    streamId: string,
    entries: OutboxEntry[],
  ): Promise<void> {
    const filePath = this.getFilePath(streamId);
    const tmpPath = `${filePath}.tmp.${Date.now()}`;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }
}
