import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCancel } from '../../workflow/cancel.js';
import { handleInit } from '../../workflow/tools.js';
import type { CompensationResult } from '../../workflow/compensation.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cancel-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Read the raw state JSON from disk, bypassing Zod validation.
 * This preserves non-schema fields that Zod might strip.
 */
async function readRawState(featureId: string): Promise<Record<string, unknown>> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  return JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
}

/**
 * Write the raw state JSON to disk, bypassing Zod validation.
 */
async function writeRawState(
  featureId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

describe('handleCancel', () => {
  describe('compensation checkpoint persistence', () => {
    it('should persist compensation checkpoint on partial failure', async () => {
      // Arrange: create a workflow in delegate phase
      await handleInit({ featureId: 'ckpt-partial', workflowType: 'feature' }, tmpDir);

      // Advance to delegate phase by writing raw state
      const rawState = await readRawState('ckpt-partial');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      await writeRawState('ckpt-partial', rawState);

      // Mock executeCompensation to simulate partial failure
      const compensationModule = await import('../../workflow/compensation.js');
      const mockResult: CompensationResult = {
        actions: [
          { actionId: 'synthesize:close-pr', status: 'skipped', message: 'No PR to close' },
          { actionId: 'delegate:delete-integration-branch', status: 'executed', message: 'Deleted branch' },
          { actionId: 'delegate:cleanup-worktrees', status: 'failed', message: 'Failed to clean up' },
        ],
        events: [],
        success: false,
        errorCode: 'COMPENSATION_PARTIAL',
        checkpoint: {
          completedActions: [
            'synthesize:close-pr',
            'delegate:delete-integration-branch',
          ],
        },
      };
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue(mockResult);

      // Act
      const result = await handleCancel({ featureId: 'ckpt-partial' }, tmpDir);

      // Assert: cancel should report partial failure
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMPENSATION_PARTIAL');

      // Assert: state file should contain _compensationCheckpoint
      const stateAfter = await readRawState('ckpt-partial');
      expect(stateAfter._compensationCheckpoint).toBeDefined();
      const checkpoint = stateAfter._compensationCheckpoint as { completedActions: string[] };
      expect(checkpoint.completedActions).toContain('synthesize:close-pr');
      expect(checkpoint.completedActions).toContain('delegate:delete-integration-branch');
    });

    it('should pass existing checkpoint to compensation on retry', async () => {
      // Arrange: create a workflow with an existing _compensationCheckpoint
      await handleInit({ featureId: 'ckpt-retry', workflowType: 'feature' }, tmpDir);

      const rawState = await readRawState('ckpt-retry');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._compensationCheckpoint = {
        completedActions: ['synthesize:close-pr', 'delegate:delete-integration-branch'],
      };
      await writeRawState('ckpt-retry', rawState);

      // Mock executeCompensation to capture the checkpoint parameter
      const compensationModule = await import('../../workflow/compensation.js');
      let capturedOptions: unknown = null;
      vi.spyOn(compensationModule, 'executeCompensation').mockImplementation(
        async (_state, _phase, _events, _seq, options) => {
          capturedOptions = options;
          return {
            actions: [
              { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Cleaned up' },
              { actionId: 'delegate:delete-feature-branches', status: 'executed', message: 'Deleted branches' },
            ],
            events: [],
            success: true,
            checkpoint: {
              completedActions: [
                'synthesize:close-pr',
                'delegate:delete-integration-branch',
                'delegate:cleanup-worktrees',
                'delegate:delete-feature-branches',
              ],
            },
          };
        },
      );

      // Act
      await handleCancel({ featureId: 'ckpt-retry' }, tmpDir);

      // Assert: existing checkpoint was passed to executeCompensation
      expect(capturedOptions).toBeDefined();
      const opts = capturedOptions as { checkpoint?: { completedActions: readonly string[] } };
      expect(opts.checkpoint).toBeDefined();
      expect(opts.checkpoint?.completedActions).toContain('synthesize:close-pr');
      expect(opts.checkpoint?.completedActions).toContain('delegate:delete-integration-branch');
    });

    it('should clear checkpoint after successful cancellation', async () => {
      // Arrange: create a workflow with an existing _compensationCheckpoint
      await handleInit({ featureId: 'ckpt-clear', workflowType: 'feature' }, tmpDir);

      const rawState = await readRawState('ckpt-clear');
      rawState.phase = 'delegate';
      rawState._history = { feature: 'delegate' };
      rawState._compensationCheckpoint = {
        completedActions: ['synthesize:close-pr'],
      };
      await writeRawState('ckpt-clear', rawState);

      // Mock executeCompensation to return success
      const compensationModule = await import('../../workflow/compensation.js');
      vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
        actions: [
          { actionId: 'delegate:cleanup-worktrees', status: 'executed', message: 'Done' },
        ],
        events: [],
        success: true,
        checkpoint: {
          completedActions: ['synthesize:close-pr', 'delegate:cleanup-worktrees'],
        },
      });

      // Act
      const result = await handleCancel({ featureId: 'ckpt-clear' }, tmpDir);

      // Assert: cancel should succeed
      expect(result.success).toBe(true);

      // Assert: state file should NOT contain _compensationCheckpoint
      const stateAfter = await readRawState('ckpt-clear');
      expect(stateAfter._compensationCheckpoint).toBeUndefined();
    });
  });
});
