import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';

vi.mock('./tools.js', () => ({
  handleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'init-result' } }),
  handleGet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'get-result' } }),
  handleSet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'set-result' } }),
  handleReconcileState: vi.fn().mockResolvedValue({ success: true, data: { reconciled: true, eventsApplied: 3 } }),
}));

vi.mock('./cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: { phase: 'cancel-result' } }),
}));

import { handleWorkflow } from './composite.js';
import { handleInit, handleGet, handleSet, handleReconcileState } from './tools.js';
import { handleCancel } from './cancel.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

describe('handleWorkflow', () => {
  const stateDir = '/tmp/test-state';
  const ctx = makeCtx(stateDir);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('init action', () => {
    it('should delegate to handleInit with correct args', async () => {
      const args = { action: 'init', featureId: 'test', workflowType: 'feature' };

      const result = await handleWorkflow(args, ctx);

      expect(handleInit).toHaveBeenCalledWith(
        { featureId: 'test', workflowType: 'feature' },
        stateDir,
        ctx.eventStore,
      );
      // T036: successful responses are wrapped in Envelope<T>
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ phase: 'init-result' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('get action', () => {
    it('should delegate to handleGet with correct args', async () => {
      const args = { action: 'get', featureId: 'test', query: 'phase' };

      const result = await handleWorkflow(args, ctx);

      expect(handleGet).toHaveBeenCalledWith(
        { featureId: 'test', query: 'phase' },
        stateDir,
        ctx.eventStore,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ phase: 'get-result' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('set action', () => {
    it('should delegate to handleSet with correct args', async () => {
      const args = { action: 'set', featureId: 'test', phase: 'delegate', updates: { track: 'polish' } };

      const result = await handleWorkflow(args, ctx);

      expect(handleSet).toHaveBeenCalledWith(
        { featureId: 'test', phase: 'delegate', updates: { track: 'polish' } },
        stateDir,
        ctx.eventStore,
        undefined,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ phase: 'set-result' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('cancel action', () => {
    it('should delegate to handleCancel with correct args', async () => {
      const args = { action: 'cancel', featureId: 'test', reason: 'no longer needed' };

      const result = await handleWorkflow(args, ctx);

      expect(handleCancel).toHaveBeenCalledWith(
        { featureId: 'test', reason: 'no longer needed' },
        stateDir,
        ctx.eventStore,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ phase: 'cancel-result' });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('reconcile action', () => {
    it('should delegate to handleReconcileState with correct args', async () => {
      const args = { action: 'reconcile', featureId: 'test' };

      const result = await handleWorkflow(args, ctx);

      expect(handleReconcileState).toHaveBeenCalledWith(
        { featureId: 'test' },
        stateDir,
        ctx.eventStore,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ reconciled: true, eventsApplied: 3 });
      expect((result as Record<string, unknown>).next_actions).toEqual([]);
    });
  });

  describe('unknown action', () => {
    it('should return error for unknown action', async () => {
      const args = { action: 'invalid' };

      const result = await handleWorkflow(args, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('UNKNOWN_ACTION');
      expect(result.error!.message).toContain('invalid');
    });
  });
});
