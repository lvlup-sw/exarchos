import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleReconcileState,
  configureWorkflowEventStore,
} from './tools.js';
import { initStateFile } from './state-store.js';
import { EventStore } from '../event-store/store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-reconcile-state-'));
});

afterEach(async () => {
  configureWorkflowEventStore(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('handleReconcileState', () => {
  describe('Reconcile_WithStaleTaskState_PatchesFromEvents', () => {
    it('should reconcile stale state from events showing phase transition', async () => {
      // Arrange: Create state at 'ideate' phase, then append events that
      // show a transition to 'plan' without updating the state file
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      await initStateFile(tmpDir, 'stale-test', 'feature');

      // Append events: workflow.started + workflow.transition
      await eventStore.append('stale-test', {
        type: 'workflow.started',
        data: { featureId: 'stale-test', workflowType: 'feature' },
      });
      await eventStore.append('stale-test', {
        type: 'workflow.transition',
        data: {
          from: 'ideate',
          to: 'plan',
          trigger: 'execute-transition',
          featureId: 'stale-test',
        },
      });

      // Act
      const result = await handleReconcileState(
        { featureId: 'stale-test' },
        tmpDir,
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        reconciled: true,
        eventsApplied: 2,
      });

      // Verify state file was actually updated
      const stateFile = path.join(tmpDir, 'stale-test.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw.phase).toBe('plan');
    });
  });

  describe('Reconcile_WithEmptyEventStream_ReturnsNoChanges', () => {
    it('should return reconciled:false when no events exist', async () => {
      // Arrange: Create state but append no events
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      await initStateFile(tmpDir, 'empty-test', 'feature');

      // Act
      const result = await handleReconcileState(
        { featureId: 'empty-test' },
        tmpDir,
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        reconciled: false,
        eventsApplied: 0,
      });
    });
  });

  describe('Reconcile_MissingFeatureId_ReturnsError', () => {
    it('should return error when featureId is not provided', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      // Act: call without featureId
      const result = await handleReconcileState(
        {} as { featureId: string },
        tmpDir,
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('INVALID_INPUT');
    });
  });

  describe('Reconcile_NoEventStore_ReturnsError', () => {
    it('should return error when no event store is configured', async () => {
      // Arrange: ensure no event store
      configureWorkflowEventStore(null);

      await initStateFile(tmpDir, 'no-store-test', 'feature');

      // Act
      const result = await handleReconcileState(
        { featureId: 'no-store-test' },
        tmpDir,
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('EVENT_STORE_NOT_CONFIGURED');
    });
  });
});
