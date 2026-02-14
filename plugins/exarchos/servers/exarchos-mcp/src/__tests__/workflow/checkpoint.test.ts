import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  incrementOperations,
  isCheckpointAdvised,
  resetCounter,
  isStale,
  getMinutesSinceActivity,
  buildCheckpointMeta,
  createInitialCheckpoint,
  CHECKPOINT_OPERATION_THRESHOLD,
  STALE_AFTER_MINUTES,
} from '../../workflow/checkpoint.js';
import type { CheckpointState } from '../../workflow/types.js';

// Helper to create a checkpoint state at a known time
function makeCheckpoint(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    timestamp: '2025-06-01T12:00:00Z',
    phase: 'ideate',
    summary: 'Test checkpoint',
    operationsSince: 0,
    fixCycleCount: 0,
    lastActivityTimestamp: '2025-06-01T12:00:00Z',
    staleAfterMinutes: 120,
    ...overrides,
  };
}

describe('checkpoint', () => {
  describe('incrementOperations', () => {
    it('IncrementOperations_AfterMutatingCall_CountIncreases', () => {
      const checkpoint = makeCheckpoint({ operationsSince: 5 });

      const result = incrementOperations(checkpoint);

      expect(result.operationsSince).toBe(6);
    });

    it('should not mutate the original object', () => {
      const checkpoint = makeCheckpoint({ operationsSince: 3 });

      const result = incrementOperations(checkpoint);

      expect(checkpoint.operationsSince).toBe(3);
      expect(result.operationsSince).toBe(4);
    });

    it('should preserve all other fields', () => {
      const checkpoint = makeCheckpoint({
        phase: 'delegate',
        summary: 'Delegating tasks',
        fixCycleCount: 2,
      });

      const result = incrementOperations(checkpoint);

      expect(result.phase).toBe('delegate');
      expect(result.summary).toBe('Delegating tasks');
      expect(result.fixCycleCount).toBe(2);
    });

    it('should update lastActivityTimestamp to current time', () => {
      const oldTime = '2025-06-01T12:00:00Z';
      const checkpoint = makeCheckpoint({
        lastActivityTimestamp: oldTime,
      });

      const before = new Date().toISOString();
      const result = incrementOperations(checkpoint);
      const after = new Date().toISOString();

      expect(result.lastActivityTimestamp).not.toBe(oldTime);
      expect(result.lastActivityTimestamp >= before).toBe(true);
      expect(result.lastActivityTimestamp <= after).toBe(true);
    });
  });

  describe('isCheckpointAdvised', () => {
    it('CheckpointAdvisory_AtThreshold_ReturnsTrueInMeta', () => {
      const checkpoint = makeCheckpoint({ operationsSince: 20 });

      expect(isCheckpointAdvised(checkpoint)).toBe(true);
    });

    it('should return false below threshold', () => {
      const checkpoint = makeCheckpoint({ operationsSince: 19 });

      expect(isCheckpointAdvised(checkpoint)).toBe(false);
    });

    it('should return true above threshold', () => {
      const checkpoint = makeCheckpoint({ operationsSince: 25 });

      expect(isCheckpointAdvised(checkpoint)).toBe(true);
    });

    it('should return false at zero operations', () => {
      const checkpoint = makeCheckpoint({ operationsSince: 0 });

      expect(isCheckpointAdvised(checkpoint)).toBe(false);
    });
  });

  describe('resetCounter', () => {
    it('ResetCounter_OnPhaseTransition_CountResetsToZero', () => {
      const checkpoint = makeCheckpoint({
        operationsSince: 15,
        phase: 'ideate',
      });

      const result = resetCounter(checkpoint, 'plan');

      expect(result.operationsSince).toBe(0);
      expect(result.phase).toBe('plan');
    });

    it('ResetCounter_OnExplicitCheckpoint_CountResetsToZero', () => {
      const checkpoint = makeCheckpoint({
        operationsSince: 18,
        phase: 'delegate',
      });

      const result = resetCounter(checkpoint, 'delegate', 'Mid-delegation checkpoint');

      expect(result.operationsSince).toBe(0);
      expect(result.phase).toBe('delegate');
      expect(result.summary).toBe('Mid-delegation checkpoint');
    });

    it('should update the timestamp on reset', () => {
      const checkpoint = makeCheckpoint({
        timestamp: '2025-06-01T12:00:00Z',
      });

      const result = resetCounter(checkpoint, 'plan');

      // Timestamp should be updated (not the original)
      expect(result.timestamp).not.toBe('2025-06-01T12:00:00Z');
    });

    it('should preserve fixCycleCount', () => {
      const checkpoint = makeCheckpoint({ fixCycleCount: 3 });

      const result = resetCounter(checkpoint, 'integrate');

      expect(result.fixCycleCount).toBe(3);
    });

    it('should use default summary when not provided', () => {
      const checkpoint = makeCheckpoint({ summary: 'Old summary' });

      const result = resetCounter(checkpoint, 'review');

      expect(result.summary).toContain('review');
    });

    it('should update lastActivityTimestamp to current time', () => {
      const oldTime = '2025-06-01T12:00:00Z';
      const checkpoint = makeCheckpoint({
        lastActivityTimestamp: oldTime,
      });

      const before = new Date().toISOString();
      const result = resetCounter(checkpoint, 'integrate');
      const after = new Date().toISOString();

      expect(result.lastActivityTimestamp).not.toBe(oldTime);
      expect(result.lastActivityTimestamp >= before).toBe(true);
      expect(result.lastActivityTimestamp <= after).toBe(true);
    });
  });

  describe('isStale', () => {
    it('StalenessDetection_AfterThreshold_ReportsStale', () => {
      // 121 minutes ago
      const pastTime = new Date(Date.now() - 121 * 60 * 1000).toISOString();
      const checkpoint = makeCheckpoint({
        lastActivityTimestamp: pastTime,
        staleAfterMinutes: 120,
      });

      expect(isStale(checkpoint)).toBe(true);
    });

    it('should return false when within threshold', () => {
      const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const checkpoint = makeCheckpoint({
        lastActivityTimestamp: recentTime,
        staleAfterMinutes: 120,
      });

      expect(isStale(checkpoint)).toBe(false);
    });

    it('should return false at exactly the threshold', () => {
      const exactTime = new Date(Date.now() - 120 * 60 * 1000).toISOString();
      const checkpoint = makeCheckpoint({
        lastActivityTimestamp: exactTime,
        staleAfterMinutes: 120,
      });

      // At exactly the threshold, not stale (strictly greater than)
      expect(isStale(checkpoint)).toBe(false);
    });

    it('should respect custom staleAfterMinutes', () => {
      const pastTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      const checkpoint = makeCheckpoint({
        lastActivityTimestamp: pastTime,
        staleAfterMinutes: 30,
      });

      expect(isStale(checkpoint)).toBe(true);
    });
  });

  describe('getMinutesSinceActivity', () => {
    it('should return minutes since last activity', () => {
      const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const checkpoint = makeCheckpoint({
        lastActivityTimestamp: pastTime,
      });

      const minutes = getMinutesSinceActivity(checkpoint);

      // Allow 1 minute tolerance for test execution time
      expect(minutes).toBeGreaterThanOrEqual(59);
      expect(minutes).toBeLessThanOrEqual(61);
    });

    it('should return 0 for very recent activity', () => {
      const now = new Date().toISOString();
      const checkpoint = makeCheckpoint({
        lastActivityTimestamp: now,
      });

      const minutes = getMinutesSinceActivity(checkpoint);

      expect(minutes).toBeLessThanOrEqual(1);
    });
  });

  describe('buildCheckpointMeta', () => {
    it('BuildCheckpointMeta_NoActionNeeded_ReturnsSlim', () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const checkpoint = makeCheckpoint({
        timestamp: '2025-06-01T12:00:00Z',
        phase: 'delegate',
        operationsSince: 10,
        lastActivityTimestamp: recentTime,
        staleAfterMinutes: 120,
      });

      const meta = buildCheckpointMeta(checkpoint);

      // Slim shape: only checkpointAdvised when no action needed
      expect(meta).toEqual({ checkpointAdvised: false });
    });

    it('BuildCheckpointMeta_Advised_ReturnsFullShape', () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const checkpoint = makeCheckpoint({
        timestamp: '2025-06-01T12:00:00Z',
        phase: 'delegate',
        operationsSince: 20,
        lastActivityTimestamp: recentTime,
        staleAfterMinutes: 120,
      });

      const meta = buildCheckpointMeta(checkpoint);

      // Full shape: all fields present when action needed
      expect(meta.checkpointAdvised).toBe(true);
      expect(meta).toHaveProperty('operationsSinceCheckpoint', 20);
      expect(meta).toHaveProperty('lastCheckpointPhase', 'delegate');
      expect(meta).toHaveProperty('lastCheckpointTimestamp', '2025-06-01T12:00:00Z');
      expect(meta).toHaveProperty('stale', false);
      expect(meta).toHaveProperty('minutesSinceActivity');
    });

    it('should report checkpointAdvised when at threshold', () => {
      const recentTime = new Date().toISOString();
      const checkpoint = makeCheckpoint({
        operationsSince: 20,
        lastActivityTimestamp: recentTime,
      });

      const meta = buildCheckpointMeta(checkpoint);

      expect(meta.checkpointAdvised).toBe(true);
    });

    it('should report stale when past threshold', () => {
      const oldTime = new Date(Date.now() - 180 * 60 * 1000).toISOString();
      const checkpoint = makeCheckpoint({
        lastActivityTimestamp: oldTime,
        staleAfterMinutes: 120,
      });

      const meta = buildCheckpointMeta(checkpoint);

      expect(meta.stale).toBe(true);
    });
  });

  describe('createInitialCheckpoint', () => {
    it('should create checkpoint with correct phase', () => {
      const checkpoint = createInitialCheckpoint('ideate');

      expect(checkpoint.phase).toBe('ideate');
    });

    it('should initialize counters to zero', () => {
      const checkpoint = createInitialCheckpoint('triage');

      expect(checkpoint.operationsSince).toBe(0);
      expect(checkpoint.fixCycleCount).toBe(0);
    });

    it('should set timestamps to current time', () => {
      const before = new Date().toISOString();
      const checkpoint = createInitialCheckpoint('explore');
      const after = new Date().toISOString();

      expect(checkpoint.timestamp >= before).toBe(true);
      expect(checkpoint.timestamp <= after).toBe(true);
      expect(checkpoint.lastActivityTimestamp >= before).toBe(true);
      expect(checkpoint.lastActivityTimestamp <= after).toBe(true);
    });

    it('should set default staleAfterMinutes', () => {
      const checkpoint = createInitialCheckpoint('ideate');

      expect(checkpoint.staleAfterMinutes).toBe(STALE_AFTER_MINUTES);
    });

    it('should set initial summary', () => {
      const checkpoint = createInitialCheckpoint('ideate');

      expect(checkpoint.summary).toBeTruthy();
    });
  });

  describe('constants', () => {
    it('should export threshold >= 1', () => {
      expect(CHECKPOINT_OPERATION_THRESHOLD).toBeGreaterThanOrEqual(1);
    });

    it('should export stale minutes >= 1', () => {
      expect(STALE_AFTER_MINUTES).toBeGreaterThanOrEqual(1);
    });
  });
});
