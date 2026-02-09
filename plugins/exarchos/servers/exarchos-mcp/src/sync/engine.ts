import type { BasileusClient } from './client.js';
import type { EventStore } from '../event-store/store.js';
import type { Outbox } from './outbox.js';
import type { ConflictResolver } from './conflict.js';
import type { SyncStateManager } from './sync-state.js';
import type { SyncConfig, SyncResult, ConflictInfo, ExarchosEventDto } from './types.js';
import type { EventType } from '../event-store/schemas.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { EventTypes } from '../event-store/schemas.js';

// ─── Sync Engine ─────────────────────────────────────────────────────────────

export class SyncEngine {
  constructor(
    private readonly client: BasileusClient,
    private readonly eventStore: EventStore,
    private readonly outbox: Outbox,
    private readonly conflictResolver: ConflictResolver,
    private readonly syncState: SyncStateManager,
    private readonly config: SyncConfig,
  ) {}

  // ─── Push Events ───────────────────────────────────────────────────────

  async pushEvents(
    streamId: string,
  ): Promise<{ count: number; errors: string[] }> {
    const errors: string[] = [];

    try {
      const drainResult = await this.outbox.drain(
        this.client,
        streamId,
        this.config.batchSize,
      );

      if (drainResult.sent > 0) {
        // Get the current max sequence from outbox entries to update HWM
        const entries = await this.outbox.loadEntries(streamId);
        const confirmed = entries.filter((e) => e.status === 'confirmed');
        if (confirmed.length > 0) {
          const maxSeq = Math.max(
            ...confirmed.map((e) => e.event.sequence),
          );
          await this.syncState.updateLocalHWM(streamId, maxSeq);
        }
      }

      if (drainResult.failed > 0) {
        errors.push(`${drainResult.failed} events failed to send`);
      }

      return { count: drainResult.sent, errors };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return { count: 0, errors };
    }
  }

  // ─── Pull Events ──────────────────────────────────────────────────────

  async pullEvents(
    streamId: string,
  ): Promise<{ count: number; conflicts: ConflictInfo[] }> {
    const state = await this.syncState.load(streamId);
    const remoteEvents = await this.client.getEventsSince(
      streamId,
      state.remoteHighWaterMark,
    );

    if (remoteEvents.length === 0) {
      return { count: 0, conflicts: [] };
    }

    // Check for conflicts with local events at same sequences
    const remoteSequences = remoteEvents.map((e) => e.sequence);
    const minSeq = Math.min(...remoteSequences);
    const localEvents = await this.eventStore.query(streamId, {
      sinceSequence: minSeq - 1,
    });

    const conflicts = this.conflictResolver.resolve(
      localEvents,
      remoteEvents.map((dto) => this.dtoToEvent(dto)),
    );

    // Append remote events to local store
    let appended = 0;
    for (const dto of remoteEvents) {
      try {
        const eventType = dto.type as EventType;
        // Validate event type is known
        if (!(EventTypes as readonly string[]).includes(eventType)) {
          continue;
        }

        await this.eventStore.append(streamId, {
          type: eventType,
          data: dto.data,
          correlationId: dto.correlationId,
          causationId: dto.causationId,
          agentId: dto.agentId,
          agentRole: dto.agentRole,
          source: dto.source ?? 'remote',
          timestamp: dto.timestamp,
          schemaVersion: dto.schemaVersion,
        });
        appended++;
      } catch {
        // Skip events that fail to append (e.g. sequence conflicts)
      }
    }

    // Update remote HWM
    const maxRemoteSeq = Math.max(...remoteSequences);
    await this.syncState.updateRemoteHWM(streamId, maxRemoteSeq);

    return { count: appended, conflicts };
  }

  // ─── Full Sync ─────────────────────────────────────────────────────────

  async sync(
    streamId: string,
    direction: 'push' | 'pull' | 'both' = 'both',
  ): Promise<SyncResult> {
    let pushed = 0;
    let pulled = 0;
    const allConflicts: ConflictInfo[] = [];

    if (direction === 'push' || direction === 'both') {
      const pushResult = await this.pushEvents(streamId);
      pushed = pushResult.count;
    }

    if (direction === 'pull' || direction === 'both') {
      const pullResult = await this.pullEvents(streamId);
      pulled = pullResult.count;
      allConflicts.push(...pullResult.conflicts);
    }

    // Update sync state
    const state = await this.syncState.load(streamId);
    state.lastSyncAt = new Date().toISOString();
    state.lastSyncResult =
      allConflicts.length > 0 ? 'partial' : 'success';
    await this.syncState.save(streamId, state);

    return { pushed, pulled, conflicts: allConflicts };
  }

  // ─── DTO Conversion ────────────────────────────────────────────────────

  private dtoToEvent(dto: ExarchosEventDto): WorkflowEvent {
    return {
      streamId: dto.streamId,
      sequence: dto.sequence,
      timestamp: dto.timestamp,
      type: dto.type as EventType,
      correlationId: dto.correlationId,
      causationId: dto.causationId,
      agentId: dto.agentId,
      agentRole: dto.agentRole,
      source: dto.source,
      schemaVersion: dto.schemaVersion ?? '1.0',
      data: dto.data,
    };
  }
}
