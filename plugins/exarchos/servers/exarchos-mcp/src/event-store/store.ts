import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { WorkflowEventBase } from './schemas.js';
import type { WorkflowEvent } from './schemas.js';

// ─── Sequence Conflict Error ────────────────────────────────────────────────

export class SequenceConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Sequence conflict: expected ${expected}, actual ${actual}`,
    );
    this.name = 'SequenceConflictError';
  }
}

// ─── Append Options ─────────────────────────────────────────────────────────

export interface AppendOptions {
  expectedSequence?: number;
}

// ─── Query Filters ──────────────────────────────────────────────────────────

export interface QueryFilters {
  type?: string;
  sinceSequence?: number;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

// ─── Stream ID Validation ────────────────────────────────────────────────────

const SAFE_STREAM_ID_PATTERN = /^[a-z0-9-]+$/;

/** Validates that a stream ID matches the safe pattern (lowercase alphanumeric and hyphens). */
function validateStreamId(streamId: string): void {
  if (!SAFE_STREAM_ID_PATTERN.test(streamId)) {
    throw new Error(
      `Invalid streamId "${streamId}": must match ${SAFE_STREAM_ID_PATTERN} (lowercase alphanumeric and hyphens only)`,
    );
  }
}

// ─── Event Store ────────────────────────────────────────────────────────────

export class EventStore {
  private sequenceCounters: Map<string, number> = new Map();
  private locks: Map<string, Promise<void>> = new Map();

  constructor(private readonly stateDir: string) {}

  private async withLock<T>(streamId: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.locks.get(streamId) ?? Promise.resolve();
    let release: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(streamId, lock);
    try {
      await existing;
      return await fn();
    } finally {
      release!();
      if (this.locks.get(streamId) === lock) {
        this.locks.delete(streamId);
      }
    }
  }

  private getEventFilePath(streamId: string): string {
    validateStreamId(streamId);
    return path.join(this.stateDir, `${streamId}.events.jsonl`);
  }

  private getSeqFilePath(streamId: string): string {
    validateStreamId(streamId);
    return path.join(this.stateDir, `${streamId}.seq`);
  }

  async append(
    streamId: string,
    event: Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string },
    options?: AppendOptions,
  ): Promise<WorkflowEvent> {
    return this.withLock(streamId, async () => {
      const filePath = this.getEventFilePath(streamId);

      // Initialize sequence from file if not cached
      if (!this.sequenceCounters.has(streamId)) {
        await this.initializeSequence(streamId);
      }

      const currentSequence = this.sequenceCounters.get(streamId) ?? 0;

      // Optimistic concurrency check
      if (options?.expectedSequence !== undefined) {
        // Re-read from file for freshest state
        await this.initializeSequence(streamId);
        const actualSequence = this.sequenceCounters.get(streamId) ?? 0;

        if (actualSequence !== options.expectedSequence) {
          throw new SequenceConflictError(options.expectedSequence, actualSequence);
        }
      }

      const sequence = (this.sequenceCounters.get(streamId) ?? 0) + 1;
      this.sequenceCounters.set(streamId, sequence);

      const fullEvent = WorkflowEventBase.parse({
        ...event,
        streamId,
        sequence,
        timestamp: event.timestamp || new Date().toISOString(),
      });

      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Append as JSONL
      await fs.appendFile(filePath, JSON.stringify(fullEvent) + '\n', 'utf-8');

      // Write sequence counter atomically (best-effort: JSONL is source of truth)
      const seqPath = this.getSeqFilePath(streamId);
      const tmpPath = `${seqPath}.tmp`;
      try {
        await fs.writeFile(tmpPath, JSON.stringify({ sequence }), 'utf-8');
        await fs.rename(tmpPath, seqPath);
      } catch {
        // Best-effort: JSONL is source of truth, .seq is just a cache
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        await fs.rm(seqPath, { force: true }).catch(() => {});
      }

      return fullEvent;
    });
  }

  async query(streamId: string, filters?: QueryFilters): Promise<WorkflowEvent[]> {
    const filePath = this.getEventFilePath(streamId);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return [];
    }

    const events: WorkflowEvent[] = [];
    const input = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });

    let skipped = 0;
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit;

    for await (const line of rl) {
      if (!line.trim()) continue;

      const event = JSON.parse(line) as WorkflowEvent;

      // Apply filters
      if (filters?.sinceSequence !== undefined && event.sequence <= filters.sinceSequence) continue;
      if (filters?.type && event.type !== filters.type) continue;
      if (filters?.since && event.timestamp < filters.since) continue;
      if (filters?.until && event.timestamp > filters.until) continue;

      // Apply offset
      if (skipped < offset) {
        skipped++;
        continue;
      }

      events.push(event);

      // Early termination on limit
      if (limit !== undefined && events.length >= limit) {
        rl.close();
        input.destroy();
        break;
      }
    }

    return events;
  }

  async refreshSequence(streamId: string): Promise<void> {
    await this.initializeSequence(streamId);
  }

  private async initializeSequence(streamId: string): Promise<void> {
    // Try .seq file first (O(1))
    const seqPath = this.getSeqFilePath(streamId);
    try {
      const content = await fs.readFile(seqPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed.sequence === 'number' && parsed.sequence >= 0) {
        this.sequenceCounters.set(streamId, parsed.sequence);
        return;
      }
    } catch {
      // Fall through to line counting
    }

    // Fallback: count lines in JSONL file (O(n))
    const filePath = this.getEventFilePath(streamId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      this.sequenceCounters.set(streamId, lines.length);
    } catch {
      this.sequenceCounters.set(streamId, 0);
    }
  }
}
