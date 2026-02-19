import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./tools.js', () => ({
  handleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'init-result' } }),
  handleGet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'get-result' } }),
  handleSet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'set-result' } }),
}));

vi.mock('./cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: { phase: 'cancel-result' } }),
}));

import { handleWorkflow } from './composite.js';
import { handleInit, handleGet, handleSet } from './tools.js';
import { handleCancel } from './cancel.js';

describe('handleWorkflow', () => {
  const stateDir = '/tmp/test-state';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('init action', () => {
    it('should delegate to handleInit with correct args', async () => {
      const args = { action: 'init', featureId: 'test', workflowType: 'feature' };

      const result = await handleWorkflow(args, stateDir);

      expect(handleInit).toHaveBeenCalledWith(
        { featureId: 'test', workflowType: 'feature' },
        stateDir,
      );
      expect(result).toEqual({ success: true, data: { phase: 'init-result' } });
    });
  });

  describe('get action', () => {
    it('should delegate to handleGet with correct args', async () => {
      const args = { action: 'get', featureId: 'test', query: 'phase' };

      const result = await handleWorkflow(args, stateDir);

      expect(handleGet).toHaveBeenCalledWith(
        { featureId: 'test', query: 'phase' },
        stateDir,
      );
      expect(result).toEqual({ success: true, data: { phase: 'get-result' } });
    });
  });

  describe('set action', () => {
    it('should delegate to handleSet with correct args', async () => {
      const args = { action: 'set', featureId: 'test', phase: 'delegate', updates: { track: 'polish' } };

      const result = await handleWorkflow(args, stateDir);

      expect(handleSet).toHaveBeenCalledWith(
        { featureId: 'test', phase: 'delegate', updates: { track: 'polish' } },
        stateDir,
      );
      expect(result).toEqual({ success: true, data: { phase: 'set-result' } });
    });
  });

  describe('cancel action', () => {
    it('should delegate to handleCancel with correct args', async () => {
      const args = { action: 'cancel', featureId: 'test', reason: 'no longer needed' };

      const result = await handleWorkflow(args, stateDir);

      expect(handleCancel).toHaveBeenCalledWith(
        { featureId: 'test', reason: 'no longer needed' },
        stateDir,
      );
      expect(result).toEqual({ success: true, data: { phase: 'cancel-result' } });
    });
  });

  describe('unknown action', () => {
    it('should return error for unknown action', async () => {
      const args = { action: 'invalid' };

      const result = await handleWorkflow(args, stateDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('UNKNOWN_ACTION');
      expect(result.error!.message).toContain('invalid');
    });
  });
});
