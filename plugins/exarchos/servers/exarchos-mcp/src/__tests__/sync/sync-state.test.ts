import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SyncStateManager } from '../../sync/sync-state.js';

describe('SyncStateManager', () => {
  let tempDir: string;
  let manager: SyncStateManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'sync-state-test-'));
    manager = new SyncStateManager(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── load ───────────────────────────────────────────────────────────────

  describe('load', () => {
    it('should return default state when file does not exist', async () => {
      const state = await manager.load('nonexistent');

      expect(state).toEqual({
        streamId: 'nonexistent',
        localHighWaterMark: 0,
        remoteHighWaterMark: 0,
      });
    });

    it('should load saved state', async () => {
      await manager.save('test-stream', {
        streamId: 'test-stream',
        localHighWaterMark: 5,
        remoteHighWaterMark: 3,
        lastSyncAt: '2026-02-08T00:00:00Z',
        lastSyncResult: 'success',
      });

      const state = await manager.load('test-stream');
      expect(state.localHighWaterMark).toBe(5);
      expect(state.remoteHighWaterMark).toBe(3);
      expect(state.lastSyncAt).toBe('2026-02-08T00:00:00Z');
      expect(state.lastSyncResult).toBe('success');
    });
  });

  // ─── save ───────────────────────────────────────────────────────────────

  describe('save', () => {
    it('should persist state to file', async () => {
      await manager.save('test-stream', {
        streamId: 'test-stream',
        localHighWaterMark: 10,
        remoteHighWaterMark: 7,
      });

      const filePath = path.join(tempDir, 'test-stream.sync.json');
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.localHighWaterMark).toBe(10);
      expect(data.remoteHighWaterMark).toBe(7);
    });

    it('should roundtrip correctly', async () => {
      const original = {
        streamId: 'test-stream',
        localHighWaterMark: 42,
        remoteHighWaterMark: 38,
        lastSyncAt: '2026-02-08T12:00:00Z',
        lastSyncResult: 'partial' as const,
      };

      await manager.save('test-stream', original);
      const loaded = await manager.load('test-stream');
      expect(loaded).toEqual(original);
    });
  });

  // ─── updateLocalHWM ──────────────────────────────────────────────────

  describe('updateLocalHWM', () => {
    it('should update only local high water mark', async () => {
      await manager.save('test-stream', {
        streamId: 'test-stream',
        localHighWaterMark: 5,
        remoteHighWaterMark: 3,
      });

      await manager.updateLocalHWM('test-stream', 10);

      const state = await manager.load('test-stream');
      expect(state.localHighWaterMark).toBe(10);
      expect(state.remoteHighWaterMark).toBe(3);
    });

    it('should create state with default if none exists', async () => {
      await manager.updateLocalHWM('new-stream', 5);

      const state = await manager.load('new-stream');
      expect(state.localHighWaterMark).toBe(5);
      expect(state.remoteHighWaterMark).toBe(0);
    });
  });

  // ─── updateRemoteHWM ─────────────────────────────────────────────────

  describe('updateRemoteHWM', () => {
    it('should update only remote high water mark', async () => {
      await manager.save('test-stream', {
        streamId: 'test-stream',
        localHighWaterMark: 5,
        remoteHighWaterMark: 3,
      });

      await manager.updateRemoteHWM('test-stream', 8);

      const state = await manager.load('test-stream');
      expect(state.localHighWaterMark).toBe(5);
      expect(state.remoteHighWaterMark).toBe(8);
    });

    it('should create state with default if none exists', async () => {
      await manager.updateRemoteHWM('new-stream', 7);

      const state = await manager.load('new-stream');
      expect(state.localHighWaterMark).toBe(0);
      expect(state.remoteHighWaterMark).toBe(7);
    });
  });
});
