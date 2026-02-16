import { isDeepStrictEqual } from 'node:util';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { ConflictInfo } from './types.js';

// ─── Phase Ordering (feature workflow) ───────────────────────────────────────

const PHASE_ORDER = [
  'ideate',
  'plan',
  'plan-review',
  'delegate',
  'review',
  'synthesize',
  'completed',
];

// ─── Task Status Precedence ──────────────────────────────────────────────────

const STATUS_PRECEDENCE: Record<string, number> = {
  'pending': 0,
  'claimed': 1,
  'in_progress': 2,
  'completed': 3,
  'failed': 3,
};

// ─── Conflict Resolver ──────────────────────────────────────────────────────

export class ConflictResolver {
  resolve(
    localEvents: WorkflowEvent[],
    remoteEvents: WorkflowEvent[],
  ): ConflictInfo[] {
    const conflicts: ConflictInfo[] = [];

    // Build lookup by sequence for overlap detection
    const localBySeq = new Map(localEvents.map((e) => [e.sequence, e]));
    const remoteBySeq = new Map(remoteEvents.map((e) => [e.sequence, e]));

    // Find overlapping sequences
    for (const [seq, remoteEvent] of remoteBySeq) {
      const localEvent = localBySeq.get(seq);
      if (!localEvent) continue;

      // Same sequence, potentially conflicting
      if (localEvent.type === remoteEvent.type && isDeepStrictEqual(localEvent.data, remoteEvent.data)) {
        // Identical events — no conflict
        continue;
      }

      // Phase divergence
      if (
        localEvent.type === 'workflow.transition' &&
        remoteEvent.type === 'workflow.transition'
      ) {
        const localTo = (localEvent.data as Record<string, unknown>)?.to as string;
        const remoteTo = (remoteEvent.data as Record<string, unknown>)?.to as string;

        const localIdx = PHASE_ORDER.indexOf(localTo);
        const remoteIdx = PHASE_ORDER.indexOf(remoteTo);

        if (localIdx >= 0 && remoteIdx >= 0 && localIdx !== remoteIdx) {
          const winner = localIdx > remoteIdx ? 'local' : 'remote';
          conflicts.push({
            streamId: localEvent.streamId,
            type: 'phase-divergence',
            localEvent,
            remoteEvent,
            resolution: `${winner}-wins (more advanced phase: ${winner === 'local' ? localTo : remoteTo})`,
          });
          continue;
        }
      }

      // Task status conflict
      if (
        (localEvent.type === 'task.completed' ||
          localEvent.type === 'task.progressed' ||
          localEvent.type === 'task.claimed' ||
          localEvent.type === 'task.failed') &&
        (remoteEvent.type === 'task.completed' ||
          remoteEvent.type === 'task.progressed' ||
          remoteEvent.type === 'task.claimed' ||
          remoteEvent.type === 'task.failed')
      ) {
        const localStatus = this.getStatusFromEventType(localEvent.type);
        const remoteStatus = this.getStatusFromEventType(remoteEvent.type);

        const localPrec = STATUS_PRECEDENCE[localStatus] ?? 0;
        const remotePrec = STATUS_PRECEDENCE[remoteStatus] ?? 0;

        if (localPrec !== remotePrec) {
          const winner = localPrec > remotePrec ? 'local' : 'remote';
          conflicts.push({
            streamId: localEvent.streamId,
            type: 'task-status',
            localEvent,
            remoteEvent,
            resolution: `${winner}-wins (${winner === 'local' ? localStatus : remoteStatus} takes precedence)`,
          });
          continue;
        }
      }

      // Concurrent transitions — both preserved
      conflicts.push({
        streamId: localEvent.streamId,
        type: 'concurrent-transition',
        localEvent,
        remoteEvent,
        resolution: 'both-preserved',
      });
    }

    return conflicts;
  }

  private getStatusFromEventType(type: string): string {
    switch (type) {
      case 'task.completed':
        return 'completed';
      case 'task.failed':
        return 'failed';
      case 'task.progressed':
        return 'in_progress';
      case 'task.claimed':
        return 'claimed';
      default:
        return 'pending';
    }
  }
}
