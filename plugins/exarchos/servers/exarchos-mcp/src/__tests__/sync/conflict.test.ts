import { describe, it, expect } from 'vitest';
import { ConflictResolver } from '../../sync/conflict.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

function makeEvent(overrides?: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: '2026-02-08T00:00:00.000Z',
    type: 'task.completed',
    schemaVersion: '1.0',
    ...overrides,
  };
}

describe('ConflictResolver', () => {
  const resolver = new ConflictResolver();

  // ─── No Conflicts ──────────────────────────────────────────────────────

  describe('no conflicts', () => {
    it('should return empty array when no overlapping sequences', () => {
      const local = [makeEvent({ sequence: 1 })];
      const remote = [makeEvent({ sequence: 2 })];

      const conflicts = resolver.resolve(local, remote);
      expect(conflicts).toEqual([]);
    });

    it('should return empty array when identical events at same sequence', () => {
      const event = makeEvent({ sequence: 1, type: 'task.completed', data: { taskId: 't1' } });
      const local = [event];
      const remote = [{ ...event }];

      const conflicts = resolver.resolve(local, remote);
      expect(conflicts).toEqual([]);
    });

    it('should return empty array when both arrays are empty', () => {
      const conflicts = resolver.resolve([], []);
      expect(conflicts).toEqual([]);
    });
  });

  // ─── Phase Divergence ──────────────────────────────────────────────────

  describe('phase divergence', () => {
    it('should resolve with more-advanced phase winning', () => {
      const local = [
        makeEvent({
          sequence: 1,
          type: 'phase.transitioned',
          data: { from: 'ideate', to: 'plan' },
        }),
      ];
      const remote = [
        makeEvent({
          sequence: 1,
          type: 'phase.transitioned',
          data: { from: 'ideate', to: 'delegate' },
        }),
      ];

      const conflicts = resolver.resolve(local, remote);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('phase-divergence');
      expect(conflicts[0].resolution).toContain('remote-wins');
      expect(conflicts[0].resolution).toContain('delegate');
    });

    it('should resolve local-wins when local is more advanced', () => {
      const local = [
        makeEvent({
          sequence: 1,
          type: 'phase.transitioned',
          data: { from: 'plan', to: 'review' },
        }),
      ];
      const remote = [
        makeEvent({
          sequence: 1,
          type: 'phase.transitioned',
          data: { from: 'plan', to: 'delegate' },
        }),
      ];

      const conflicts = resolver.resolve(local, remote);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('phase-divergence');
      expect(conflicts[0].resolution).toContain('local-wins');
      expect(conflicts[0].resolution).toContain('review');
    });
  });

  // ─── Task Status ──────────────────────────────────────────────────────

  describe('task status', () => {
    it('should resolve completed wins over in_progress', () => {
      const local = [
        makeEvent({
          sequence: 1,
          type: 'task.completed',
          data: { taskId: 't1' },
        }),
      ];
      const remote = [
        makeEvent({
          sequence: 1,
          type: 'task.progressed',
          data: { taskId: 't1', tddPhase: 'green' },
        }),
      ];

      const conflicts = resolver.resolve(local, remote);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('task-status');
      expect(conflicts[0].resolution).toContain('local-wins');
      expect(conflicts[0].resolution).toContain('completed');
    });

    it('should resolve remote completed wins over local claimed', () => {
      const local = [
        makeEvent({
          sequence: 1,
          type: 'task.claimed',
          data: { taskId: 't1', agentId: 'a1', claimedAt: '2026-02-08T00:00:00Z' },
        }),
      ];
      const remote = [
        makeEvent({
          sequence: 1,
          type: 'task.completed',
          data: { taskId: 't1' },
        }),
      ];

      const conflicts = resolver.resolve(local, remote);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('task-status');
      expect(conflicts[0].resolution).toContain('remote-wins');
    });
  });

  // ─── Concurrent Transitions ───────────────────────────────────────────

  describe('concurrent transitions', () => {
    it('should preserve both events when types differ', () => {
      const local = [
        makeEvent({
          sequence: 1,
          type: 'task.claimed',
          data: { taskId: 't1', agentId: 'a1', claimedAt: '2026-02-08T00:00:00.000Z' },
        }),
      ];
      const remote = [
        makeEvent({
          sequence: 1,
          type: 'phase.transitioned',
          data: { from: 'ideate', to: 'plan' },
        }),
      ];

      const conflicts = resolver.resolve(local, remote);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('concurrent-transition');
      expect(conflicts[0].resolution).toBe('both-preserved');
      expect(conflicts[0].localEvent).toEqual(local[0]);
      expect(conflicts[0].remoteEvent).toEqual(remote[0]);
    });
  });
});
